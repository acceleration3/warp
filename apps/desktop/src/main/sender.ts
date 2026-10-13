import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Transform, type Readable } from 'node:stream';

import {
  HEADERS,
  HTTP_ROUTES,
  RangeSet,
  TransferQueue,
  TransferScheduler,
  type ChunkTask,
  type DeviceInfo,
  type OfferedFile,
  type Peer,
  type QueueJob,
  type Range,
  type RunnableTransfer,
  type SchedulerProgress,
  type TransferOffer,
  type TransferSettings,
  type TransferState,
  type TransferStatus,
} from '@share/core';

export interface OutgoingFile extends OfferedFile {
  /** Absolute source path on this machine. */
  source: string;
  removed?: boolean;
  transferred: number;
  done?: boolean;
}

export interface OutgoingTransfer {
  id: string;
  peer: Peer;
  files: OutgoingFile[];
  totalBytes: number;
  label: string;
  state: TransferState;
  progress: SchedulerProgress;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  savedTo?: string;
}

/**
 * One keep-alive agent per transfer. maxSockets has to exceed the configured
 * concurrency or Node will silently queue our "parallel" requests.
 */
function makeAgent(maxSockets: number): http.Agent {
  return new http.Agent({
    keepAlive: true,
    maxSockets: Math.max(4, maxSockets + 2),
    maxFreeSockets: 4,
  });
}

interface RequestOptions {
  method: string;
  host: string;
  port: number;
  route: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  stream?: NodeJS.ReadableStream;
  agent?: http.Agent;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function request(options: RequestOptions): Promise<{ status: number; body: string }> {
  return new Promise((resolveRaw, rejectRaw) => {
    /**
     * A body stream that did not run to its end (the request failed, or the
     * peer answered before reading it all) is destroyed, so the file handle
     * behind it is released instead of leaking one fd per failed chunk.
     */
    const releaseBody = (): void => {
      const body = options.stream as Readable | undefined;
      if (body && !body.readableEnded) body.destroy();
    };
    const resolve = (value: { status: number; body: string }): void => {
      releaseBody();
      resolveRaw(value);
    };
    const reject = (error: unknown): void => {
      releaseBody();
      rejectRaw(error);
    };
    const req = http.request(
      {
        method: options.method,
        host: options.host,
        port: options.port,
        path: options.route,
        headers: options.headers,
        agent: options.agent,
        signal: options.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => req.destroy(new Error('request timed out')));
    }
    if (options.stream) {
      options.stream.on('error', (error: Error) => req.destroy(error));
      options.stream.pipe(req);
    } else {
      req.end(options.body);
    }
  });
}

/** Opt-in tracing: WARP_DEBUG=1 makes the transfer lifecycle visible. */
const debug = process.env.WARP_DEBUG
  ? (...args: unknown[]): void => console.log('[sender]', ...args)
  : (): void => {};

/** A chunk upload that moves no bytes for this long is abandoned and retried. */
const CHUNK_IDLE_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendRequest {
  self: DeviceInfo;
  peer: Peer;
  files: Array<{ absolutePath: string; relativePath: string; size: number; mtime?: number }>;
  label: string;
  settings: TransferSettings;
}

/**
 * A single outgoing transfer, shaped so the queue can drive it: it does not
 * touch the network until start() is called, and pause/resume/cancel/removeFile
 * are all honored mid-flight.
 */
class OutgoingRunner implements RunnableTransfer {
  readonly id: string;
  readonly transfer: OutgoingTransfer;

  private scheduler: TransferScheduler | null = null;
  private controller = new AbortController();
  private pausedBeforeStart = false;
  /** The attempt in progress, if any. */
  private running: Promise<void> | null = null;
  private token: string | null = null;
  private agent: http.Agent | null = null;

