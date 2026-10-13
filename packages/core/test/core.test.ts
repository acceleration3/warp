import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  sanitizeRelativePath, decodeBeacon, encodeBeacon, type Beacon,
  compileGlobs, matchesAny, globToRegExp,
  RangeSet, planFile,
  defaultTransferSettings, normalizeTransferSettings,
  SelectionModel,
  compileFilter, testEntry, categoryOf, sortEntries,
  defaultFilterRules, defaultSortRules,
  type FsEntry,
} from '../dist/index.js';


function dir(key: string, name = key.slice(key.lastIndexOf('/') + 1)): FsEntry {
  return { id: key, key, name, kind: 'directory', size: 0, mtime: 0, isHidden: name.startsWith('.'), readable: true };
}
function file(key: string, size = 10, mtime = 0): FsEntry {
  const name = key.slice(key.lastIndexOf('/') + 1);
  return { id: key, key, name, kind: 'file', size, mtime, isHidden: name.startsWith('.'), readable: true };
}

test('sanitizeRelativePath rejects traversal and absolute paths', () => {
  assert.equal(sanitizeRelativePath('photos/a.jpg'), 'photos/a.jpg');
  assert.equal(sanitizeRelativePath('/etc/passwd'), 'etc/passwd');
  assert.equal(sanitizeRelativePath('a/../../b'), null);
  assert.equal(sanitizeRelativePath('..'), null);
  assert.equal(sanitizeRelativePath('a\\..\\b'), null);
  assert.equal(sanitizeRelativePath('C:/x'), null, 'colon is illegal in a segment');
  assert.equal(sanitizeRelativePath('con.txt'), null, 'windows reserved name');
  assert.equal(sanitizeRelativePath('a//b/./c.txt'), 'a/b/c.txt');
  assert.equal(sanitizeRelativePath('trailing. '), null);
  assert.equal(sanitizeRelativePath(''), null);
});

test('beacon round-trips and rejects junk', () => {
  const beacon: Beacon = {
    t: 'announce',
    device: { id: 'x', name: 'PC', platform: 'linux', deviceType: 'desktop', port: 47655, protocol: 1 },
  };
  assert.deepEqual(decodeBeacon(encodeBeacon(beacon)), beacon);
  assert.equal(decodeBeacon('not json'), null);
  assert.equal(decodeBeacon('{"t":"announce"}'), null);
  assert.equal(decodeBeacon('{"t":"nope"}'), null);
});

test('glob matching handles globstar, braces and classes', () => {
  assert.match('a/b/c.txt', globToRegExp('**/*.txt'));
  assert.match('c.txt', globToRegExp('**/*.txt'), 'globstar matches zero directories');
  assert.doesNotMatch('a/b/c.md', globToRegExp('**/*.txt'));
  assert.match('src/main.ts', globToRegExp('src/*.{ts,js}'));
  assert.match('img1.png', globToRegExp('img[0-9].png'));
  assert.doesNotMatch('imgx.png', globToRegExp('img[0-9].png'));
  assert.doesNotMatch('a/b.txt', globToRegExp('*.txt'), 'single star does not cross a slash');
});

test('matchesAny falls back to basename for slash-free patterns', () => {
  const globs = compileGlobs(['*.jpg']);
  assert.equal(matchesAny('holiday/beach/sun.jpg', globs), true);
  assert.equal(matchesAny('holiday/beach/sun.png', globs), false);
});

test('matchesAny honours negation', () => {
  const globs = compileGlobs(['**/*.log', '!**/keep.log']);
  assert.equal(matchesAny('var/app.log', globs), true);
  assert.equal(matchesAny('var/keep.log', globs), false);
});

test('RangeSet merges, reports gaps and detects completion', () => {
  const set = new RangeSet();
  set.add(0, 100);
  set.add(200, 300);
  assert.equal(set.size(), 200);
  assert.deepEqual(set.missing(300), [{ start: 100, end: 200 }]);
  assert.equal(set.contiguousPrefix(), 100);
  assert.equal(set.isComplete(300), false);

  set.add(100, 200);
  assert.equal(set.isComplete(300), true);
  assert.deepEqual(set.missing(300), []);
  assert.equal(set.has(50, 250), true);
});

