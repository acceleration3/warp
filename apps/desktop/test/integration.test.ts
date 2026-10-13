/**
 * End-to-end test of the transfer engine: two real HTTP servers, real sockets,
 * real files on disk. No Electron involved.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { defaultTransferSettings, type DeviceInfo, type Peer, type TransferSettings } from '@share/core';

import { TransferServer } from '../src/main/server';
import { TransferSender } from '../src/main/sender';

const DEVICE_A: DeviceInfo = {
  id: 'device-a',
  name: 'Sender',
  platform: 'linux',
  deviceType: 'desktop',
  port: 0,
  protocol: 1,
};

const DEVICE_B: DeviceInfo = {
  id: 'device-b',
  name: 'Receiver',
  platform: 'linux',
  deviceType: 'desktop',
  port: 0,
  protocol: 1,
};

let root: string;
let source: string;
let destination: string;
let server: TransferServer;
let peer: Peer;

/** Deterministic pseudo-random bytes so hashes are comparable. */
function fill(size: number, seed: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  let state = seed;
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buffer[i] = state & 0xff;
  }
  return buffer;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function settings(overrides: Partial<TransferSettings> = {}): TransferSettings {
  return { ...defaultTransferSettings(), ...overrides };
}

async function makeSourceTree(): Promise<Array<{ absolutePath: string; relativePath: string; size: number }>> {
  const files: Array<{ absolutePath: string; relativePath: string; size: number }> = [];
  const add = async (relative: string, size: number, seed: number): Promise<void> => {
    const absolute = path.join(source, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, fill(size, seed));
    files.push({ absolutePath: absolute, relativePath: relative, size });
  };

  await add('notes.txt', 1_024, 1);
  await add('photos/a.jpg', 64_000, 2);
  await add('photos/b.jpg', 128_000, 3);
  await add('photos/nested/deep/c.jpg', 32_000, 4);
  // Large enough to be split across several connections.
  await add('big.bin', 12 * 1024 * 1024, 5);
  return files;
}

/** Waits until the predicate holds or the timeout expires. */
async function waitFor(predicate: () => boolean, timeoutMs = 30_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'share-front-test-'));
  source = path.join(root, 'src');
  destination = path.join(root, 'dest');
  await fsp.mkdir(source, { recursive: true });
  await fsp.mkdir(destination, { recursive: true });

  server = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => destination,
    groupBySender: () => false,
    autoAccept: () => true,
    port: 47700,
  });
  const port = await server.start();
  peer = { ...DEVICE_B, port, address: '127.0.0.1', lastSeen: Date.now() };
});

after(async () => {
  await server.stop();
  await fsp.rm(root, { recursive: true, force: true });
});

test('transfers a folder tree intact with parallel connections', async () => {
  const files = await makeSourceTree();
  const sender = new TransferSender(settings());

  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer,
    files,
    label: 'test batch',
    settings: settings({ parallelFiles: 3, connectionsPerFile: 4, splitThresholdBytes: 1024 * 1024, chunkSizeBytes: 1024 * 1024 }),
  });

  await waitFor(() => sender.get(transfer.id)?.state === 'complete', 60_000, 'transfer to complete');

  const final = sender.get(transfer.id)!;
  assert.equal(final.state, 'complete');
  assert.equal(final.error, undefined);

  // Every file must exist at the right relative path with identical content.
  for (const file of files) {
    const landed = path.join(destination, file.relativePath);
    assert.ok(fs.existsSync(landed), `${file.relativePath} is missing`);
    assert.equal(fs.statSync(landed).size, file.size, `${file.relativePath} has the wrong size`);
    assert.equal(sha256(landed), sha256(file.absolutePath), `${file.relativePath} is corrupted`);
  }

  // No stray .part files left behind.
  const leftovers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.part')) leftovers.push(full);
    }
  };
  walk(destination);
  assert.deepEqual(leftovers, [], 'partial files were not cleaned up');
});

