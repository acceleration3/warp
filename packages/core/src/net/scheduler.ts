import type { OfferedFile } from '../protocol.js';
import type { TransferSettings } from '../settings.js';

/**
 * Parallel transfer scheduler.
 *
 * Two independent dials, both user-settable:
 *   parallelFiles      - how many files move at once
 *   connectionsPerFile - how many ranged requests split one large file
 *
 * Total requests in flight is capped at parallelFiles * connectionsPerFile, and
 * that cap can be nudged at runtime by the adaptive controller.
 */

export interface ChunkTask {
  fileId: string;
  path: string;
  /** Byte offset of this chunk within the file. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** 0-based index within the file's chunk list. */
  index: number;
  /** Total chunks for this file, so the receiver knows when it is whole. */
  chunkCount: number;
  fileSize: number;
  attempt: number;
}

export interface ChunkResult {
  task: ChunkTask;
  ok: boolean;
  error?: Error;
  /** Bytes actually transferred (may be < chunk size if the peer already had some). */
  bytes: number;
}

/**
 * Splits one file into the chunks that will be sent.
 *
 * Chunking is deliberately independent of connectionsPerFile: chunk size sets
 * the *granularity* (how finely progress is reported and how little is re-sent
 * after a pause or drop), while connectionsPerFile sets how many of those
 * chunks are in flight at once. A single-connection transfer of a 20 GB file
 * still wants chunks, or pausing it would mean losing hours of work.
 */
export function planFile(file: OfferedFile, settings: TransferSettings): ChunkTask[] {
  const splittable = file.size > settings.splitThresholdBytes && file.size > 0;

  if (!splittable) {
    return [
      {
        fileId: file.id,
        path: file.path,
        start: 0,
        end: file.size,
        index: 0,
        chunkCount: 1,
        fileSize: file.size,
        attempt: 0,
      },
    ];
  }

  // Small enough that every connection gets work, but never bigger than the
  // configured chunk size, and never so small that round-trips dominate.
  const perConnection = Math.ceil(file.size / Math.max(1, settings.connectionsPerFile));
  const chunkSize = Math.max(64 * 1024, Math.min(settings.chunkSizeBytes, perConnection));
  const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));

  const tasks: ChunkTask[] = [];
  for (let index = 0; index < chunkCount; index++) {
    const start = index * chunkSize;
    tasks.push({
      fileId: file.id,
      path: file.path,
      start,
      end: Math.min(file.size, start + chunkSize),
      index,
      chunkCount,
      fileSize: file.size,
      attempt: 0,
    });
  }
  return tasks;
}

/** Token bucket used when the user caps bandwidth. */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private bytesPerSecond: number;

  constructor(bytesPerSecond: number) {
    this.bytesPerSecond = bytesPerSecond;
    this.tokens = bytesPerSecond;
  }

  setRate(bytesPerSecond: number): void {
    this.bytesPerSecond = bytesPerSecond;
    if (bytesPerSecond <= 0) this.tokens = 0;
  }

  get unlimited(): boolean {
    return this.bytesPerSecond <= 0;
  }

  /** Resolves once `bytes` may be sent. */
  async acquire(bytes: number): Promise<void> {
    if (this.unlimited) return;
    for (;;) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      this.lastRefill = now;
      this.tokens = Math.min(this.bytesPerSecond, this.tokens + elapsed * this.bytesPerSecond);
      if (this.tokens >= bytes || this.tokens >= this.bytesPerSecond) {
        this.tokens -= bytes;
        return;
      }
      const deficit = bytes - this.tokens;
      const waitMs = Math.min(1000, Math.max(10, (deficit / this.bytesPerSecond) * 1000));
      await sleep(waitMs);
    }
  }
}

/** Exponentially-smoothed throughput, plus a simple ETA. */
export class SpeedMeter {
  private samples: Array<{ at: number; bytes: number }> = [];
  private smoothed = 0;
  private readonly windowMs: number;

  constructor(windowMs = 5_000) {
    this.windowMs = windowMs;
  }

  record(bytes: number): void {
    const now = Date.now();
    this.samples.push({ at: now, bytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) this.samples.shift();

    const total = this.samples.reduce((sum, s) => sum + s.bytes, 0);
    const span = Math.max(0.25, (now - (this.samples[0]?.at ?? now)) / 1000);
    const instant = total / span;
    this.smoothed = this.smoothed === 0 ? instant : this.smoothed * 0.7 + instant * 0.3;
  }

