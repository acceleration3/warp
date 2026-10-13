import { compileGlobs, couldMatchUnder, matchesAny, type CompiledGlob } from './glob.js';
import {
  DEFAULT_IGNORES,
  type FileCategory,
  type FilterRules,
  type FsEntry,
  type SortRules,
} from './types.js';

const CATEGORY_BY_EXT: Readonly<Record<string, FileCategory>> = {
  // images
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image',
  tiff: 'image', tif: 'image', svg: 'image', heic: 'image', heif: 'image', avif: 'image',
  raw: 'image', cr2: 'image', nef: 'image', arw: 'image', dng: 'image', ico: 'image',
  // video
  mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', wmv: 'video', flv: 'video',
  webm: 'video', m4v: 'video', mpg: 'video', mpeg: 'video', '3gp': 'video', mts: 'video',
  // audio
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', opus: 'audio',
  m4a: 'audio', wma: 'audio', aiff: 'audio', mid: 'audio', midi: 'audio',
  // documents
  pdf: 'document', doc: 'document', docx: 'document', odt: 'document', rtf: 'document',
  txt: 'document', md: 'document', epub: 'document', mobi: 'document', tex: 'document',
  // spreadsheets / presentations
  xls: 'spreadsheet', xlsx: 'spreadsheet', ods: 'spreadsheet', csv: 'spreadsheet', tsv: 'spreadsheet',
  ppt: 'presentation', pptx: 'presentation', odp: 'presentation', key: 'presentation',
  // archives
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive',
  xz: 'archive', zst: 'archive', iso: 'archive', dmg: 'archive',
  // code
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', json: 'code', html: 'code', css: 'code',
  scss: 'code', py: 'code', java: 'code', kt: 'code', c: 'code', h: 'code', cpp: 'code',
  hpp: 'code', rs: 'code', go: 'code', rb: 'code', php: 'code', sh: 'code', yml: 'code',
  yaml: 'code', toml: 'code', xml: 'code', sql: 'code', swift: 'code',
  // apps
  apk: 'app', exe: 'app', msi: 'app', deb: 'app', rpm: 'app', appimage: 'app', pkg: 'app',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function categoryOf(entry: Pick<FsEntry, 'name' | 'mime'>): FileCategory {
  const byExt = CATEGORY_BY_EXT[extensionOf(entry.name)];
  if (byExt) return byExt;
  const mime = entry.mime ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'document';
  return 'other';
}

/** Pre-compiled form of FilterRules; build once per scan, reuse per entry. */
export interface CompiledFilter {
  rules: FilterRules;
  include: CompiledGlob[];
  exclude: CompiledGlob[];
  extensions: Set<string>;
  categories: Set<FileCategory>;
  nameQuery: string;
}

export function compileFilter(rules: FilterRules): CompiledFilter {
  const excludePatterns = rules.useDefaultIgnores
    ? [...rules.excludeGlobs, ...DEFAULT_IGNORES]
    : rules.excludeGlobs;
  return {
    rules,
    include: compileGlobs(rules.includeGlobs, false),
    exclude: compileGlobs(excludePatterns, false),
    extensions: new Set(rules.extensions.map((e) => e.replace(/^\./, '').toLowerCase())),
    categories: new Set(rules.categories),
    nameQuery: (rules.nameQuery ?? '').trim().toLowerCase(),
  };
}

export interface FilterVerdict {
  keep: boolean;
  /** Why it was dropped, for the "excluded 1,204 files" explainer. */
  reason?: 'hidden' | 'symlink' | 'excluded' | 'not-included' | 'extension' | 'category' | 'size' | 'date' | 'name';
}

export function testEntry(entry: FsEntry, filter: CompiledFilter, relativeKey?: string): FilterVerdict {
  const { rules } = filter;
  const path = relativeKey ?? entry.key;

  if (!rules.includeHidden && entry.isHidden) return { keep: false, reason: 'hidden' };
  if (entry.isSymlink && !rules.followSymlinks) return { keep: false, reason: 'symlink' };
  if (matchesAny(path, filter.exclude)) return { keep: false, reason: 'excluded' };

  if (filter.nameQuery && !entry.name.toLowerCase().includes(filter.nameQuery)) {
    return { keep: false, reason: 'name' };
  }

  // Directories are only subject to hidden/exclude/name rules - content rules
  // like size or extension would wrongly prune folders full of matches.
  if (entry.kind === 'directory') return { keep: true };

  if (filter.include.length > 0 && !matchesAny(path, filter.include)) {
    return { keep: false, reason: 'not-included' };
  }
  if (filter.extensions.size > 0 && !filter.extensions.has(extensionOf(entry.name))) {
    return { keep: false, reason: 'extension' };
  }
  if (filter.categories.size > 0 && !filter.categories.has(categoryOf(entry))) {
    return { keep: false, reason: 'category' };
  }
  if (rules.minSize !== undefined && entry.size < rules.minSize) return { keep: false, reason: 'size' };
  if (rules.maxSize !== undefined && entry.size > rules.maxSize) return { keep: false, reason: 'size' };
  if (rules.modifiedAfter !== undefined && entry.mtime < rules.modifiedAfter) {
    return { keep: false, reason: 'date' };
  }
  if (rules.modifiedBefore !== undefined && entry.mtime > rules.modifiedBefore) {
    return { keep: false, reason: 'date' };
  }
  return { keep: true };
}

/** Whether the walker should descend into this directory at all. */
export function shouldEnterDirectory(dir: FsEntry, filter: CompiledFilter, relativeKey?: string): boolean {
  const path = relativeKey ?? dir.key;
  if (!filter.rules.includeHidden && dir.isHidden) return false;
  if (dir.isSymlink && !filter.rules.followSymlinks) return false;
  if (matchesAny(path, filter.exclude)) return false;
  if (matchesAny(`${path}/`, filter.exclude)) return false;
  if (filter.include.length > 0 && !couldMatchUnder(path, filter.include)) return false;
  return true;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const plainCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

export function compareEntries(a: FsEntry, b: FsEntry, sort: SortRules): number {
  if (sort.foldersFirst && a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;

  let result = 0;
  switch (sort.key) {
    case 'size':
      result = a.size - b.size;
      break;
    case 'mtime':
      result = a.mtime - b.mtime;
      break;
    case 'type': {
      const ea = a.kind === 'directory' ? '' : extensionOf(a.name);
      const eb = b.kind === 'directory' ? '' : extensionOf(b.name);
      result = plainCollator.compare(ea, eb);
      break;
    }
    case 'random':
      // Stable pseudo-random from the key so re-renders do not reshuffle.
      result = hash(a.key) - hash(b.key);
      break;
    case 'name':
    default:
      result = 0;
  }

  if (result === 0) {
    result = (sort.natural ? collator : plainCollator).compare(a.name, b.name);
  }
  return sort.direction === 'desc' ? -result : result;
}

export function sortEntries(entries: readonly FsEntry[], sort: SortRules): FsEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, sort));
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