  constructor(
    private readonly options: SendRequest,
    private readonly emit: (transfer: OutgoingTransfer) => void,
    private readonly emitProgress: (transfer: OutgoingTransfer) => void,
  ) {
    this.id = crypto.randomUUID();
    const files: OutgoingFile[] = options.files.map((file) => ({
      id: crypto.randomUUID(),
      path: file.relativePath.split(path.sep).join('/'),
      size: file.size,
      mtime: file.mtime,
      source: file.absolutePath,
      transferred: 0,
    }));
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    this.transfer = {
      id: this.id,
      peer: options.peer,
      files,
      totalBytes,
      label: options.label,
      state: 'pending',
      startedAt: Date.now(),
      progress: {
        bytesTransferred: 0,
        totalBytes,
        filesCompleted: 0,
        totalFiles: files.length,
        bytesPerSecond: 0,
        etaSeconds: null,
        activeConnections: 0,
        activeFiles: [],
        paused: false,
        chunkRetries: 0,
      },
    };
  }

  pause(): void {
    if (this.scheduler) this.scheduler.pause();
    else this.pausedBeforeStart = true;
    this.transfer.progress.paused = true;
    this.emit(this.transfer);
  }

  resume(): void {
    this.pausedBeforeStart = false;
    this.scheduler?.resume();
    this.transfer.progress.paused = false;
    this.emit(this.transfer);
  }

  cancel(): void {
    this.controller.abort();
    if (this.transfer.state !== 'complete') {
      this.transfer.state = 'cancelled';
      this.transfer.finishedAt = Date.now();
    }
    this.agent?.destroy();
    this.emit(this.transfer);
    // Best-effort: let the peer clean up its partial files.
    void request({
      method: 'POST',
      host: this.options.peer.address,
      port: this.options.peer.port,
      route: HTTP_ROUTES.cancel(this.id),
      timeoutMs: 5_000,
    }).catch(() => {});
  }

  /** Drops one file. Works before the transfer starts and while it is running. */
  removeFile(fileId: string): boolean {
    const file = this.transfer.files.find((candidate) => candidate.id === fileId);
    if (!file || file.removed || file.done) return false;
    file.removed = true;
    this.transfer.totalBytes -= file.size;
    if (this.scheduler) this.scheduler.dropFile(fileId);
    this.emit(this.transfer);
    return true;
  }

  private activeFiles(): OutgoingFile[] {
    return this.transfer.files.filter((file) => !file.removed);
  }

  /**
   * Runs one attempt. Any failure, including ones before a byte moves (peer
   * unreachable, offer refused), leaves the transfer marked failed with the
   * reason, so the card says what happened and offers to try again.
   */
  async start(): Promise<void> {
    // Every attempt gets its own controller, taken before anything is awaited,
    // so a cancel that lands while the previous attempt winds down reaches
    // this one - and the previous attempt keeps seeing its own abort.
    const controller = new AbortController();
    this.controller = controller;
    // A cancelled attempt can still be finishing (a chunk sleeping out its
    // backoff). Two attempts must never drive this transfer at once.
    const previous = this.running;
    const run = (async () => {
      if (previous) await previous.catch(() => {});
      await this.attempt(controller);
    })();
    this.running = run;
    try {
      await run;
    } catch (error) {
      this.agent?.destroy();
      if (!controller.signal.aborted) {
        this.transfer.state = 'failed';
        this.transfer.error = error instanceof Error ? error.message : String(error);
        this.transfer.finishedAt = Date.now();
        this.emit(this.transfer);
      }
      throw error;
    }
  }

