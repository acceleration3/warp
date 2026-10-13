/**
 * Platform-agnostic filesystem model used by the picker UI.
 *
 * `id` is an opaque handle the provider understands:
 *   - desktop: an absolute path ("/home/accel/photos")
 *   - Android: a SAF document URI ("content://com.android.externalstorage...")
 *
 * Anything that needs ordering or ancestry uses `key` instead, which is always a
 * canonical, forward-slash string so prefix comparison is meaningful on both.
 */

export type EntryKind = 'file' | 'directory';

export interface FsEntry {
  id: string;
  /** Canonical slash-separated key, used for sorting and ancestor tests. */
  key: string;
  name: string;
  kind: EntryKind;
  /** Bytes. Directories report 0 until explicitly measured. */
  size: number;
  /** Epoch ms. 0 when unknown. */
  mtime: number;
  mime?: string;
  isHidden: boolean;
  isSymlink?: boolean;
  /** Cheap child count when the platform offers one; undefined means "unknown". */
  childCount?: number;
  /** False when we could see the entry but may not read it. */
  readable: boolean;
}

export type RootKind =
  | 'home'
  | 'desktop'
  | 'downloads'
  | 'documents'
  | 'pictures'
  | 'videos'
  | 'music'
  | 'camera'
  | 'screenshots'
  | 'internal'
  | 'sdcard'
  | 'usb'
  | 'volume'
  | 'tree'
  | 'recent'
  | 'custom';

/**
 * Which section of the sidebar a shortcut belongs under.
 *
 * Android surfaces the same name from two different backends - the MediaStore
 * "Music" library and the "Music" folder on disk are not the same thing - so
 * the grouping is what keeps the list readable.
 */
export type RootGroup = 'app' | 'library' | 'storage' | 'removable' | 'bookmark';

/** A shortcut shown in the picker sidebar. */
export interface FsRoot {
  id: string;
  name: string;
  kind: RootKind;
  group?: RootGroup;
  entry: FsEntry;
  removable?: boolean;
  totalBytes?: number;
  freeBytes?: number;
  /** SAF trees can be revoked; the UI offers a re-grant button when false. */
  available?: boolean;
}

export type FileCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'code'
  | 'app'
  | 'other';

export interface FilterRules {
  /** Only files matching one of these are kept. Empty = keep everything. */
  includeGlobs: string[];
  /** Files matching any of these are dropped, and matching dirs are pruned. */
  excludeGlobs: string[];
  /** Lowercase, no leading dot. Empty = any extension. */
  extensions: string[];
  /** Empty = any category. */
  categories: FileCategory[];
  minSize?: number;
  maxSize?: number;
  modifiedAfter?: number;
  modifiedBefore?: number;
  includeHidden: boolean;
  followSymlinks: boolean;
  /** Applies DEFAULT_IGNORES on top of excludeGlobs. */
  useDefaultIgnores: boolean;
  /** Recursion cap for folder selections; undefined = unlimited. */
  maxDepth?: number;
  /** Live text filter applied to the basename, case-insensitive substring. */
  nameQuery?: string;
}

export const DEFAULT_IGNORES: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/target/debug/**',
  '**/.gradle/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/desktop.ini',
  '**/.Trash*/**',
  '**/~$*',
  '**/*.part',
  '**/*.crdownload',
];

export function defaultFilterRules(): FilterRules {
  return {
    includeGlobs: [],
    excludeGlobs: [],
    extensions: [],
    categories: [],
    includeHidden: false,
    followSymlinks: false,
    useDefaultIgnores: true,
  };
}

/** Thumbnail edge length in CSS pixels, as driven by the picker's size slider. */
export const THUMBNAIL_SIZE = { min: 48, max: 256, default: 104, step: 8 } as const;

export type SortKey = 'name' | 'size' | 'mtime' | 'type' | 'random';

export interface SortRules {
  key: SortKey;
  direction: 'asc' | 'desc';
  foldersFirst: boolean;
  /** "img10" after "img9" rather than before it. */
  natural: boolean;
}

export function defaultSortRules(): SortRules {
  return { key: 'name', direction: 'asc', foldersFirst: true, natural: true };
}

export interface ListOptions {
  signal?: AbortSignal;
  includeHidden?: boolean;
}

export interface WalkOptions {
  signal?: AbortSignal;
  includeHidden?: boolean;
  followSymlinks?: boolean;
  maxDepth?: number;
  /** Called with directories as they are entered, for "Scanning ..." UI. */
  onDirectory?: (dir: FsEntry, depth: number) => void;
  /** Return false to skip descending into a directory. */
  shouldEnter?: (dir: FsEntry, depth: number) => boolean;
}

export interface PickFilesOptions {
  multiple?: boolean;
  /** MIME hints for the native dialog, e.g. ["image/*"]. */
  mimeTypes?: string[];
  startIn?: string;
}

/** Everything the picker UI needs from a platform. */
export interface FsProvider {
  readonly platform: 'desktop' | 'android';
  /** Sidebar shortcuts: home, Downloads, DCIM, SD cards, granted SAF trees... */
  roots(): Promise<FsRoot[]>;
  list(dirId: string, options?: ListOptions): Promise<FsEntry[]>;
  stat(id: string): Promise<FsEntry | null>;
  parentOf(id: string): Promise<FsEntry | null>;
  /** Depth-first recursive listing, yielded in batches to keep the UI responsive. */
  walk(dirId: string, options?: WalkOptions): AsyncIterable<FsEntry[]>;
  /** A URL the renderer can put in an <img src>. Null when not previewable. */
  thumbnailUrl?(entry: FsEntry, sizePx: number): Promise<string | null>;
  /** Native OS dialog. On Android this is SAF; on desktop it is the GTK/Win dialog. */
  pickFiles?(options?: PickFilesOptions): Promise<FsEntry[]>;
  /** Native folder dialog. On Android grants a persistable SAF tree. */
  pickFolder?(): Promise<FsRoot | null>;
  /** Drop a previously granted SAF tree. */
  releaseRoot?(rootId: string): Promise<void>;
}