test('splitting a large file across connections still reassembles correctly', async () => {
  const dest2 = path.join(root, 'dest2');
  await fsp.mkdir(dest2, { recursive: true });
  const server2 = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => dest2,
    groupBySender: () => false,
    autoAccept: () => true,
    port: 47710,
  });
  const port2 = await server2.start();
  const peer2: Peer = { ...DEVICE_B, port: port2, address: '127.0.0.1', lastSeen: Date.now() };

  const big = path.join(source, 'huge.bin');
  const size = 20 * 1024 * 1024;
  await fsp.writeFile(big, fill(size, 99));

  const sender = new TransferSender(settings());
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: peer2,
    files: [{ absolutePath: big, relativePath: 'huge.bin', size }],
    label: 'one big file',
    // 8 connections over 2 MB chunks: the file is written out of order.
    settings: settings({ connectionsPerFile: 8, splitThresholdBytes: 1024, chunkSizeBytes: 2 * 1024 * 1024 }),
  });

  await waitFor(() => sender.get(transfer.id)?.state === 'complete', 60_000, 'big file transfer');
  const landed = path.join(dest2, 'huge.bin');
  assert.equal(fs.statSync(landed).size, size);
  assert.equal(sha256(landed), sha256(big), 'out-of-order parallel writes corrupted the file');
  await server2.stop();
});

test('a queued transfer can be paused and resumed to completion', async () => {
  const dest3 = path.join(root, 'dest3');
  await fsp.mkdir(dest3, { recursive: true });
  const server3 = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => dest3,
    groupBySender: () => false,
    autoAccept: () => true,
    port: 47720,
  });
  const port3 = await server3.start();
  const peer3: Peer = { ...DEVICE_B, port: port3, address: '127.0.0.1', lastSeen: Date.now() };

  const file = path.join(source, 'pausable.bin');
  const size = 24 * 1024 * 1024;
  await fsp.writeFile(file, fill(size, 7));

  const sender = new TransferSender(settings());
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: peer3,
    files: [{ absolutePath: file, relativePath: 'pausable.bin', size }],
    label: 'pausable',
    settings: settings({ connectionsPerFile: 1, splitThresholdBytes: 1024, chunkSizeBytes: 512 * 1024, throttleBytesPerSecond: 8 * 1024 * 1024 }),
  });

  // Let it get going, then hold it.
  await waitFor(() => (sender.get(transfer.id)?.progress.bytesTransferred ?? 0) > 512 * 1024, 30_000, 'first bytes');
  sender.queue.pause(transfer.id);
  assert.equal(sender.queue.get(transfer.id)?.state, 'paused');

  const atPause = sender.get(transfer.id)!.progress.bytesTransferred;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const afterWait = sender.get(transfer.id)!.progress.bytesTransferred;
  // In-flight chunks are allowed to land, but nothing new should start.
  assert.ok(afterWait - atPause <= 1024 * 1024, `paused transfer kept sending: ${afterWait - atPause} bytes`);
  assert.notEqual(sender.get(transfer.id)!.state, 'complete');

  sender.queue.resume(transfer.id);
  await waitFor(() => sender.get(transfer.id)?.state === 'complete', 60_000, 'resumed transfer');

  const landed = path.join(dest3, 'pausable.bin');
  assert.equal(sha256(landed), sha256(file), 'pause/resume corrupted the file');
  await server3.stop();
});

