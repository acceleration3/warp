import type { FsEntry, FsProvider, WalkOptions } from './types.js';
import { compileFilter, shouldEnterDirectory, testEntry, type CompiledFilter } from './filter.js';
import type { FilterRules } from './types.js';

/**
 * Tri-state selection over a lazily-loaded tree.
 *
 * The user checks whole folders without us ever having listed them. So instead
 * of storing every file, we store a small set of *included* subtree roots plus
 * *excluded* nodes beneath them. A node's checkbox state is then derived by
 * walking up its key, and the actual file list is only materialized on send.
 */

export type CheckState = 'checked' | 'unchecked' | 'partial';

export interface SelectedNode {
  entry: FsEntry;
  /** Canonical key, kept separate so it can be compared without the entry. */
  key: string;
}

function isDescendantKey(ancestor: string, candidate: string): boolean {
  if (candidate === ancestor) return false;
  const prefix = ancestor.endsWith('/') ? ancestor : `${ancestor}/`;
  return candidate.startsWith(prefix);
}

function keyDepth(key: string): number {
  return key.split('/').length;
}

export class SelectionModel {
  private readonly included = new Map<string, SelectedNode>();
  private readonly excluded = new Map<string, SelectedNode>();
  private readonly listeners = new Set<() => void>();
  /** Bumped on every mutation so React can cheaply detect change. */
  private revision = 0;

  get version(): number {
    return this.revision;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  /** The explicitly checked subtree roots, in insertion order. */
  roots(): SelectedNode[] {
    return [...this.included.values()];
  }

  exclusions(): SelectedNode[] {
    return [...this.excluded.values()];
  }

  isEmpty(): boolean {
    return this.included.size === 0;
  }

  clear(): void {
    if (this.included.size === 0 && this.excluded.size === 0) return;
    this.included.clear();
    this.excluded.clear();
    this.emit();
  }

  /** Nearest ancestor (or self) present in `map`, or null. */
  private nearestIn(map: Map<string, SelectedNode>, key: string): SelectedNode | null {
    let best: SelectedNode | null = null;
    let bestDepth = -1;
    const self = map.get(key);
    if (self) return self;
    for (const node of map.values()) {
      if (isDescendantKey(node.key, key)) {
        const depth = keyDepth(node.key);
        if (depth > bestDepth) {
          best = node;
          bestDepth = depth;
        }
      }
    }
    return best;
  }

  private hasIncludedDescendant(key: string): boolean {
    for (const node of this.included.values()) {
      if (isDescendantKey(key, node.key)) return true;
    }
    return false;
  }

  private hasExcludedDescendant(key: string): boolean {
    for (const node of this.excluded.values()) {
      if (isDescendantKey(key, node.key)) return true;
    }
    return false;
  }

  /** Checkbox state for any entry, whether or not it has ever been listed. */
  stateOf(entry: Pick<FsEntry, 'key' | 'kind'>): CheckState {
    const { key } = entry;
    const include = this.nearestIn(this.included, key);
    const exclude = this.nearestIn(this.excluded, key);

    // Whichever rule is deepest wins.
    const includeDepth = include ? keyDepth(include.key) : -1;
    const excludeDepth = exclude ? keyDepth(exclude.key) : -1;

    if (excludeDepth >= includeDepth && exclude) {
      // Explicitly excluded, but a deeper re-include can make it partial.
      return this.hasIncludedDescendant(key) ? 'partial' : 'unchecked';
    }
    if (include) {
      if (entry.kind === 'directory' && this.hasExcludedDescendant(key)) return 'partial';
      return 'checked';
    }
    return this.hasIncludedDescendant(key) ? 'partial' : 'unchecked';
  }

  isSelected(entry: Pick<FsEntry, 'key' | 'kind'>): boolean {
    return this.stateOf(entry) === 'checked';
  }

  select(entry: FsEntry): void {
    const node: SelectedNode = { entry, key: entry.key };
    // Drop any rule strictly beneath this one - it is now redundant.
    for (const key of [...this.included.keys()]) {
      if (isDescendantKey(entry.key, key)) this.included.delete(key);
    }
    for (const key of [...this.excluded.keys()]) {
      if (isDescendantKey(entry.key, key) || key === entry.key) this.excluded.delete(key);
    }
    // Already covered by a checked ancestor with no exclusion in between.
    if (this.stateOf(entry) === 'checked') {
      this.emit();
      return;
    }
    this.included.set(entry.key, node);
    this.emit();
  }

  deselect(entry: FsEntry): void {
    let mutated = false;
    for (const key of [...this.included.keys()]) {
      if (key === entry.key || isDescendantKey(entry.key, key)) {
        this.included.delete(key);
        mutated = true;
      }
    }
    for (const key of [...this.excluded.keys()]) {
      if (isDescendantKey(entry.key, key)) {
        this.excluded.delete(key);
        mutated = true;
      }
    }
    // Still covered by an ancestor? Then record an explicit exclusion.
    if (this.nearestIn(this.included, entry.key)) {
      this.excluded.set(entry.key, { entry, key: entry.key });
      mutated = true;
    }
    if (mutated) this.emit();
  }

  toggle(entry: FsEntry): void {
    if (this.stateOf(entry) === 'checked') this.deselect(entry);
    else this.select(entry);
  }

  setMany(entries: readonly FsEntry[], selected: boolean): void {
    for (const entry of entries) {
      if (selected) this.select(entry);
      else this.deselect(entry);
    }
  }

  /** Restores a serialized selection (used by saved presets). */
  static hydrate(included: SelectedNode[], excluded: SelectedNode[]): SelectionModel {
    const model = new SelectionModel();
    for (const node of included) model.included.set(node.key, node);
    for (const node of excluded) model.excluded.set(node.key, node);
    return model;
  }

  toJSON(): { included: SelectedNode[]; excluded: SelectedNode[] } {
    return { included: this.roots(), excluded: this.exclusions() };
  }
}

/** A file resolved from the selection, ready to be offered to a peer. */
export interface ResolvedFile {
  entry: FsEntry;
  /** POSIX path relative to the transfer root, e.g. "photos/2024/a.jpg". */
  relativePath: string;
}

export interface ResolveProgress {
  filesFound: number;
  bytesFound: number;
  directoriesScanned: number;
  currentPath: string;
  excluded: number;
}

export interface ResolveResult {
  files: ResolvedFile[];
  totalBytes: number;
  excluded: number;
  /** True when the walk stopped early because the cap was hit. */
  truncated: boolean;
}

export interface ResolveOptions {
  filter?: FilterRules;
  signal?: AbortSignal;
  onProgress?: (progress: ResolveProgress) => void;
  /** Safety valve so a stray "/" selection cannot hang the UI forever. */
  maxFiles?: number;
}

/**
 * Materializes the selection into a flat file list by walking every included
 * directory, honoring exclusions and filters. This is the one place that is
 * allowed to be slow, so it reports progress and is abortable.
 */
export async function resolveSelection(
  selection: SelectionModel,
  provider: FsProvider,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const filter: CompiledFilter = compileFilter(
    options.filter ?? {
      includeGlobs: [],
      excludeGlobs: [],
      extensions: [],
      categories: [],
      includeHidden: false,
      followSymlinks: false,
      useDefaultIgnores: true,
    },
  );
  const maxFiles = options.maxFiles ?? 200_000;

  const files: ResolvedFile[] = [];
  const usedPaths = new Set<string>();
  let totalBytes = 0;
  let excluded = 0;
  let directoriesScanned = 0;
  let truncated = false;

  const progress: ResolveProgress = {
    filesFound: 0,
    bytesFound: 0,
    directoriesScanned: 0,
    currentPath: '',
    excluded: 0,
  };
  let lastReport = 0;
  const report = (force = false): void => {
    if (!options.onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < 100) return;
    lastReport = now;
    progress.filesFound = files.length;
    progress.bytesFound = totalBytes;
    progress.directoriesScanned = directoriesScanned;
    progress.excluded = excluded;
    options.onProgress({ ...progress });
  };

  /** Guarantees a unique destination path when two roots share a basename. */
  const claimPath = (desired: string): string => {
    if (!usedPaths.has(desired)) {
      usedPaths.add(desired);
      return desired;
    }
    const slash = desired.lastIndexOf('/');
    const dir = slash === -1 ? '' : desired.slice(0, slash + 1);
    const base = slash === -1 ? desired : desired.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let i = 2; ; i++) {
      const candidate = `${dir}${stem} (${i})${ext}`;
      if (!usedPaths.has(candidate)) {
        usedPaths.add(candidate);
        return candidate;
      }
    }
  };