  private async attempt(controller: AbortController): Promise<void> {
    const { peer, settings, self } = this.options;
    const host = peer.address;
    const port = peer.port;
    const files = this.activeFiles();

    if (controller.signal.aborted) throw new Error('cancelled');
    // start() runs again for every retry, so shed what the last attempt left.
    this.scheduler = null;
    this.transfer.state = 'pending';
    this.transfer.error = undefined;
    this.transfer.finishedAt = undefined;
    this.transfer.progress = { ...this.transfer.progress, chunkRetries: 0, activeConnections: 0, bytesPerSecond: 0 };
    this.emit(this.transfer);

    if (files.length === 0) {
      this.transfer.state = 'complete';
      this.transfer.finishedAt = Date.now();
      this.emit(this.transfer);
      return;
    }

    const offer: TransferOffer = {
      transferId: this.id,
      from: self,
      files: files.map(({ source: _s, removed: _r, transferred: _t, done: _d, ...rest }) => rest),
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      label: this.transfer.label,
    };

    const offerResponse = await request({
      method: 'POST',
      host,
      port,
      route: HTTP_ROUTES.offer,
      headers: { 'content-type': 'application/json', [HEADERS.deviceId]: self.id },
      body: JSON.stringify(offer),
      timeoutMs: 15_000,
      signal: controller.signal,
    });
    if (offerResponse.status !== 200) {
      throw new Error(`offer rejected (${offerResponse.status}): ${offerResponse.body.slice(0, 200)}`);
    }

    // Wait for the human on the other end.
    let status = JSON.parse(offerResponse.body) as TransferStatus;
    while (status.state === 'pending') {
      if (controller.signal.aborted) throw new Error('cancelled');
      await sleep(600);
      const polled = await request({
        method: 'GET',
        host,
        port,
        route: HTTP_ROUTES.status(this.id),
        timeoutMs: 10_000,
        signal: controller.signal,
      });
      if (polled.status !== 200) throw new Error(`peer lost the transfer (${polled.status})`);
      status = JSON.parse(polled.body) as TransferStatus;
    }

    if (status.state === 'declined') {
      this.transfer.state = 'declined';
      this.transfer.finishedAt = Date.now();
      this.emit(this.transfer);
      return;
    }
    if (status.state === 'cancelled') {
      // The receiver removed this transfer; retrying cannot change its mind.
      this.transfer.state = 'cancelled';
      this.transfer.error = status.error ?? 'cancelled on the other device';
      this.transfer.finishedAt = Date.now();
      this.emit(this.transfer);
      return;
    }
    if (!status.token) throw new Error('peer accepted without issuing a token');

    this.token = status.token;
    this.transfer.state = 'sending';
    this.transfer.savedTo = status.savedTo;
    this.emit(this.transfer);

    // Resume support: ask what the peer already holds.
    let existingRanges: Record<string, Range[]> = {};
    if (settings.resumeEnabled) {
      try {
        const ranged = await request({
          method: 'GET',
          host,
          port,
          route: `${HTTP_ROUTES.status(this.id)}?ranges=1`,
          timeoutMs: 10_000,
          signal: controller.signal,
        });
        existingRanges = (JSON.parse(ranged.body) as { ranges?: Record<string, Range[]> }).ranges ?? {};
      } catch {
        /* resume is best-effort */
      }
    }

    const agent = makeAgent(settings.parallelFiles * settings.connectionsPerFile);
    this.agent = agent;
    const byId = new Map(this.transfer.files.map((file) => [file.id, file]));
    // Counters are rebuilt from what the receiver confirms, not carried over.
    for (const file of files) file.transferred = 0;

    const scheduler = new TransferScheduler(files, {
      settings,
      signal: controller.signal,
      filterTasks: (fileId, tasks) => {
        const known = RangeSet.fromJSON(existingRanges[fileId]);
        const file = byId.get(fileId);
        if (file && known.size() > 0) file.transferred = known.size();
        if (known.size() === 0) return tasks;
        // Drop chunks the receiver already has, and trim the partial ones.
        const trimmed: ChunkTask[] = [];
        for (const task of tasks) {
          if (known.has(task.start, task.end)) continue;
          for (const gap of known.missing(task.end)) {
            const start = Math.max(task.start, gap.start);
            const end = Math.min(task.end, gap.end);
            if (end > start) trimmed.push({ ...task, start, end });
          }
        }
        return trimmed;
      },
      run: async (task, report) => {
        const file = byId.get(task.fileId);
        if (!file || file.removed) return 0;
        const length = task.end - task.start;
        if (length <= 0) return 0;

        /**
         * Bytes the current attempt has counted, so a failure undoes exactly
         * those. Each attempt gets its own tally: a rejected request's body
         * stream can keep flowing for a moment after the response, and those
         * late bytes must not leak into the next attempt's count.
         */
        let attempt = { counted: 0, live: true };
        const rollback = (): void => {
          attempt.live = false;
          file.transferred -= attempt.counted;
          report(-attempt.counted);
          attempt.counted = 0;
        };

        /**
         * Counting has to happen in a Transform, not in a 'data' listener:
         * attaching 'data' switches the stream to flowing mode immediately, so
         * the first chunks would be emitted before pipe() is wired up and never
         * reach the request body - the receiver would then wait forever for a
         * Content-Length worth of bytes that never arrives.
         */
        const openChunk = (): NodeJS.ReadableStream => {
          const tally = { counted: 0, live: true };
          attempt = tally;
          const source = fs.createReadStream(file.source, {
            start: task.start,
            end: task.end - 1,
            highWaterMark: 512 * 1024,
          });
          const counter = new Transform({
            transform(piece, _encoding, callback) {
              const size = (piece as Buffer).length;
              if (tally.live) {
                tally.counted += size;
                file.transferred += size;
                report(size);
              }
              callback(null, piece);
            },
          });
          source.on('error', (error) => counter.destroy(error));
          // Destroying the counter (see request) must close the file too.
          counter.on('close', () => source.destroy());
          return source.pipe(counter);
        };
        const send = (body: NodeJS.ReadableStream): Promise<{ status: number; body: string }> =>
          request({
            method: 'PUT',
            host,
            port,
            route: HTTP_ROUTES.upload(this.id, task.fileId),
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(length),
              [HEADERS.token]: this.token!,
              [HEADERS.offset]: String(task.start),
              [HEADERS.deviceId]: self.id,
            },
            stream: body,
            agent,
            signal: controller.signal,
            // Idle, not total: a dropped Wi-Fi link otherwise hangs until TCP gives up.
            timeoutMs: CHUNK_IDLE_TIMEOUT_MS,
          });

        let stream = openChunk();
        for (;;) {
          let result: { status: number; body: string };
          try {
            result = await send(stream);
          } catch (error) {
            rollback();
            throw error;
          }
          if (controller.signal.aborted) {
            rollback();
            return 0;
          }
          // 503 means the receiver paused. Wait it out instead of spending a retry.
          if (result.status === 503) {
            rollback();
            await sleep(2_000);
            stream = openChunk();
            continue;
          }
          if (result.status !== 200) {
            rollback();
            throw new Error(`chunk rejected (${result.status}): ${result.body.slice(0, 160)}`);
          }
          return length;
        }
      },
      onProgress: (progress) => {
        this.transfer.progress = progress;
        this.emitProgress(this.transfer);
      },
      onFileDone: (fileId, error) => {
        const file = byId.get(fileId);
        if (file && !error) file.done = true;
      },
    });