test('a file can be removed from a transfer before it is sent', async () => {
  const dest4 = path.join(root, 'dest4');
  await fsp.mkdir(dest4, { recursive: true });
  const server4 = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => dest4,
    groupBySender: () => false,
    autoAccept: () => true,
    port: 47730,
  });
  const port4 = await server4.start();
  const peer4: Peer = { ...DEVICE_B, port: port4, address: '127.0.0.1', lastSeen: Date.now() };

  const keep = path.join(source, 'keep.bin');
  const drop = path.join(source, 'drop.bin');
  await fsp.writeFile(keep, fill(4096, 11));
  await fsp.writeFile(drop, fill(4096, 12));

  const sender = new TransferSender(settings({ autoStartQueue: false }));
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: peer4,
    files: [
      { absolutePath: keep, relativePath: 'keep.bin', size: 4096 },
      { absolutePath: drop, relativePath: 'drop.bin', size: 4096 },
    ],
    label: 'removable',
    settings: settings({ autoStartQueue: false }),
  });

  // Held in the queue, so nothing has been offered yet.
  assert.equal(sender.queue.get(transfer.id)?.state, 'paused');
  const dropId = sender.get(transfer.id)!.files.find((f) => f.path === 'drop.bin')!.id;
  assert.equal(sender.queue.removeFileFromJob(transfer.id, dropId), true);

  sender.queue.resume(transfer.id);
  await waitFor(() => sender.get(transfer.id)?.state === 'complete', 30_000, 'transfer after removal');

  assert.ok(fs.existsSync(path.join(dest4, 'keep.bin')), 'kept file should arrive');
  assert.ok(!fs.existsSync(path.join(dest4, 'drop.bin')), 'removed file must not be sent');
  await server4.stop();
});

test('cancelling a transfer leaves no partial files behind', async () => {
  const dest5 = path.join(root, 'dest5');
  await fsp.mkdir(dest5, { recursive: true });
  const server5 = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => dest5,
    groupBySender: () => false,
    autoAccept: () => true,
    port: 47740,
  });
  const port5 = await server5.start();
  const peer5: Peer = { ...DEVICE_B, port: port5, address: '127.0.0.1', lastSeen: Date.now() };

  const file = path.join(source, 'cancelme.bin');
  const size = 32 * 1024 * 1024;
  await fsp.writeFile(file, fill(size, 21));

  const sender = new TransferSender(settings());
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: peer5,
    files: [{ absolutePath: file, relativePath: 'cancelme.bin', size }],
    label: 'cancel me',
    settings: settings({ connectionsPerFile: 1, splitThresholdBytes: 1024, chunkSizeBytes: 256 * 1024, throttleBytesPerSecond: 4 * 1024 * 1024 }),
  });

  await waitFor(() => (sender.get(transfer.id)?.progress.bytesTransferred ?? 0) > 256 * 1024, 30_000, 'first bytes');
  sender.queue.cancel(transfer.id);

  await waitFor(() => sender.get(transfer.id)?.state === 'cancelled', 15_000, 'cancellation');
  // Give the peer a moment to process the cancel callback.
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.ok(!fs.existsSync(path.join(dest5, 'cancelme.bin')), 'a cancelled file must not appear finished');
  const remaining = fs.existsSync(dest5) ? fs.readdirSync(dest5) : [];
  assert.deepEqual(
    remaining.filter((name) => name.endsWith('.part')),
    [],
    'partial file was not cleaned up after cancel',
  );
  await server5.stop();
});

test('an offer with a traversing path is rejected outright', async () => {
  const dest6 = path.join(root, 'dest6');
  await fsp.mkdir(dest6, { recursive: true });
  const server6 = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => dest6,
    groupBySender: () => false,
    autoAccept: () => true,
    port: 47750,
  });
  const port6 = await server6.start();

  const response = await fetch(`http://127.0.0.1:${port6}/api/offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transferId: 'evil',
      from: DEVICE_A,
      label: 'evil',
      totalBytes: 10,
      files: [{ id: 'f1', path: '../../../../etc/cron.d/pwn', size: 10 }],
    }),
  });

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /unsafe path/);
  await server6.stop();
});

test('uploads without the accept token are refused', async () => {
  const dest7 = path.join(root, 'dest7');
  await fsp.mkdir(dest7, { recursive: true });
  const server7 = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => dest7,
    groupBySender: () => false,
    // Do not auto-accept: the transfer should sit in "pending".
    autoAccept: () => false,
    port: 47760,
  });
  const port7 = await server7.start();

  await fetch(`http://127.0.0.1:${port7}/api/offer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transferId: 'no-token',
      from: DEVICE_A,
      label: 'x',
      totalBytes: 4,
      files: [{ id: 'f1', path: 'x.bin', size: 4 }],
    }),
  });

  const upload = await fetch(`http://127.0.0.1:${port7}/api/transfer/no-token/file/f1`, {
    method: 'PUT',
    headers: { 'x-share-token': 'guessed' },
    body: 'abcd',
  });
  assert.equal(upload.status, 409, 'a pending transfer must not accept bytes');

  await server7.stop();
});

