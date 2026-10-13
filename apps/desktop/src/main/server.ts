import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  HEADERS,
  RangeSet,
  sanitizeRelativePath,
  type DeviceInfo,
  type OfferedFile,
  type Range,
  type TransferOffer,
  type TransferState,
  type TransferStatus,
} from '@share/core';

/** Receiver-side state for one file inside a transfer. */
interface ReceivingFile {
  offered: OfferedFile;
  /** Sanitized path relative to the transfer destination. */
  relativePath: string;
  absolutePath: string;
  partPath: string;
  ranges: RangeSet;
  fd: fs.promises.FileHandle | null;
  /** In-flight open, so concurrent chunks share one handle. */
  opening: Promise<fs.promises.FileHandle> | null;
  done: boolean;
  removed?: boolean;
  error?: string;
}

export interface IncomingTransfer {
  id: string;
  offer: TransferOffer;
  from: DeviceInfo;
  fromAddress: string;
  state: TransferState;
  token?: string;
  destination?: string;
  files: Map<string, ReceivingFile>;
  bytesReceived: number;
  filesReceived: number;
  /** Receiver-side hold: uploads are refused with 503 until resumed. */
  paused?: boolean;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface ServerOptions {
  self: () => DeviceInfo;
  /** Where accepted transfers are written. */
  downloadDirectory: () => string;
  groupBySender: () => boolean;
  /** Return true to accept without asking the user. */
  autoAccept: (offer: TransferOffer) => boolean;
  port: number;
}

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJsonBody(request: http.IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > limitBytes) throw new Error('offer too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Where a file is written until it is whole. Keyed by transfer and file, so
 * two transfers delivering the same name to the same folder never share (and
 * corrupt) one partial file - a failed transfer keeps its partial for a retry.
 */
function partPathFor(target: string, transferId: string, fileId: string): string {
  const key = crypto.createHash('sha1').update(`${transferId}/${fileId}`).digest('hex').slice(0, 8);
  return `${target}.${key}.part`;
}

/** Picks "name (2).ext" when "name.ext" already exists. */
async function uniquePath(target: string): Promise<string> {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let candidate = target;
  for (let i = 2; ; i++) {
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
}

/**
 * The per-device HTTP server. Everything a peer can do to us goes through here.
 *
 * Uploads are positional writes, so any number of connections may be writing
 * into the same file at once - that is what makes connectionsPerFile > 1 work.
 */
export class TransferServer extends EventEmitter {
  private server: http.Server | null = null;
  private readonly transfers = new Map<string, IncomingTransfer>();
  /**
   * Transfers the user removed while they were still live. A sender that has
   * not noticed yet re-offers them, and that must be refused rather than
   * turned into a brand-new prompt.
   */
  private readonly removed = new Set<string>();
  private actualPort = 0;

  constructor(private readonly options: ServerOptions) {
    super();
  }

  get port(): number {
    return this.actualPort;
  }

  async start(): Promise<number> {
    const server = http.createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) writeJson(response, 500, { error: message });
        else response.destroy();
      });
    });
    // Large folder transfers can idle between chunks; do not guillotine them.
    server.headersTimeout = 60_000;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 30_000;
    this.server = server;

    this.actualPort = await this.listenWithFallback(server, this.options.port);
    return this.actualPort;
  }

  /** Tries the preferred port, then the next few, so two apps can coexist. */
  private listenWithFallback(server: http.Server, preferred: number, attempts = 12): Promise<number> {
    return new Promise((resolve, reject) => {
      let port = preferred;
      let tries = 0;
      const tryListen = (): void => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE' && tries++ < attempts) {
            port++;
            setImmediate(tryListen);
          } else {
            reject(error);
          }
        });
        server.listen(port, '0.0.0.0', () => resolve(port));
      };
      tryListen();
    });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments[0] !== 'api') return writeJson(response, 404, { error: 'not found' });

    // GET /api/info
    if (segments[1] === 'info' && request.method === 'GET') {
      return writeJson(response, 200, { device: this.options.self() });
    }

    // POST /api/offer
    if (segments[1] === 'offer' && request.method === 'POST') {
      return this.handleOffer(request, response);
    }

    // POST /api/text
    if (segments[1] === 'text' && request.method === 'POST') {
      const body = (await readJsonBody(request, 1024 * 1024)) as { text?: string; from?: DeviceInfo };
      if (typeof body?.text === 'string') {
        this.emit('text', { text: body.text, from: body.from, address: request.socket.remoteAddress });
      }
      return writeJson(response, 200, { ok: true });
    }

    // /api/transfer/:id/...
    if (segments[1] === 'transfer' && segments[2]) {
      const transfer = this.transfers.get(decodeURIComponent(segments[2]));
      if (!transfer) return writeJson(response, 404, { error: 'unknown transfer' });

      if (segments[3] === 'status' && request.method === 'GET') {
        return writeJson(response, 200, this.statusOf(transfer, url.searchParams.has('ranges')));
      }
      if (segments[3] === 'file' && segments[4] && request.method === 'PUT') {
        return this.handleUpload(request, response, transfer, decodeURIComponent(segments[4]));
      }
      if (segments[3] === 'finish' && request.method === 'POST') {
        return this.handleFinish(request, response, transfer);
      }
      if (segments[3] === 'cancel' && request.method === 'POST') {
        this.cancel(transfer.id, 'cancelled by sender');
        return writeJson(response, 200, { ok: true });
      }
    }

    writeJson(response, 404, { error: 'not found' });
  }

  private statusOf(transfer: IncomingTransfer, includeRanges = false): TransferStatus & {
    ranges?: Record<string, Range[]>;
  } {
    const status: TransferStatus & { ranges?: Record<string, Range[]> } = {
      transferId: transfer.id,
      state: transfer.state,
      bytesReceived: transfer.bytesReceived,
      filesReceived: transfer.filesReceived,
    };
    if (transfer.token && (transfer.state === 'accepted' || transfer.state === 'sending')) {
      status.token = transfer.token;
    }
    if (transfer.destination) status.savedTo = transfer.destination;
    if (transfer.paused) (status as { paused?: boolean }).paused = true;
    if (transfer.error) status.error = transfer.error;
    if (includeRanges) {
      status.ranges = {};
      for (const [fileId, file] of transfer.files) status.ranges[fileId] = file.ranges.toJSON();
    }
    return status;
  }

  private async handleOffer(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const offer = (await readJsonBody(request)) as TransferOffer;
    if (!offer?.transferId || !Array.isArray(offer.files) || !offer.from?.id) {
      return writeJson(response, 400, { error: 'malformed offer' });
    }
    if (this.removed.has(offer.transferId)) {
      const refused: TransferStatus = {
        transferId: offer.transferId,
        state: 'cancelled',
        bytesReceived: 0,
        filesReceived: 0,
        error: 'removed on the other device',
      };
      return writeJson(response, 200, refused);
    }
    if (this.transfers.has(offer.transferId)) {
      const existing = this.transfers.get(offer.transferId)!;
      if (existing.state === 'failed' || existing.state === 'cancelled') {
        await this.reopen(existing);
      }
      return writeJson(response, 200, this.statusOf(existing));
    }

    // Reject anything that tries to escape the destination directory.
    const files = new Map<string, ReceivingFile>();
    for (const file of offer.files) {
      const safe = sanitizeRelativePath(file.path);
      if (!safe) return writeJson(response, 400, { error: `unsafe path: ${file.path}` });
      if (!Number.isFinite(file.size) || file.size < 0) {
        return writeJson(response, 400, { error: `bad size for ${file.path}` });
      }
      files.set(file.id, {
        offered: file,
        relativePath: safe,
        absolutePath: '',
        partPath: '',
        ranges: new RangeSet(),
        fd: null,
        opening: null,
        done: false,
      });
    }

    const transfer: IncomingTransfer = {
      id: offer.transferId,
      offer,
      from: offer.from,
      fromAddress: request.socket.remoteAddress ?? '',
      state: 'pending',
      files,
      bytesReceived: 0,
      filesReceived: 0,
      startedAt: Date.now(),
    };
    this.transfers.set(transfer.id, transfer);
    this.emit('offer', transfer);

    if (this.options.autoAccept(offer)) {
      await this.accept(transfer.id);
    }
    writeJson(response, 200, this.statusOf(transfer));
  }

  /**
   * The sender is retrying a transfer that ended badly.
   *
   * A failure keeps its acceptance, destination and every range that landed,
   * so the retry only fills the holes. A cancellation deleted the partial
   * files, so those start over and the offer is put to the user again; files
   * that were already finished stay finished either way.
   */
  private async reopen(transfer: IncomingTransfer): Promise<void> {
    const wasCancelled = transfer.state === 'cancelled';
    transfer.error = undefined;
    transfer.finishedAt = undefined;
    for (const file of transfer.files.values()) {
      file.error = undefined;
      if (wasCancelled && !file.done) file.ranges.clear();
    }
    transfer.bytesReceived = [...transfer.files.values()].reduce((sum, file) => sum + file.ranges.size(), 0);

    if (!wasCancelled) {
      transfer.state = 'accepted';
      this.emit('update', transfer);
      return;
    }
    transfer.state = 'pending';
    transfer.token = undefined;
    this.emit('offer', transfer);
    if (this.options.autoAccept(transfer.offer)) await this.accept(transfer.id);
  }

  /** Called by the UI (or auto-accept) once the human says yes. */
  async accept(transferId: string, destinationOverride?: string): Promise<TransferStatus> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) throw new Error('unknown transfer');
    if (transfer.state !== 'pending') return this.statusOf(transfer);

    const base = destinationOverride ?? this.options.downloadDirectory();
    const folder = this.options.groupBySender()
      ? path.join(base, sanitizeRelativePath(transfer.from.name) ?? 'Shared')
      : base;
    await fsp.mkdir(folder, { recursive: true });

    for (const file of transfer.files.values()) {
      const target = path.resolve(folder, file.relativePath);
      // Belt and braces: the sanitizer already rejected traversal.
      if (!target.startsWith(path.resolve(folder) + path.sep) && target !== path.resolve(folder)) {
        throw new Error(`refusing to write outside the destination: ${file.relativePath}`);
      }
      file.absolutePath = target;
      file.partPath = partPathFor(target, transfer.id, file.offered.id);
    }

    transfer.destination = folder;
    transfer.token = crypto.randomBytes(24).toString('hex');
    transfer.state = 'accepted';
    this.emit('update', transfer);
    return this.statusOf(transfer);
  }

  /** Holds an incoming transfer without losing what has already arrived. */
  pause(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.paused = true;
    this.emit('update', transfer);
  }

  resume(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.paused = false;
    this.emit('update', transfer);
  }

  decline(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.state = 'declined';
    this.emit('update', transfer);
  }

  async cancel(transferId: string, reason: string): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.state = 'cancelled';
    transfer.error = reason;
    await this.closeAll(transfer, true);
    // The partial files are gone, so the ranges describing them must go too.
    for (const file of transfer.files.values()) {
      if (!file.done) file.ranges.clear();
    }
    this.emit('update', transfer);
  }

  /**
   * Opens the part file exactly once per transfer, even when several chunks
   * arrive at the same moment.
   *
   * The mode matters: "a"/"a+" sets O_APPEND, and on POSIX that makes the
   * kernel ignore the offset given to pwrite, so every parallel chunk would
   * pile up at the end of the file. "r+" is required for positional writes.
   */
  private async openFile(file: ReceivingFile): Promise<fs.promises.FileHandle> {
    if (file.fd) return file.fd;
    if (file.opening) return file.opening;

    const opening = (async () => {
      await fsp.mkdir(path.dirname(file.partPath), { recursive: true });
      let handle: fs.promises.FileHandle;
      try {
        handle = await fsp.open(file.partPath, 'r+');
      } catch {
        // Does not exist yet: create it, then reopen for positional writes.
        handle = await fsp.open(file.partPath, 'w+');
      }
      // Exactly the offered size: preallocated so out-of-order chunks land in
      // a file of the right shape, and never longer than the file should be.
      await handle.truncate(file.offered.size).catch(() => {});
      file.fd = handle;
      return handle;
    })();
    file.opening = opening;
    // Settled either way: a failed open (EMFILE, a drive not mounted yet) must
    // not be cached, or every later chunk for this file fails with it.
    opening.then(
      () => {
        if (file.opening === opening) file.opening = null;
      },
      () => {
        if (file.opening === opening) file.opening = null;
      },
    );
    return opening;
  }

  private async handleUpload(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    transfer: IncomingTransfer,
    fileId: string,
  ): Promise<void> {
    if (transfer.state !== 'accepted' && transfer.state !== 'sending') {
      return writeJson(response, 409, { error: `transfer is ${transfer.state}` });
    }
    const token = request.headers[HEADERS.token];
    if (!transfer.token || token !== transfer.token) {
      return writeJson(response, 403, { error: 'bad token' });
    }
    if (transfer.paused) {
      // Tell the sender to hold rather than burn its retry budget.
      response.writeHead(503, { 'retry-after': '2', 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'paused by receiver', paused: true }));
      return;
    }
    const file = transfer.files.get(fileId);
    if (!file) return writeJson(response, 404, { error: 'unknown file' });
    if (file.done || file.removed) {
      // A duplicate of a chunk that already landed (the sender timed out
      // waiting for our reply). Writing it would reopen a finished file.
      request.resume();
      return writeJson(response, 200, { ok: true, received: 0, complete: file.done });
    }

    const start = Number(request.headers[HEADERS.offset] ?? 0);
    if (!Number.isFinite(start) || start < 0 || start > file.offered.size) {
      return writeJson(response, 400, { error: 'bad offset' });
    }

    if (transfer.state === 'accepted') {
      transfer.state = 'sending';
      this.emit('update', transfer);
    }

    const handle = await this.openFile(file);
    let position = start;

    try {
      for await (const chunk of request) {
        const buffer = chunk as Buffer;
        if (position + buffer.length > file.offered.size) {
          throw new Error('chunk exceeds declared file size');
        }
        // Positional write: safe to interleave with other connections on the same fd.
        await handle.write(buffer, 0, buffer.length, position);
        position += buffer.length;
        transfer.bytesReceived += buffer.length;
        this.emitProgressThrottled(transfer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      file.error = message;
      return writeJson(response, 400, { error: message });
    }

    file.ranges.add(start, position);

    if (file.ranges.isComplete(file.offered.size) && !file.done) {
      file.done = true;
      transfer.filesReceived++;
      await this.finalizeFile(file);
      this.emit('update', transfer);
    }

    writeJson(response, 200, {
      ok: true,
      received: position - start,
      complete: file.done,
      ranges: file.ranges.toJSON(),
    });
  }

  /** Closes the handle and drops the .part suffix. */
  private async finalizeFile(file: ReceivingFile): Promise<void> {
    // An empty file never receives a chunk, so nothing has created it yet.
    if (!file.fd && file.offered.size === 0) await this.openFile(file);
    if (file.fd) {
      await file.fd.close();
      file.fd = null;
    }
    const finalPath = await uniquePath(file.absolutePath);
    await fsp.rename(file.partPath, finalPath);
    file.absolutePath = finalPath;
    if (file.offered.mtime) {
      const stamp = new Date(file.offered.mtime);
      await fsp.utimes(finalPath, stamp, stamp).catch(() => {});
    }
  }

  private async handleFinish(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    transfer: IncomingTransfer,
  ): Promise<void> {
    const token = request.headers[HEADERS.token];
    if (!transfer.token || token !== transfer.token) {
      return writeJson(response, 403, { error: 'bad token' });
    }
    // Only a live transfer can be finished. Above all, a cancelled one must
    // stay cancelled: turning it into "failed" would let a retry resume it
    // against partial files that were already deleted.
    if (transfer.state !== 'accepted' && transfer.state !== 'sending') {
      request.resume();
      return writeJson(response, 409, this.statusOf(transfer));
    }

    // The sender may have dropped files from the queue after offering them.
    let dropped: string[] = [];
    try {
      const body = (await readJsonBody(request, 1024 * 1024)) as { removed?: string[] };
      if (Array.isArray(body?.removed)) dropped = body.removed;
    } catch {
      /* finish may legitimately carry no body */
    }
    for (const fileId of dropped) {
      const file = transfer.files.get(fileId);
      if (!file || file.done) continue;
      file.removed = true;
      if (file.fd) {
        await file.fd.close().catch(() => {});
        file.fd = null;
      }
      if (file.partPath) await fsp.rm(file.partPath, { force: true }).catch(() => {});
    }

    const incomplete: string[] = [];
    for (const file of transfer.files.values()) {
      if (file.done || file.removed) continue;
      if (file.ranges.isComplete(file.offered.size)) {
        file.done = true;
        transfer.filesReceived++;
        await this.finalizeFile(file);
      } else {
        incomplete.push(file.relativePath);
      }
    }

    if (incomplete.length > 0) {
      transfer.state = 'failed';
      transfer.error = `${incomplete.length} file(s) incomplete: ${incomplete.slice(0, 3).join(', ')}`;
    } else {
      transfer.state = 'complete';
    }
    transfer.finishedAt = Date.now();
    await this.closeAll(transfer, false);
    this.emit('update', transfer);
    writeJson(response, 200, this.statusOf(transfer));
  }

  private async closeAll(transfer: IncomingTransfer, removePartials: boolean): Promise<void> {
    for (const file of transfer.files.values()) {
      if (file.fd) {
        await file.fd.close().catch(() => {});
        file.fd = null;
      }
      if (removePartials && file.partPath && !file.done) {
        await fsp.rm(file.partPath, { force: true }).catch(() => {});
      }
    }
  }

  private lastProgressEmit = 0;
  private emitProgressThrottled(transfer: IncomingTransfer): void {
    const now = Date.now();
    if (now - this.lastProgressEmit < 120) return;
    this.lastProgressEmit = now;
    this.emit('progress', transfer);
  }

  list(): IncomingTransfer[] {
    return [...this.transfers.values()];
  }

  get(id: string): IncomingTransfer | undefined {
    return this.transfers.get(id);
  }

  forget(id: string): void {
    this.transfers.delete(id);
  }

  /**
   * Removes a transfer from the list. A live one is cancelled first, so its
   * files are closed and its partials deleted, and the sender is refused if
   * it re-offers.
   */
  async remove(id: string): Promise<void> {
    const transfer = this.transfers.get(id);
    if (!transfer) return;
    if (transfer.state === 'pending' || transfer.state === 'accepted' || transfer.state === 'sending') {
      this.removed.add(id);
      await this.cancel(id, 'removed');
    }
    this.transfers.delete(id);
  }

  async stop(): Promise<void> {
    for (const transfer of this.transfers.values()) await this.closeAll(transfer, false);
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
    });
    this.server = null;
  }
}