  const excludedKeys = selection.exclusions().map((node) => node.key);
  const isExcluded = (key: string): boolean =>
    excludedKeys.some((ex) => key === ex || key.startsWith(`${ex}/`));

  for (const root of selection.roots()) {
    if (options.signal?.aborted) break;
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }

    if (root.entry.kind === 'file') {
      const verdict = testEntry(root.entry, filter, root.entry.name);
      if (!verdict.keep) {
        excluded++;
        continue;
      }
      files.push({ entry: root.entry, relativePath: claimPath(root.entry.name) });
      totalBytes += root.entry.size;
      report();
      continue;
    }

    // Directory: everything lands under a folder named after it.
    const prefix = root.entry.name;
    const rootKey = root.entry.key;
    const relativeOf = (entry: FsEntry): string => {
      const tail = entry.key.startsWith(`${rootKey}/`)
        ? entry.key.slice(rootKey.length + 1)
        : entry.name;
      return `${prefix}/${tail}`;
    };

    const walkOptions: WalkOptions = {
      signal: options.signal,
      includeHidden: filter.rules.includeHidden,
      followSymlinks: filter.rules.followSymlinks,
      maxDepth: filter.rules.maxDepth,
      onDirectory: (dir) => {
        directoriesScanned++;
        progress.currentPath = dir.key;
        report();
      },
      shouldEnter: (dir) => {
        if (isExcluded(dir.key)) return false;
        return shouldEnterDirectory(dir, filter, relativeOf(dir));
      },
    };

    for await (const batch of provider.walk(root.entry.id, walkOptions)) {
      if (options.signal?.aborted) break;
      for (const entry of batch) {
        if (entry.kind === 'directory') continue;
        if (isExcluded(entry.key)) {
          excluded++;
          continue;
        }
        const relative = relativeOf(entry);
        if (!testEntry(entry, filter, relative).keep) {
          excluded++;
          continue;
        }
        files.push({ entry, relativePath: claimPath(relative) });
        totalBytes += entry.size;
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
      }
      report();
      if (truncated) break;
    }
  }

  report(true);
  return { files, totalBytes, excluded, truncated };
}