test('RangeSet handles out-of-order and overlapping adds', () => {
  const set = new RangeSet();
  set.add(50, 60);
  set.add(0, 55);
  set.add(59, 70);
  assert.deepEqual(set.toJSON(), [{ start: 0, end: 70 }]);
  assert.equal(set.size(), 70);
});

const MB = 1024 * 1024;

test('planFile splits only large files and covers every byte', () => {
  const settings = { ...defaultTransferSettings(), connectionsPerFile: 4, splitThresholdBytes: MB, chunkSizeBytes: MB };
  const small = planFile({ id: 'a', path: 'a.txt', size: 500 }, settings);
  assert.equal(small.length, 1, 'below threshold stays whole');
  assert.deepEqual(small[0] && [small[0].start, small[0].end], [0, 500]);

  const size = 10 * MB;
  const big = planFile({ id: 'b', path: 'b.bin', size }, settings);
  assert.ok(big.length >= settings.connectionsPerFile, 'enough chunks to keep every connection busy');
  assert.equal(big[0]!.start, 0);
  assert.equal(big[big.length - 1]!.end, size);
  for (let i = 1; i < big.length; i++) {
    assert.equal(big[i]!.start, big[i - 1]!.end, 'chunks are contiguous with no gaps');
  }
  assert.equal(
    big.reduce((sum, t) => sum + (t.end - t.start), 0),
    size,
    'chunks cover the whole file exactly once',
  );
  assert.ok(big.every((t) => t.end - t.start <= settings.chunkSizeBytes), 'no chunk exceeds the configured size');
});

test('planFile still chunks with one connection, so pausing is cheap', () => {
  // Granularity is set by chunk size; connection count only sets parallelism.
  const settings = { ...defaultTransferSettings(), connectionsPerFile: 1, splitThresholdBytes: 1024, chunkSizeBytes: 1024 * 1024 };
  const tasks = planFile({ id: 'b', path: 'b', size: 8 * 1024 * 1024 }, settings);
  assert.equal(tasks.length, 8);
  assert.equal(tasks.reduce((sum, t) => sum + (t.end - t.start), 0), 8 * 1024 * 1024);
});

test('planFile keeps a file at the threshold whole', () => {
  const settings = { ...defaultTransferSettings(), splitThresholdBytes: 4 * MB, chunkSizeBytes: MB };
  assert.equal(planFile({ id: 'c', path: 'c', size: 4 * MB }, settings).length, 1, 'exactly at the threshold');
  assert.ok(planFile({ id: 'c', path: 'c', size: 4 * MB + 1 }, settings).length > 1, 'just over it splits');
});

test('planFile never emits a chunk so small the round-trip dominates', () => {
  const settings = { ...defaultTransferSettings(), connectionsPerFile: 16, splitThresholdBytes: 1024, chunkSizeBytes: MB };
  const tasks = planFile({ id: 'd', path: 'd', size: 100 * 1024 }, settings);
  // 16 connections were asked for, but a 100 KB file is not worth 16 requests.
  assert.ok(tasks.length <= 2, `expected at most 2 chunks, got ${tasks.length}`);
  // Every chunk but the trailing remainder respects the floor.
  for (const task of tasks.slice(0, -1)) {
    assert.ok(task.end - task.start >= 64 * 1024, 'non-final chunks respect the minimum size');
  }
});

test('settings are clamped into their documented range', () => {
  const s = normalizeTransferSettings({ parallelFiles: 999, connectionsPerFile: 0, retries: -5, chunkSizeBytes: 1 });
  assert.equal(s.parallelFiles, 32);
  assert.equal(s.connectionsPerFile, 1);
  assert.equal(s.retries, 0);
  assert.equal(s.chunkSizeBytes, 256 * 1024);
  assert.equal(normalizeTransferSettings(undefined).parallelFiles, 4);
});