test('a failed transfer retries automatically and only re-sends what is missing', async () => {
  const dest8 = path.join(root, 'dest8');
  await fsp.mkdir(dest8, { recursive: true });
  const server8 = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => dest8,
    groupBySender: () => false,
    autoAccept: () => true,
    port: 47770,
  });
  const port8 = await server8.start();
  const peer8: Peer = { ...DEVICE_B, port: port8, address: '127.0.0.1', lastSeen: Date.now() };

  // Uploads succeed for a while, then the receiver starts refusing them.
  const chunk = 256 * 1024;
  let uploads = 0;
  let recovered = false;
  const internals = server8 as unknown as { handleUpload: (...args: unknown[]) => Promise<void> };
  const realUpload = internals.handleUpload.bind(server8);
  internals.handleUpload = async (...args: unknown[]) => {
    uploads++;
    if (uploads > 8 && !recovered) {
      const [request, response] = args as [NodeJS.ReadableStream, import('node:http').ServerResponse];
      request.resume();
      response.writeHead(500).end('{"error":"disk on fire"}');
      return;
    }
    return realUpload(...args);
  };

  const file = path.join(source, 'retry.bin');
  const size = 4 * 1024 * 1024;
  await fsp.writeFile(file, fill(size, 31));

  const transferSettings = settings({
    connectionsPerFile: 1,
    splitThresholdBytes: 1024,
    chunkSizeBytes: chunk,
    retries: 0,
    queueAutoRetries: 2,
  });
  const sender = new TransferSender(transferSettings);
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: peer8,
    files: [{ absolutePath: file, relativePath: 'retry.bin', size }],
    label: 'retry',
    settings: transferSettings,
  });

  // The first attempt fails and the queue schedules an automatic retry.
  await waitFor(() => (sender.queue.get(transfer.id)?.attempts ?? 0) === 1, 30_000, 'automatic retry');
  assert.equal(sender.queue.get(transfer.id)?.state, 'queued');
  assert.ok(sender.queue.get(transfer.id)?.retryAt, 'retry waits out a backoff');

  // The receiver recovers before the retry fires.
  recovered = true;
  const uploadsBeforeRetry = uploads;
  await waitFor(() => sender.get(transfer.id)?.state === 'complete', 30_000, 'retried transfer');

  const landed = path.join(dest8, 'retry.bin');
  assert.equal(sha256(landed), sha256(file), 'retry corrupted the file');
  const resent = uploads - uploadsBeforeRetry;
  assert.ok(resent < size / chunk, `retry re-sent everything (${resent} chunks)`);
  assert.equal(sender.get(transfer.id)?.progress.bytesTransferred, size, 'progress must end exact');
  await server8.stop();
});

test('a cancelled transfer can be tried again', async () => {
  const dest9 = path.join(root, 'dest9');
  await fsp.mkdir(dest9, { recursive: true });
  const server9 = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => dest9,
    groupBySender: () => false,
    autoAccept: () => true,
    port: 47780,
  });
  const port9 = await server9.start();
  const peer9: Peer = { ...DEVICE_B, port: port9, address: '127.0.0.1', lastSeen: Date.now() };

  const file = path.join(source, 'again.bin');
  const size = 8 * 1024 * 1024;
  await fsp.writeFile(file, fill(size, 41));

  const transferSettings = settings({
    connectionsPerFile: 1,
    splitThresholdBytes: 1024,
    chunkSizeBytes: 256 * 1024,
    throttleBytesPerSecond: 4 * 1024 * 1024,
  });
  const sender = new TransferSender(transferSettings);
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: peer9,
    files: [{ absolutePath: file, relativePath: 'again.bin', size }],
    label: 'again',
    settings: transferSettings,
  });

  await waitFor(() => (sender.get(transfer.id)?.progress.bytesTransferred ?? 0) > 256 * 1024, 30_000, 'first bytes');
  sender.queue.cancel(transfer.id);
  await waitFor(() => server9.get(transfer.id)?.state === 'cancelled', 15_000, 'receiver cancellation');

  sender.queue.retry(transfer.id);
  await waitFor(() => sender.get(transfer.id)?.state === 'complete', 60_000, 'retried transfer');
  assert.equal(sha256(path.join(dest9, 'again.bin')), sha256(file));
  await server9.stop();
});