  get bytesPerSecond(): number {
    // Decay to zero when nothing has moved recently (pause, stall, or finish).
    const last = this.samples[this.samples.length - 1];
    if (last && Date.now() - last.at > this.windowMs) return 0;
    return this.smoothed;
  }

  etaSeconds(remainingBytes: number): number | null {
    const rate = this.bytesPerSecond;
    if (rate <= 0 || remainingBytes <= 0) return null;
    return remainingBytes / rate;
  }

  reset(): void {
    this.samples = [];
    this.smoothed = 0;
  }
}

export interface SchedulerProgress {
  bytesTransferred: number;
  totalBytes: number;
  filesCompleted: number;
  totalFiles: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  /** Requests currently in flight. */
  activeConnections: number;
  activeFiles: string[];
  paused: boolean;
  /** Chunks re-sent after a failed attempt, across the whole transfer. */
  chunkRetries: number;
}

export interface SchedulerOptions {
  settings: TransferSettings;
  signal?: AbortSignal;
  /**
   * Performs one chunk. Must resolve only once the bytes are acknowledged.
   * `report` may be called as bytes go out so progress is not chunk-granular.
   */
  run: (task: ChunkTask, report: (delta: number) => void) => Promise<number>;
  onProgress?: (progress: SchedulerProgress) => void;
  onFileDone?: (fileId: string, error?: Error) => void;
  /** Lets the caller skip ranges the receiver already has (resume). */
  filterTasks?: (fileId: string, tasks: ChunkTask[]) => Promise<ChunkTask[]> | ChunkTask[];
}

interface FileState {
  file: OfferedFile;
  pending: ChunkTask[];
  inFlight: number;
  completed: number;
  chunkCount: number;
  failed?: Error;
  started: boolean;
  planned: boolean;
  /** Removed mid-transfer: nothing it does counts any more. */
  dropped: boolean;
  /** Bytes counted towards progress for this file, so a drop can take them back. */
  bytes: number;
}

export class TransferScheduler {
  private readonly files: FileState[] = [];
  private readonly speed = new SpeedMeter();
  private readonly limiter: RateLimiter;
  private bytesTransferred = 0;
  private filesCompleted = 0;
  private chunkRetries = 0;
  private activeConnections = 0;
  private concurrencyCap: number;
  private readonly hardCap: number;
  private lastAdapt = 0;
  private lastAdaptSpeed = 0;
  private aborted = false;
  private paused = false;
  private wake: (() => void) | null = null;

  readonly totalBytes: number;
  readonly totalFiles: number;

  private readonly options: SchedulerOptions;

  constructor(offered: readonly OfferedFile[], options: SchedulerOptions) {
    this.options = options;
    const settings = options.settings;
    for (const file of offered) {
      this.files.push({
        file,
        pending: [],
        inFlight: 0,
        completed: 0,
        chunkCount: 0,
        started: false,
        planned: false,
        dropped: false,
        bytes: 0,
      });
    }
    this.totalFiles = offered.length;
    this.totalBytes = offered.reduce((sum, f) => sum + f.size, 0);
    this.hardCap = Math.max(1, settings.parallelFiles * settings.connectionsPerFile);
    this.concurrencyCap = this.hardCap;
    this.limiter = new RateLimiter(settings.throttleBytesPerSecond);
  }

  /**
   * Pausing stops new chunks from being launched. Chunks already in flight are
   * allowed to finish, so a pause is clean: the receiver keeps whole ranges and
   * resuming needs no re-send.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.wake?.();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.speed.reset();
    this.wake?.();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Removes one file from a transfer that is already running. Chunks not yet
   * launched are dropped; anything in flight finishes and is simply not
   * counted, and whatever the file had already counted is taken back out of
   * the totals. Returns false when the file is already finished or unknown.
   */
  dropFile(fileId: string): boolean {
    const state = this.files.find((f) => f.file.id === fileId);
    if (!state || state.dropped) return false;
    // Planned with nothing left to send or in flight means it already finished (or failed).
    if (state.planned && state.pending.length === 0 && state.inFlight === 0) return false;
    state.dropped = true;
    // An unplanned file must never be planned now.
    state.planned = true;
    state.pending = [];
    state.failed = new Error('removed from queue');
    this.totalBytesRemoved += state.file.size;
    this.totalFilesRemoved++;
    this.bytesTransferred -= state.bytes;
    state.bytes = 0;
    this.wake?.();
    this.emitProgress();
    return true;
  }

