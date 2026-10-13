/**
 * Transfer queue.
 *
 * Sits above the scheduler: the scheduler parallelizes *within* one transfer,
 * the queue decides *which* transfers run and how many at a time. Every job can
 * be paused, resumed, cancelled, retried and reordered, and the whole queue can
 * be paused at once.
 */

export type QueueJobState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'complete'
  | 'failed'
  | 'cancelled';

export function isFinishedState(state: QueueJobState): boolean {
  return state === 'complete' || state === 'failed' || state === 'cancelled';
}

/** What the queue needs from whatever actually moves the bytes. */
export interface RunnableTransfer {
  readonly id: string;
  /** Resolves when the transfer finishes; rejects on failure. */
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
  /**
   * Drops a single file from this transfer without cancelling the rest.
   * Optional: a runnable that cannot do it just omits the method.
   */
  removeFile?(fileId: string): boolean;
}

export interface QueueJob {
  id: string;
  state: QueueJobState;
  /** Lower runs first; ties broken by insertion order. */
  priority: number;
  addedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** Automatic retries used so far; a manual retry resets it. */
  attempts: number;
  /** While an automatic retry is waiting out its backoff: when it may start. */
  retryAt?: number;
  runnable: RunnableTransfer;
}

export type QueueEvent =
  | { type: 'added'; job: QueueJob }
  | { type: 'changed'; job: QueueJob }
  | { type: 'removed'; jobId: string }
  | { type: 'drained' };

type Listener = (event: QueueEvent) => void;

export interface TransferQueueOptions {
  /** How many transfers may run at once. */
  maxConcurrent?: number;
  /** Automatically retry a failed job this many times before giving up. */
  autoRetries?: number;
  /**
   * Wait before the first automatic retry, doubled for each one after it.
   * Without it a peer that is simply unreachable burns the whole budget in
   * milliseconds.
   */
  autoRetryDelayMs?: number;
}

const MAX_AUTO_RETRY_DELAY_MS = 60_000;

export class TransferQueue {
  private readonly jobs: QueueJob[] = [];
  private readonly listeners = new Set<Listener>();
  private maxConcurrent: number;
  private autoRetries: number;
  private readonly autoRetryDelayMs: number;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runIds = new Map<string, number>();
  private globallyPaused = false;

  constructor(options: TransferQueueOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
    this.autoRetries = Math.max(0, options.autoRetries ?? 0);
    this.autoRetryDelayMs = Math.max(0, options.autoRetryDelayMs ?? 2_000);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  get paused(): boolean {
    return this.globallyPaused;
  }

  get concurrency(): number {
    return this.maxConcurrent;
  }

  setConcurrency(value: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(value));
    this.pump();
  }

  get retryLimit(): number {
    return this.autoRetries;
  }

  /** Applies to jobs already in the queue as well as new ones. */
  setAutoRetries(value: number): void {
    this.autoRetries = Math.max(0, Math.floor(value));
  }

  list(): QueueJob[] {
    return [...this.jobs];
  }

  get(id: string): QueueJob | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  /** Position in the waiting line, or -1 when not queued. */
  positionOf(id: string): number {
    const waiting = this.orderedQueued();
    return waiting.findIndex((job) => job.id === id);
  }

  /**
   * Adds a transfer. `startPaused` holds it before anything touches the
   * network, which matters because starting a job sends an offer to the peer.
   */
  add(runnable: RunnableTransfer, priority = 0, startPaused = false): QueueJob {
    const job: QueueJob = {
      id: runnable.id,
      state: startPaused ? 'paused' : 'queued',
      priority,
      addedAt: Date.now(),
      attempts: 0,
      runnable,
    };
    this.jobs.push(job);
    this.emit({ type: 'added', job });
    if (!startPaused) this.pump();
    return job;
  }

  private orderedQueued(): QueueJob[] {
    return this.jobs
      .filter((job) => job.state === 'queued')
      .sort((a, b) => a.priority - b.priority || a.addedAt - b.addedAt);
  }

  /** Queued jobs that may start now, i.e. not still backing off. */
  private startable(): QueueJob[] {
    const now = Date.now();
    return this.orderedQueued().filter((job) => !job.retryAt || job.retryAt <= now);
  }