/** A receiver on its own port and folder, torn down by the caller. */
async function receiver(name: string, port: number): Promise<{ server: TransferServer; peer: Peer; dest: string }> {
  const dest = path.join(root, name);
  await fsp.mkdir(dest, { recursive: true });
  const server = new TransferServer({
    self: () => DEVICE_B,
    downloadDirectory: () => dest,
    groupBySender: () => false,
    autoAccept: () => true,
    port,
  });
  const actual = await server.start();
  return { server, dest, peer: { ...DEVICE_B, port: actual, address: '127.0.0.1', lastSeen: Date.now() } };
}

test('empty files arrive and do not fail the transfer', async () => {
  const { server: rx, peer: p, dest } = await receiver('dest10', 47790);
  const empty = path.join(source, 'empty.txt');
  const full = path.join(source, 'full.txt');
  await fsp.writeFile(empty, '');
  await fsp.writeFile(full, fill(2048, 51));

  const sender = new TransferSender(settings());
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: p,
    files: [
      { absolutePath: empty, relativePath: 'pkg/__init__.py', size: 0 },
      { absolutePath: full, relativePath: 'pkg/full.txt', size: 2048 },
    ],
    label: 'with empty',
    settings: settings(),
  });
  await waitFor(() => ['complete', 'failed'].includes(sender.get(transfer.id)?.state ?? ''), 15_000, 'finish');
  assert.equal(sender.get(transfer.id)?.state, 'complete', sender.get(transfer.id)?.error);
  assert.equal(fs.statSync(path.join(dest, 'pkg/__init__.py')).size, 0);
  assert.ok(!fs.existsSync(path.join(dest, 'pkg/__init__.py.part')));
  await rx.stop();
});

test('a transfer the receiver cancelled is re-sent whole on retry, not resumed over deleted partials', async () => {
  const { server: rx, peer: p, dest } = await receiver('dest11', 47800);
  const file = path.join(source, 'rxcancel.bin');
  const size = 8 * 1024 * 1024;
  await fsp.writeFile(file, fill(size, 61));

  const transferSettings = settings({
    connectionsPerFile: 1,
    splitThresholdBytes: 1024,
    chunkSizeBytes: 256 * 1024,
    throttleBytesPerSecond: 4 * 1024 * 1024,
    retries: 0,
    queueAutoRetries: 0,
  });
  const sender = new TransferSender(transferSettings);
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: p,
    files: [{ absolutePath: file, relativePath: 'rxcancel.bin', size }],
    label: 'rx cancel',
    settings: transferSettings,
  });

  await waitFor(() => (sender.get(transfer.id)?.progress.bytesTransferred ?? 0) > 512 * 1024, 30_000, 'first bytes');
  await rx.cancel(transfer.id, 'cancelled here');
  await waitFor(() => sender.queue.get(transfer.id)?.state === 'failed', 30_000, 'sender notices');
  assert.equal(rx.get(transfer.id)?.state, 'cancelled', 'a late finish must not turn cancelled into failed');

  sender.queue.retry(transfer.id);
  await waitFor(() => sender.get(transfer.id)?.state === 'complete', 60_000, 'retried transfer');
  assert.equal(sha256(path.join(dest, 'rxcancel.bin')), sha256(file), 'retry left holes in the file');
  await rx.stop();
});