  /** Files removed after the transfer started, so totals stay honest. */
  private totalBytesRemoved = 0;
  private totalFilesRemoved = 0;

  /** Counts bytes for a file, unless it has been dropped. */
  private count(state: FileState, delta: number): void {
    if (state.dropped || delta === 0) return;
    state.bytes += delta;
    this.bytesTransferred += delta;
  }

  /** Live-update the dials without restarting the transfer. */
  updateSettings(settings: Partial<TransferSettings>): void {
    if (settings.throttleBytesPerSecond !== undefined) {
      this.limiter.setRate(settings.throttleBytesPerSecond);
    }
    this.wake?.();
  }

  private get settings(): TransferSettings {
    return this.options.settings;
  }

  private activeFileCount(): number {
    return this.files.filter((f) => f.inFlight > 0).length;
  }

  /** Picks the next chunk that respects both dials, or null if none is runnable now. */
  private nextTask(): { state: FileState; task: ChunkTask } | null {
    if (this.paused) return null;
    if (this.activeConnections >= this.concurrencyCap) return null;
    const activeFiles = this.activeFileCount();

    for (const state of this.files) {
      if (state.failed || state.pending.length === 0) continue;
      if (state.inFlight >= this.settings.connectionsPerFile) continue;
      // Respect parallelFiles: a brand-new file may only start if there is room.
      if (state.inFlight === 0 && activeFiles >= this.settings.parallelFiles) continue;
      const task = state.pending.shift()!;
      return { state, task };
    }
    return null;
  }

  /**
   * Parks the loop until a chunk finishes or the poll interval elapses.
   *
   * Each wait owns its own wake handle and timer. An earlier version read
   * `this.wake` from inside the timeout, which meant a stale timer could clear
   * the *next* wait's handle and resolve an already-settled promise - leaving
   * the current wait with nothing left to wake it, and the transfer stuck at
   * 100% forever.
   */
  private waitForSlot(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Only clear the slot if it is still ours.
        if (this.wake === finish) this.wake = null;
        resolve();
      };