test('selection: checking a folder implies its children', () => {
  const model = new SelectionModel();
  model.select(dir('/home/a'));
  assert.equal(model.stateOf(dir('/home/a')), 'checked');
  assert.equal(model.stateOf(file('/home/a/b.txt')), 'checked');
  assert.equal(model.stateOf(file('/home/other.txt')), 'unchecked');
  assert.equal(model.stateOf(dir('/home')), 'partial', 'ancestor shows partial');
});

test('selection: unchecking a child makes the parent partial', () => {
  const model = new SelectionModel();
  model.select(dir('/home/a'));
  model.deselect(file('/home/a/b.txt'));
  assert.equal(model.stateOf(file('/home/a/b.txt')), 'unchecked');
  assert.equal(model.stateOf(dir('/home/a')), 'partial');
  assert.equal(model.stateOf(file('/home/a/c.txt')), 'checked');
  assert.equal(model.exclusions().length, 1);
});

test('selection: re-checking a child clears its exclusion', () => {
  const model = new SelectionModel();
  model.select(dir('/home/a'));
  model.deselect(file('/home/a/b.txt'));
  model.select(file('/home/a/b.txt'));
  assert.equal(model.stateOf(file('/home/a/b.txt')), 'checked');
  assert.equal(model.stateOf(dir('/home/a')), 'checked', 'no exclusions left, so fully checked');
});

test('selection: selecting a parent absorbs redundant child rules', () => {
  const model = new SelectionModel();
  model.select(file('/home/a/b.txt'));
  model.select(dir('/home/a'));
  assert.equal(model.roots().length, 1);
  assert.equal(model.roots()[0]!.key, '/home/a');
});

test('selection: a sibling prefix is not treated as a descendant', () => {
  const model = new SelectionModel();
  model.select(dir('/home/photos'));
  assert.equal(model.stateOf(dir('/home/photos-old')), 'unchecked');
  assert.equal(model.stateOf(file('/home/photos-old/x.jpg')), 'unchecked');
});

test('filter rules drop the right files', () => {
  const filter = compileFilter({ ...defaultFilterRules(), extensions: ['jpg'], minSize: 100 });
  assert.equal(testEntry(file('/a/x.jpg', 500), filter).keep, true);
  assert.equal(testEntry(file('/a/x.png', 500), filter).reason, 'extension');
  assert.equal(testEntry(file('/a/small.jpg', 10), filter).reason, 'size');
  assert.equal(testEntry(file('/a/.hidden.jpg', 500), filter).reason, 'hidden');
});

test('default ignores prune node_modules but keep normal files', () => {
  const filter = compileFilter(defaultFilterRules());
  assert.equal(testEntry(file('/p/node_modules/lib/index.js'), filter, 'node_modules/lib/index.js').keep, false);
  assert.equal(testEntry(file('/p/src/index.js'), filter, 'src/index.js').keep, true);
});

test('directories are exempt from content filters', () => {
  const filter = compileFilter({ ...defaultFilterRules(), extensions: ['jpg'] });
  assert.equal(testEntry(dir('/a/photos'), filter).keep, true, 'a folder must not be pruned by extension');
});

test('category detection', () => {
  assert.equal(categoryOf({ name: 'a.JPG' }), 'image');
  assert.equal(categoryOf({ name: 'a.mkv' }), 'video');
  assert.equal(categoryOf({ name: 'a.apk' }), 'app');
  assert.equal(categoryOf({ name: 'noext' }), 'other');
  assert.equal(categoryOf({ name: 'x', mime: 'audio/mpeg' }), 'audio');
});

test('sorting puts folders first and sorts names naturally', () => {
  const entries = [file('/a/img10.png'), file('/a/img9.png'), dir('/a/zz')];
  const sorted = sortEntries(entries, defaultSortRules());
  assert.deepEqual(sorted.map((e) => e.name), ['zz', 'img9.png', 'img10.png']);
});

test('sorting by size descending', () => {
  const entries = [file('/a/a', 10), file('/a/b', 300), file('/a/c', 50)];
  const sorted = sortEntries(entries, { ...defaultSortRules(), key: 'size', direction: 'desc' });
  assert.deepEqual(sorted.map((e) => e.name), ['b', 'c', 'a']);
});