test('removing a live incoming transfer cancels it and refuses the re-offer', async () => {
  const { server: rx, peer: p, dest } = await receiver('dest12', 47810);
  const file = path.join(source, 'removeme.bin');
  const size = 8 * 1024 * 1024;
  await fsp.writeFile(file, fill(size, 71));

  const transferSettings = settings({
    connectionsPerFile: 1,
    splitThresholdBytes: 1024,
    chunkSizeBytes: 256 * 1024,
    throttleBytesPerSecond: 4 * 1024 * 1024,
    retries: 0,
    queueAutoRetries: 1,
  });
  const sender = new TransferSender(transferSettings);
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: p,
    files: [{ absolutePath: file, relativePath: 'removeme.bin', size }],
    label: 'remove me',
    settings: transferSettings,
  });

  await waitFor(() => (sender.get(transfer.id)?.progress.bytesTransferred ?? 0) > 512 * 1024, 30_000, 'first bytes');
  await rx.remove(transfer.id);
  assert.equal(rx.get(transfer.id), undefined);
  assert.deepEqual(fs.readdirSync(dest).filter((name) => name.endsWith('.part')), [], 'partial left behind');

  // The automatic retry re-offers; the receiver refuses instead of prompting again.
  await waitFor(() => sender.get(transfer.id)?.state === 'cancelled', 30_000, 'sender sees the removal');
  assert.equal(rx.get(transfer.id), undefined, 'the re-offer must not create a new prompt');
  await rx.stop();
});

test('an unreachable peer marks the transfer failed with a reason', async () => {
  const nobody: Peer = { ...DEVICE_B, port: 1, address: '127.0.0.1', lastSeen: Date.now() };
  const file = path.join(source, 'notes.txt');
  const sender = new TransferSender(settings({ queueAutoRetries: 0 }));
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: nobody,
    files: [{ absolutePath: file, relativePath: 'notes.txt', size: 1024 }],
    label: 'nowhere',
    settings: settings({ queueAutoRetries: 0 }),
  });
  await waitFor(() => sender.queue.get(transfer.id)?.state === 'failed', 15_000, 'failure');
  assert.equal(sender.get(transfer.id)?.state, 'failed');
  assert.ok(sender.get(transfer.id)?.error, 'the card needs a reason to show');
});

/** Makes a receiver refuse uploads while `refuse()` is true, answering before reading the body. */
function refuseUploads(server: TransferServer, refuse: (transferId: string) => boolean): void {
  const internals = server as unknown as { handleUpload: (...args: unknown[]) => Promise<void> };
  const real = internals.handleUpload.bind(server);
  internals.handleUpload = async (...args: unknown[]) => {
    const [request, response, transfer] = args as [
      NodeJS.ReadableStream,
      import('node:http').ServerResponse,
      { id: string },
    ];
    if (refuse(transfer.id)) {
      request.resume();
      response.writeHead(500).end('{"error":"refused"}');
      return;
    }
    return real(...args);
  };
}

