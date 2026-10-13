import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TransferQueue, type RunnableTransfer } from '../dist/index.js';

/** A controllable stand-in for a real transfer. */
function fakeTransfer(id: string) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const finished = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const events: string[] = [];
  const removedFiles: string[] = [];
  let started = false;

  const runnable: RunnableTransfer = {
    id,
    start() {
      started = true;
      events.push('start');
      return finished;
    },
    pause() {
      events.push('pause');
    },
    resume() {
      events.push('resume');
    },
    cancel() {
      events.push('cancel');
      resolve();
    },
    removeFile(fileId: string) {
      removedFiles.push(fileId);
      return true;
    },
  };
  return { runnable, resolve, reject, events, removedFiles, get started() { return started; } };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test('queue respects the concurrency limit', async () => {
  const queue = new TransferQueue({ maxConcurrent: 2 });
  const a = fakeTransfer('a');
  const b = fakeTransfer('b');
  const c = fakeTransfer('c');
  queue.add(a.runnable);
  queue.add(b.runnable);
  queue.add(c.runnable);

  assert.equal(a.started, true);
  assert.equal(b.started, true);
  assert.equal(c.started, false, 'third job waits for a free slot');
  assert.deepEqual(queue.stats(), { queued: 1, running: 2, paused: 0, finished: 0 });

  a.resolve();
  await tick();
  assert.equal(c.started, true, 'a finished job frees its slot');
  assert.equal(queue.get('a')?.state, 'complete');
});

test('pause holds a running job and lets the next one start', async () => {
  const queue = new TransferQueue({ maxConcurrent: 1 });
  const a = fakeTransfer('a');
  const b = fakeTransfer('b');
  queue.add(a.runnable);
  queue.add(b.runnable);
  assert.equal(b.started, false);

  queue.pause('a');
  assert.equal(queue.get('a')?.state, 'paused');
  assert.deepEqual(a.events, ['start', 'pause']);
  assert.equal(b.started, true, 'pausing frees the slot');

  queue.resume('a');
  assert.equal(queue.get('a')?.state, 'queued', 'b holds the only slot, so a waits');
  assert.deepEqual(a.events, ['start', 'pause']);

  b.resolve();
  await tick();
  assert.equal(queue.get('a')?.state, 'running');
  assert.deepEqual(a.events, ['start', 'pause', 'resume'], 'resumed, not restarted');
});

test('a queued job can be paused before it ever starts', () => {
  const queue = new TransferQueue({ maxConcurrent: 1 });
  const a = fakeTransfer('a');
  const b = fakeTransfer('b');
  queue.add(a.runnable);
  queue.add(b.runnable);

  queue.pause('b');
  assert.equal(queue.get('b')?.state, 'paused');
  assert.deepEqual(b.events, [], 'never started, so nothing to pause on the runnable');

  queue.resume('b');
  assert.equal(queue.get('b')?.state, 'queued', 'goes back to waiting, not running');
});

test('cancel stops a job and does not mark it complete afterwards', async () => {
  const queue = new TransferQueue({ maxConcurrent: 1 });
  const a = fakeTransfer('a');
  queue.add(a.runnable);

  queue.cancel('a');
  await tick();
  assert.equal(queue.get('a')?.state, 'cancelled');
  assert.ok(a.events.includes('cancel'));
});

test('failed jobs surface the error and can be retried', async () => {
  const queue = new TransferQueue({ maxConcurrent: 1 });
  const a = fakeTransfer('a');
  queue.add(a.runnable);

  a.reject(new Error('wifi died'));
  await tick();
  assert.equal(queue.get('a')?.state, 'failed');
  assert.equal(queue.get('a')?.error, 'wifi died');

  queue.retry('a');
  assert.equal(queue.get('a')?.state, 'running');
  assert.equal(queue.get('a')?.attempts, 0);
});

test('auto-retry re-runs a failing job, then gives up', async () => {
  // Fails the first attempt, succeeds on the retry.
  let starts = 0;
  const runnable = {
    id: 'a',
    start: async () => {
      starts++;
      if (starts === 1) throw new Error('flaky');
    },
    pause() {},
    resume() {},
    cancel() {},
  };
  const queue = new TransferQueue({ maxConcurrent: 1, autoRetries: 1, autoRetryDelayMs: 0 });
  queue.add(runnable);
  await tick();
  await tick();
  assert.equal(starts, 2, 'the failure was retried automatically');
  assert.equal(queue.get('a')?.state, 'complete');

  // Now one that always fails: the retry budget runs out and it reports failed.
  let attempts = 0;
  const doomed = {
    id: 'b',
    start: async () => {
      attempts++;
      throw new Error('gone');
    },
    pause() {},
    resume() {},
    cancel() {},
  };
  queue.add(doomed);
  await tick();
  await tick();
  assert.equal(attempts, 2, 'original attempt plus one retry');
  assert.equal(queue.get('b')?.state, 'failed');
  assert.equal(queue.get('b')?.error, 'gone');
});