    this.scheduler = scheduler;
    if (this.pausedBeforeStart) scheduler.pause();

    debug('scheduler starting', files.length, 'files');
    const outcome = await scheduler.run();
    debug('scheduler returned', JSON.stringify(outcome.failed.map((f) => f.error.message)));

    if (controller.signal.aborted) {
      this.transfer.state = 'cancelled';
      this.transfer.finishedAt = Date.now();
      agent.destroy();
      this.emit(this.transfer);
      return;
    }

    // A paused transfer must not be finalized - the queue will resume it later.
    if (scheduler.isPaused) {
      this.transfer.state = 'sending';
      this.emit(this.transfer);
      return;
    }

    debug('posting finish');
    const removed = this.transfer.files.filter((file) => file.removed).map((file) => file.id);
    const finish = await request({
      method: 'POST',
      host,
      port,
      route: HTTP_ROUTES.finish(this.id),
      headers: { [HEADERS.token]: this.token, 'content-type': 'application/json' },
      body: JSON.stringify({ removed }),
      timeoutMs: 30_000,
    });
    agent.destroy();

    debug('finish replied', finish.status, finish.body.slice(0, 120));
    if (finish.status !== 200) {
      throw new Error(`the other device could not finish the transfer (${finish.status}): ${finish.body.slice(0, 160)}`);
    }
    const finalStatus = JSON.parse(finish.body) as TransferStatus;
    this.transfer.savedTo = finalStatus.savedTo ?? this.transfer.savedTo;
    this.transfer.finishedAt = Date.now();