      this.wake = finish;
      timer = setTimeout(finish, timeoutMs);
    });
  }

  private lastEmit = 0;
  /** Progress can fire per socket write; cap it so the UI is not flooded. */
  private emitProgressThrottled(): void {
    const now = Date.now();
    if (now - this.lastEmit < 100) return;
    this.lastEmit = now;
    this.emitProgress();
  }

  private emitProgress(): void {
    this.options.onProgress?.({
      bytesTransferred: this.bytesTransferred,
      totalBytes: Math.max(0, this.totalBytes - this.totalBytesRemoved),
      filesCompleted: this.filesCompleted,
      totalFiles: this.totalFiles - this.totalFilesRemoved,
      bytesPerSecond: this.speed.bytesPerSecond,
      etaSeconds: this.speed.etaSeconds(
        Math.max(0, this.totalBytes - this.totalBytesRemoved - this.bytesTransferred),
      ),
      activeConnections: this.activeConnections,
      activeFiles: this.files.filter((f) => f.inFlight > 0).map((f) => f.file.path),
      paused: this.paused,
      chunkRetries: this.chunkRetries,
    });
  }

  /**
   * AIMD-ish controller: if throughput improved since the last adjustment keep
   * opening connections, if it got materially worse back off. Only runs when
   * the user left adaptive mode on.
   */
  private adapt(): void {
    if (!this.settings.adaptiveConcurrency) return;
    const now = Date.now();
    if (now - this.lastAdapt < 3000) return;
    this.lastAdapt = now;

    const current = this.speed.bytesPerSecond;
    if (this.lastAdaptSpeed === 0) {
      this.lastAdaptSpeed = current;
      return;
    }
    const delta = (current - this.lastAdaptSpeed) / Math.max(1, this.lastAdaptSpeed);
    if (delta < -0.15 && this.concurrencyCap > 1) {
      this.concurrencyCap--;
    } else if (delta > 0.05 && this.concurrencyCap < this.hardCap) {
      this.concurrencyCap++;
    }
    this.lastAdaptSpeed = current;
  }

  async run(): Promise<{ completed: number; failed: Array<{ fileId: string; error: Error }> }> {
    const failed: Array<{ fileId: string; error: Error }> = [];
    const inFlight = new Set<Promise<void>>();

    this.options.signal?.addEventListener('abort', () => {
      this.aborted = true;
      this.wake?.();
    });

    // Plan chunks lazily so resume can consult the receiver first.
    const planIfNeeded = async (state: FileState): Promise<void> => {
      if (state.planned) return;
      let tasks = planFile(state.file, this.settings);
      if (this.options.filterTasks) {
        tasks = await this.options.filterTasks(state.file.id, tasks);
      }
      // Removed while the receiver was being asked what it already holds.
      // (Only marked planned afterwards, so dropFile can still tell this apart
      // from a file that already finished.)
      if (state.dropped) return;
      state.planned = true;
      state.chunkCount = tasks.length;
      state.pending = tasks;
      // Whatever the filter trimmed away is already on the receiver (resume),
      // so it counts as transferred from the start.
      const remaining = tasks.reduce((sum, task) => sum + (task.end - task.start), 0);
      this.count(state, Math.max(0, state.file.size - remaining));
      if (tasks.length === 0) {
        // Already fully present on the receiver.
        this.filesCompleted++;
        this.options.onFileDone?.(state.file.id);
      }
    };

    for (;;) {
      if (this.aborted) break;

      // Plan the next few files ahead of the scheduler.
      const unplanned = this.files.filter((s) => !s.planned).slice(0, this.settings.parallelFiles + 2);
      for (const state of unplanned) await planIfNeeded(state);

      const next = this.nextTask();
      if (!next) {
        if (process.env.WARP_DEBUG) {
          console.log('[sched] idle', {
            inFlight: inFlight.size,
            paused: this.paused,
            pending: this.files.map((f) => f.pending.length),
            planned: this.files.filter((f) => f.planned).length,
            total: this.files.length,
          });
        }
        if (inFlight.size === 0 && !this.paused) {
          // A failed file's leftovers can never run, so they must not keep the loop alive.
          const anyPending = this.files.some((s) => !s.failed && s.pending.length > 0);
          const anyUnplanned = this.files.some((s) => !s.planned);
          if (!anyPending && !anyUnplanned) break;
          if (!anyPending && anyUnplanned) continue;
        }
        // Wait for a slot to free up.
        await this.waitForSlot(100);
        continue;
      }

      const { state, task } = next;
      state.inFlight++;
      state.started = true;
      this.activeConnections++;

      let reported = 0;
      const promise = (async () => {
        try {
          await this.limiter.acquire(task.end - task.start);
          const report = (delta: number): void => {
            if (delta === 0 || state.dropped) return;
            reported += delta;
            this.count(state, delta);
            // Only forward progress counts towards throughput; a rollback after
            // a failed chunk must not be read as negative speed.
            if (delta > 0) this.speed.record(delta);
            this.emitProgressThrottled();
          };
          const bytes = await this.options.run(task, report);
          // Dropped or already failed: this chunk no longer means anything.
          if (state.failed) return;
          // Reconcile: a runner that never reported gets counted here.
          const remainder = bytes - reported;
          this.count(state, remainder);
          if (remainder > 0) this.speed.record(remainder);
          state.completed++;
          if (state.completed >= state.chunkCount && state.pending.length === 0) {
            this.filesCompleted++;
            this.options.onFileDone?.(state.file.id);
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          // Whatever this attempt counted never landed; the retry counts it again.
          this.count(state, -reported);
          reported = 0;
          // Another chunk already failed the file, or it was dropped: nothing to retry or report.
          if (state.failed) return;
          if (task.attempt < this.settings.retries && !this.aborted) {
            this.chunkRetries++;
            const backoff = this.settings.retryBackoffMs * 2 ** task.attempt;
            await sleep(Math.min(backoff, 15_000));
            // The file may have failed or been dropped during the backoff.
            if (!state.failed) state.pending.unshift({ ...task, attempt: task.attempt + 1 });
          } else {
            state.failed = err;
            state.pending = [];
            failed.push({ fileId: state.file.id, error: err });
            this.options.onFileDone?.(state.file.id, err);
          }
        } finally {
          state.inFlight--;
          this.activeConnections--;
          this.adapt();
          this.emitProgress();
          this.wake?.();
        }
      })();

      inFlight.add(promise);
      void promise.finally(() => inFlight.delete(promise));
      this.emitProgress();
    }

    await Promise.allSettled([...inFlight]);
    this.emitProgress();
    return { completed: this.filesCompleted, failed };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