test('pauseAll and resumeAll hold the whole queue', async () => {
  const queue = new TransferQueue({ maxConcurrent: 2 });
  const a = fakeTransfer('a');
  const b = fakeTransfer('b');
  const c = fakeTransfer('c');
  queue.add(a.runnable);
  queue.add(b.runnable);
  queue.add(c.runnable);

  queue.pauseAll();
  assert.equal(queue.paused, true);
  assert.equal(queue.get('a')?.state, 'paused');
  assert.equal(queue.get('c')?.state, 'queued', 'waiting jobs stay put');
  assert.equal(c.started, false, 'nothing new starts while globally paused');

  queue.resumeAll();
  assert.equal(queue.paused, false);
  assert.equal(queue.get('a')?.state, 'running');
});

test('reordering changes who runs next', () => {
  const queue = new TransferQueue({ maxConcurrent: 1 });
  const a = fakeTransfer('a');
  const b = fakeTransfer('b');
  const c = fakeTransfer('c');
  queue.add(a.runnable);
  queue.add(b.runnable);
  queue.add(c.runnable);

  assert.equal(queue.positionOf('b'), 0);
  assert.equal(queue.positionOf('c'), 1);

  queue.prioritize('c');
  assert.equal(queue.positionOf('c'), 0);
  assert.equal(queue.positionOf('b'), 1);

  queue.moveDown('c');
  assert.equal(queue.positionOf('c'), 1);
  queue.moveUp('c');
  assert.equal(queue.positionOf('c'), 0);
});

test('individual jobs can be removed from the queue', () => {
  const queue = new TransferQueue({ maxConcurrent: 1 });
  const a = fakeTransfer('a');
  const b = fakeTransfer('b');
  queue.add(a.runnable);
  queue.add(b.runnable);

  queue.remove('b');
  assert.equal(queue.get('b'), undefined);
  assert.equal(queue.list().length, 1);

  // Removing a running job cancels it first.
  queue.remove('a');
  assert.ok(a.events.includes('cancel'));
  assert.equal(queue.list().length, 0);
});

test('individual files can be removed from a job', () => {
  const queue = new TransferQueue({ maxConcurrent: 1 });
  const a = fakeTransfer('a');
  queue.add(a.runnable);

  assert.equal(queue.removeFileFromJob('a', 'file-7'), true);
  assert.deepEqual(a.removedFiles, ['file-7']);
  assert.equal(queue.removeFileFromJob('nope', 'file-7'), false);
});

test('clearFinished only removes terminal jobs', async () => {
  const queue = new TransferQueue({ maxConcurrent: 2 });
  const a = fakeTransfer('a');
  const b = fakeTransfer('b');
  queue.add(a.runnable);
  queue.add(b.runnable);

  a.resolve();
  await tick();
  queue.clearFinished();
  assert.equal(queue.get('a'), undefined);
  assert.ok(queue.get('b'), 'the running job survives');
});

test('raising concurrency starts waiting jobs immediately', () => {
  const queue = new TransferQueue({ maxConcurrent: 1 });
  const a = fakeTransfer('a');
  const b = fakeTransfer('b');
  queue.add(a.runnable);
  queue.add(b.runnable);
  assert.equal(b.started, false);

  queue.setConcurrency(3);
  assert.equal(b.started, true);
});

test('auto-retries wait out a backoff, and the limit can change live', async () => {
  let starts = 0;
  const runnable = {
    id: 'a',
    start: async () => {
      starts++;
      throw new Error('unreachable');
    },
    pause() {},
    resume() {},
    cancel() {},
  };
  const queue = new TransferQueue({ maxConcurrent: 1, autoRetries: 0, autoRetryDelayMs: 50 });
  queue.setAutoRetries(1);
  queue.add(runnable);
  await tick();
  assert.equal(starts, 1);
  assert.equal(queue.get('a')?.state, 'queued', 'waiting to retry');
  assert.ok(queue.get('a')?.retryAt, 'retry time is exposed');

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(starts, 2, 'retried once the backoff elapsed');
  assert.equal(queue.get('a')?.state, 'failed');
  assert.equal(queue.get('a')?.attempts, 1);
});

test('a paused job whose attempt fails stays paused', async () => {
  const queue = new TransferQueue({ maxConcurrent: 1, autoRetries: 3, autoRetryDelayMs: 0 });
  const a = fakeTransfer('a');
  queue.add(a.runnable);
  queue.pause('a');
  a.reject(new Error('peer went away'));
  await tick();
  assert.equal(queue.get('a')?.state, 'paused', 'the user paused it; a failure must not restart it');
  assert.equal(queue.get('a')?.attempts, 0, 'no automatic retry was spent');
  assert.equal(queue.get('a')?.error, 'peer went away');
});

test('a cancelled run that settles after a retry does not touch the new run', async () => {
  const queue = new TransferQueue({ maxConcurrent: 1 });
  const settles: Array<() => void> = [];
  let starts = 0;
  const runnable = {
    id: 'a',
    start: () => {
      starts++;
      return new Promise<void>((resolve) => settles.push(resolve));
    },
    pause() {},
    resume() {},
    // Like the real sender: cancel does not settle start() straight away.
    cancel() {},
  };
  queue.add(runnable);
  queue.cancel('a');
  queue.retry('a');
  assert.equal(starts, 2);
  assert.equal(queue.get('a')?.state, 'running');

  settles[0]!(); // the cancelled run finally settles
  await tick();
  assert.equal(queue.get('a')?.state, 'running', 'the old run must not mark the new one complete');

  settles[1]!();
  await tick();
  assert.equal(queue.get('a')?.state, 'complete');
});
