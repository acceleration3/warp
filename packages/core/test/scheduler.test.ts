import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TransferScheduler, defaultTransferSettings, type TransferSettings } from '../dist/index.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function settings(overrides: Partial<TransferSettings>): TransferSettings {
  return { ...defaultTransferSettings(), throttleBytesPerSecond: 0, ...overrides };
}

/** Rejects if the scheduler does not return in time, instead of hanging the suite. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`scheduler did not return within ${ms}ms`);
    }),
  ]);
}

test('a chunk retrying on a file that already failed does not hang the transfer', async () => {
  const file = { id: 'f', path: 'f.bin', size: 256 * 1024 };
  const scheduler = new TransferScheduler([file], {
    settings: settings({
      connectionsPerFile: 2,
      splitThresholdBytes: 1024,
      chunkSizeBytes: 128 * 1024,
      retries: 1,
      retryBackoffMs: 0,
    }),
    run: async (task) => {
      // The first chunk burns through its retries at once; the second fails
      // only after that, with its own retry still unspent.
      if (task.index === 1) await sleep(50);
      throw new Error(`chunk ${task.index} failed`);
    },
  });

  const outcome = await within(scheduler.run(), 2_000);
  assert.equal(outcome.failed.length, 1, 'the file is reported failed exactly once');
});

test('dropping a file takes its bytes and count out of the totals', async () => {
  const keep = { id: 'keep', path: 'keep.bin', size: 1000 };
  const drop = { id: 'drop', path: 'drop.bin', size: 1000 };
  const later = { id: 'later', path: 'later.bin', size: 1000 };
  let last: { bytesTransferred: number; totalBytes: number; totalFiles: number; filesCompleted: number } | null = null;
  const done: string[] = [];

  let scheduler!: TransferScheduler;
  scheduler = new TransferScheduler([keep, drop, later], {
    settings: settings({ parallelFiles: 2, connectionsPerFile: 1 }),
    run: async (task, report) => {
      report(task.end - task.start);
      if (task.fileId === 'drop') {
        // Removed while its only chunk is in flight, after counting its bytes.
        scheduler.dropFile('drop');
        // Never planned yet: dropping it must still work.
        assert.equal(scheduler.dropFile('later'), true);
      }
      return task.end - task.start;
    },
    onProgress: (progress) => {
      last = progress;
    },
    onFileDone: (fileId, error) => {
      if (!error) done.push(fileId);
    },
  });

  await within(scheduler.run(), 2_000);
  assert.ok(last);
  assert.equal(last!.totalBytes, 1000);
  assert.equal(last!.bytesTransferred, 1000, 'progress ends at exactly 100%');
  assert.equal(last!.totalFiles, 1);
  assert.equal(last!.filesCompleted, 1);
  assert.deepEqual(done, ['keep'], 'a dropped file is never reported as finished');
});