  private clearRetryTimer(job: QueueJob): void {
    const timer = this.retryTimers.get(job.id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(job.id);
    job.retryAt = undefined;
  }

  private runningCount(): number {
    return this.jobs.filter((job) => job.state === 'running').length;
  }

  /** Starts as many queued jobs as the concurrency limit allows. */
  private pump(): void {
    if (this.globallyPaused) return;
    let free = this.maxConcurrent - this.runningCount();
    if (free <= 0) return;

    for (const job of this.startable()) {
      if (free <= 0) break;
      free--;
      this.startJob(job);
    }
  }

  private startJob(job: QueueJob): void {
    this.clearRetryTimer(job);
    if (job.startedAt) {
      // Paused mid-flight and now back at the front of the line: its start()
      // promise is still pending, so hand control back instead of starting over.
      job.state = 'running';
      job.runnable.resume();
      this.emit({ type: 'changed', job });
      return;
    }
    job.state = 'running';
    job.startedAt = Date.now();
    job.error = undefined;
    // Identifies this run. A retry can start a new run while the previous
    // (cancelled) one is still settling; the old one must not touch the job.
    const run = (this.runIds.get(job.id) ?? 0) + 1;
    this.runIds.set(job.id, run);
    const current = (): boolean => this.runIds.get(job.id) === run;
    this.emit({ type: 'changed', job });

    job.runnable
      .start()
      .then(() => {
        if (!current()) return;
        // A job cancelled mid-flight resolves too; do not overwrite its state.
        if (job.state === 'cancelled') return;
        if (job.state === 'paused' || job.state === 'queued') {
          // Paused (or waiting to resume) and it returned without finishing,
          // so resuming has to start it again.
          job.startedAt = undefined;
          return;
        }
        job.state = 'complete';
        job.finishedAt = Date.now();
        this.emit({ type: 'changed', job });
      })
      .catch((error: unknown) => {
        if (!current()) return;
        if (job.state === 'cancelled') return;
        const message = error instanceof Error ? error.message : String(error);
        if (job.state === 'paused') {
          // The user holds it: keep it held, and let resuming start it afresh.
          // Not an automatic retry, so no attempt is spent.
          job.startedAt = undefined;
          job.error = message;
          this.emit({ type: 'changed', job });
          return;
        }
        if (job.attempts < this.autoRetries) {
          const delay = Math.min(MAX_AUTO_RETRY_DELAY_MS, this.autoRetryDelayMs * 2 ** job.attempts);
          job.attempts++;
          job.state = 'queued';
          // The next run is a fresh start(), not a resume.
          job.startedAt = undefined;
          job.error = `retrying after: ${message}`;
          if (delay > 0) {
            job.retryAt = Date.now() + delay;
            this.retryTimers.set(
              job.id,
              setTimeout(() => {
                this.retryTimers.delete(job.id);
                job.retryAt = undefined;
                this.emit({ type: 'changed', job });
                this.pump();
              }, delay),
            );
          }
          this.emit({ type: 'changed', job });
          return;
        }
        job.state = 'failed';
        job.error = message;
        job.finishedAt = Date.now();
        this.emit({ type: 'changed', job });
      })
      .finally(() => {
        this.pump();
        if (!this.jobs.some((j) => j.state === 'running' || j.state === 'queued')) {
          this.emit({ type: 'drained' });
        }
      });
  }

  pause(id: string): void {
    const job = this.get(id);
    if (!job) return;
    if (job.state === 'running') {
      job.runnable.pause();
      job.state = 'paused';
      this.emit({ type: 'changed', job });
      // A paused job still occupies no slot, so let the next one in.
      this.pump();
      return;
    }
    if (job.state === 'queued') {
      // Pausing something not yet started just holds it back.
      this.clearRetryTimer(job);
      job.state = 'paused';
      this.emit({ type: 'changed', job });
    }
  }

  /**
   * Puts a paused job back in line. It still has to wait for a free slot:
   * pausing let the next job in, and resuming must not push the queue past
   * its concurrency limit. A job paused mid-flight picks up where it left off.
   */
  resume(id: string): void {
    const job = this.get(id);
    if (!job || job.state !== 'paused') return;
    job.state = 'queued';
    this.emit({ type: 'changed', job });
    this.pump();
  }

  cancel(id: string): void {
    const job = this.get(id);
    if (!job || isFinishedState(job.state)) return;
    this.clearRetryTimer(job);
    job.state = 'cancelled';
    job.finishedAt = Date.now();
    job.runnable.cancel();
    this.emit({ type: 'changed', job });
    this.pump();
  }

  /** Re-queues a failed or cancelled job. Resume-by-range means little is re-sent. */
  retry(id: string): void {
    const job = this.get(id);
    if (!job || !isFinishedState(job.state)) return;
    this.clearRetryTimer(job);
    job.state = 'queued';
    job.error = undefined;
    job.attempts = 0;
    job.startedAt = undefined;
    job.finishedAt = undefined;
    this.emit({ type: 'changed', job });
    this.pump();
  }

  pauseAll(): void {
    this.globallyPaused = true;
    for (const job of this.jobs) {
      if (job.state === 'running') {
        job.runnable.pause();
        job.state = 'paused';
        this.emit({ type: 'changed', job });
      }
    }
  }

  resumeAll(): void {
    this.globallyPaused = false;
    for (const job of this.jobs) {
      if (job.state === 'paused') {
        job.state = 'queued';
        this.emit({ type: 'changed', job });
      }
    }
    this.pump();
  }

  cancelAll(): void {
    for (const job of this.jobs) {
      if (!isFinishedState(job.state)) this.cancel(job.id);
    }
  }

  /** Moves a queued job to an absolute position in the waiting line. */
  moveTo(id: string, index: number): void {
    const waiting = this.orderedQueued();
    const current = waiting.findIndex((job) => job.id === id);
    if (current === -1) return;
    const [moved] = waiting.splice(current, 1);
    if (!moved) return;
    waiting.splice(Math.max(0, Math.min(index, waiting.length)), 0, moved);
    // Rewrite priorities to match the new order.
    waiting.forEach((job, position) => {
      job.priority = position;
    });
    this.emit({ type: 'changed', job: moved });
  }

  moveUp(id: string): void {
    const position = this.positionOf(id);
    if (position > 0) this.moveTo(id, position - 1);
  }

  moveDown(id: string): void {
    const position = this.positionOf(id);
    if (position !== -1) this.moveTo(id, position + 1);
  }

  /** Sends a job to the front of the line. */
  prioritize(id: string): void {
    this.moveTo(id, 0);
  }

  remove(id: string): void {
    const index = this.jobs.findIndex((job) => job.id === id);
    if (index === -1) return;
    const job = this.jobs[index]!;
    this.clearRetryTimer(job);
    if (!isFinishedState(job.state)) job.runnable.cancel();
    this.jobs.splice(index, 1);
    this.runIds.delete(id);
    this.emit({ type: 'removed', jobId: id });
    this.pump();
  }

  /**
   * Removes one file from a job. Works whether the job is still queued, paused
   * or actively running.
   */
  removeFileFromJob(jobId: string, fileId: string): boolean {
    const job = this.get(jobId);
    if (!job || isFinishedState(job.state)) return false;
    const removed = job.runnable.removeFile?.(fileId) ?? false;
    if (removed) this.emit({ type: 'changed', job });
    return removed;
  }

  /** Removes several finished or cancelled jobs at once. */
  removeMany(ids: readonly string[]): void {
    for (const id of ids) this.remove(id);
  }

  clearFinished(): void {
    for (const job of [...this.jobs]) {
      if (isFinishedState(job.state)) this.remove(job.id);
    }
  }

  stats(): { queued: number; running: number; paused: number; finished: number } {
    let queued = 0;
    let running = 0;
    let paused = 0;
    let finished = 0;
    for (const job of this.jobs) {
      if (job.state === 'queued') queued++;
      else if (job.state === 'running') running++;
      else if (job.state === 'paused') paused++;
      else finished++;
    }
    return { queued, running, paused, finished };
  }
}