    // Anything short of an explicit "complete" means the receiver did not finalize.
    if (outcome.failed.length > 0 || finalStatus.state !== 'complete') {
      this.transfer.state = 'failed';
      this.transfer.error =
        finalStatus.error ??
        (outcome.failed.length > 0
          ? `${outcome.failed.length} file(s) failed: ${outcome.failed[0]?.error.message}`
          : `the other device reported "${finalStatus.state}"`);
      this.emit(this.transfer);
      throw new Error(this.transfer.error);
    }

    this.transfer.state = 'complete';
    this.emit(this.transfer);
  }
}

/** Owns every outgoing transfer and the queue that paces them. */
export class TransferSender extends EventEmitter {
  readonly queue: TransferQueue;
  private readonly runners = new Map<string, OutgoingRunner>();

  constructor(settings: TransferSettings) {
    super();
    this.queue = new TransferQueue({
      maxConcurrent: settings.maxConcurrentTransfers,
      autoRetries: settings.queueAutoRetries,
    });
    this.queue.subscribe(() => this.emit('queue'));
  }

  applySettings(settings: TransferSettings): void {
    this.queue.setConcurrency(settings.maxConcurrentTransfers);
    this.queue.setAutoRetries(settings.queueAutoRetries);
  }

  enqueue(options: SendRequest): OutgoingTransfer {
    const runner = new OutgoingRunner(
      options,
      (transfer) => this.emit('update', transfer),
      (transfer) => this.emit('progress', transfer),
    );
    this.runners.set(runner.id, runner);
    // Starting a job sends an offer to the peer, so "do not auto-start" has to
    // be decided before the job is ever pumped.
    this.queue.add(runner, 0, !options.settings.autoStartQueue);
    this.emit('update', runner.transfer);
    return runner.transfer;
  }

  get(id: string): OutgoingTransfer | undefined {
    return this.runners.get(id)?.transfer;
  }

  list(): OutgoingTransfer[] {
    return [...this.runners.values()].map((runner) => runner.transfer);
  }

  jobOf(id: string): QueueJob | undefined {
    return this.queue.get(id);
  }

  forget(id: string): void {
    this.queue.remove(id);
    this.runners.delete(id);
  }

  /** Fire-and-forget clipboard text; never queued. */
  async sendText(self: DeviceInfo, peer: Peer, text: string): Promise<void> {
    await request({
      method: 'POST',
      host: peer.address,
      port: peer.port,
      route: HTTP_ROUTES.text,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, from: self }),
      timeoutMs: 10_000,
    });
  }

  /** Verifies a manually typed address before adding it as a peer. */
  static async probe(host: string, port: number): Promise<DeviceInfo | null> {
    try {
      const response = await request({
        method: 'GET',
        host,
        port,
        route: HTTP_ROUTES.info,
        timeoutMs: 4_000,
      });
      if (response.status !== 200) return null;
      return (JSON.parse(response.body) as { device: DeviceInfo }).device;
    } catch {
      return null;
    }
  }
}