test('two transfers of the same name never share a partial file', async () => {
  const { server: rx, peer: p, dest } = await receiver('dest13', 47820);
  const first = path.join(source, 'same-a.bin');
  const second = path.join(source, 'same-b.bin');
  const size = 2 * 1024 * 1024;
  await fsp.writeFile(first, fill(size, 81));
  await fsp.writeFile(second, fill(size, 82));

  // The first transfer lands half its chunks, then fails.
  let firstId = '';
  let firstUploads = 0;
  let recovered = false;
  refuseUploads(rx, (id) => id === firstId && !recovered && ++firstUploads > 4);

  const chunked = settings({ connectionsPerFile: 1, splitThresholdBytes: 1024, chunkSizeBytes: 256 * 1024, retries: 0, queueAutoRetries: 0 });
  const sender = new TransferSender(chunked);
  const a = sender.enqueue({ self: DEVICE_A, peer: p, files: [{ absolutePath: first, relativePath: 'same.bin', size }], label: 'a', settings: chunked });
  firstId = a.id;
  await waitFor(() => sender.queue.get(a.id)?.state === 'failed', 30_000, 'first transfer fails');

  // A different file with the same name completes in the meantime.
  const b = sender.enqueue({ self: DEVICE_A, peer: p, files: [{ absolutePath: second, relativePath: 'same.bin', size }], label: 'b', settings: chunked });
  await waitFor(() => sender.get(b.id)?.state === 'complete', 30_000, 'second transfer');

  // Retrying the first must fill its own partial, not one the second consumed.
  recovered = true;
  sender.queue.retry(a.id);
  await waitFor(() => sender.get(a.id)?.state === 'complete', 30_000, 'first transfer retried');

  const landed = fs.readdirSync(dest).filter((name) => name.startsWith('same')).sort();
  assert.deepEqual(landed, ['same (2).bin', 'same.bin']);
  const hashes = new Set(landed.map((name) => sha256(path.join(dest, name))));
  assert.deepEqual(hashes, new Set([sha256(first), sha256(second)]), 'a file was corrupted');
  await rx.stop();
});

test('a failed open is not cached: the file can still be received', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const { server: rx, peer: p, dest } = await receiver('dest14', 47830);
  const locked = path.join(dest, 'locked');
  await fsp.mkdir(locked);
  await fsp.chmod(locked, 0o555);

  const file = path.join(source, 'locked.bin');
  await fsp.writeFile(file, fill(64 * 1024, 91));
  const patient = settings({ retries: 5, retryBackoffMs: 200 });
  const sender = new TransferSender(patient);
  const transfer = sender.enqueue({
    self: DEVICE_A,
    peer: p,
    files: [{ absolutePath: file, relativePath: 'locked/inner/file.bin', size: 64 * 1024 }],
    label: 'locked',
    settings: patient,
  });

  // The first open fails (EACCES); then the folder becomes writable.
  await waitFor(() => (sender.get(transfer.id)?.progress.chunkRetries ?? 0) > 0, 15_000, 'a failed chunk');
  await fsp.chmod(locked, 0o755);
  await waitFor(() => ['complete', 'failed'].includes(sender.get(transfer.id)?.state ?? ''), 30_000, 'finish');
  assert.equal(sender.get(transfer.id)?.state, 'complete', sender.get(transfer.id)?.error);
  assert.equal(sha256(path.join(locked, 'inner/file.bin')), sha256(file));
  await rx.stop();
});

test('failed chunk uploads do not leak file descriptors', async (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('needs /proc');
  const { server: rx, peer: p } = await receiver('dest15', 47840);
  // Drop the connection mid-upload, the way a dying Wi-Fi link does.
  const internals = rx as unknown as { handleUpload: (...args: unknown[]) => Promise<void> };
  internals.handleUpload = async (...args: unknown[]) => {
    const [request] = args as [import('node:http').IncomingMessage];
    request.socket.destroy();
  };

  const file = path.join(source, 'leaky.bin');
  // Chunks larger than the read-ahead buffer, so a stream is still open when its request dies.
  const size = 32 * 1024 * 1024;
  await fsp.writeFile(file, fill(size, 101));
  const openFds = (): number => fs.readdirSync('/proc/self/fd').length;
  const before = openFds();

  const failing = settings({ connectionsPerFile: 4, splitThresholdBytes: 1024, chunkSizeBytes: 8 * 1024 * 1024, retries: 2, retryBackoffMs: 0, queueAutoRetries: 0 });
  const sender = new TransferSender(failing);
  const transfer = sender.enqueue({ self: DEVICE_A, peer: p, files: [{ absolutePath: file, relativePath: 'leaky.bin', size }], label: 'leaky', settings: failing });
  await waitFor(() => sender.queue.get(transfer.id)?.state === 'failed', 30_000, 'failure');
  await rx.stop();
  // Let destroyed streams finish closing.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const leaked = openFds() - before;
  assert.ok(leaked <= 2, `${leaked} file descriptors leaked`);
});
