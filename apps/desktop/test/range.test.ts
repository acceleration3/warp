import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRange, rangeLength } from '../src/main/range';

const SIZE = 1000;

test('no Range header serves the whole file', () => {
  assert.deepEqual(parseRange(SIZE, null), { kind: 'full' });
  assert.deepEqual(parseRange(SIZE, undefined), { kind: 'full' });
  assert.deepEqual(parseRange(SIZE, ''), { kind: 'full' });
});

test('an open-ended range runs to the last byte', () => {
  // What a player sends once it starts streaming.
  const result = parseRange(SIZE, 'bytes=0-');
  assert.deepEqual(result, { kind: 'partial', range: { start: 0, end: 999 } });
  assert.equal(rangeLength({ start: 0, end: 999 }), SIZE);
});

test('an explicit window is honoured exactly', () => {
  assert.deepEqual(parseRange(SIZE, 'bytes=500-599'), {
    kind: 'partial',
    range: { start: 500, end: 599 },
  });
  assert.equal(rangeLength({ start: 500, end: 599 }), 100, 'the end is inclusive');
});

test('a suffix range takes the final bytes', () => {
  // How MP4 metadata at the end of a file is fetched before playback starts.
  assert.deepEqual(parseRange(SIZE, 'bytes=-200'), {
    kind: 'partial',
    range: { start: 800, end: 999 },
  });
});

test('a suffix longer than the file is clamped to the whole file', () => {
  assert.deepEqual(parseRange(SIZE, 'bytes=-5000'), {
    kind: 'partial',
    range: { start: 0, end: 999 },
  });
});

test('an end past the file is clamped rather than rejected', () => {
  assert.deepEqual(parseRange(SIZE, 'bytes=900-99999'), {
    kind: 'partial',
    range: { start: 900, end: 999 },
  });
});

test('the last single byte is addressable', () => {
  assert.deepEqual(parseRange(SIZE, 'bytes=999-999'), {
    kind: 'partial',
    range: { start: 999, end: 999 },
  });
  assert.equal(rangeLength({ start: 999, end: 999 }), 1);
});

test('a start past the end of the file is unsatisfiable', () => {
  assert.deepEqual(parseRange(SIZE, 'bytes=1000-'), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange(SIZE, 'bytes=5000-6000'), { kind: 'unsatisfiable' });
});

test('a reversed range is unsatisfiable', () => {
  assert.deepEqual(parseRange(SIZE, 'bytes=600-500'), { kind: 'unsatisfiable' });
});

test('malformed headers are rejected rather than guessed at', () => {
  for (const header of ['bytes=', 'bytes=abc-def', 'items=0-10', 'bytes=0-10, 20-30', '0-10']) {
    assert.deepEqual(parseRange(SIZE, header), { kind: 'unsatisfiable' }, header);
  }
});

test('an empty file cannot satisfy any range', () => {
  assert.deepEqual(parseRange(0, 'bytes=0-'), { kind: 'unsatisfiable' });
  assert.deepEqual(parseRange(0, null), { kind: 'full' });
});

test('surrounding whitespace is tolerated', () => {
  assert.deepEqual(parseRange(SIZE, '  bytes=10-20  '), {
    kind: 'partial',
    range: { start: 10, end: 20 },
  });
});
