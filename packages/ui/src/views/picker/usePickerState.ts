import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  SelectionModel,
  compileFilter,
  defaultFilterRules,
  defaultSortRules,
  sortEntries,
  testEntry,
  type FilterRules,
  type FsEntry,
  type FsRoot,
  type SortRules,
} from '@share/core';

import { bridge } from '../../bridge';

export interface PickerState {
  /** Directory currently shown. */
  cwd: FsEntry | null;
  entries: FsEntry[];
  /** Entries after search + filter, in sort order. */
  visible: FsEntry[];
  loading: boolean;
  error: string | null;
  roots: FsRoot[];
  breadcrumbs: FsEntry[];
  canGoBack: boolean;
  canGoForward: boolean;
  canGoUp: boolean;
  /** How many entries the filter is hiding right now. */
  hiddenByFilter: number;
}

export interface PickerActions {
  navigate: (entry: FsEntry) => void;
  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  reload: () => void;
  /** Re-reads the sidebar shortcuts, after a permission grant adds more. */
  reloadRoots: () => void;
}

const HISTORY_LIMIT = 64;

export function usePicker(
  filter: FilterRules,
  sort: SortRules,
  search: string,
): PickerState & PickerActions {
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [cwd, setCwd] = useState<FsEntry | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [rootsToken, setRootsToken] = useState(0);

  const history = useRef<FsEntry[]>([]);
  const historyIndex = useRef(-1);
  const requestId = useRef(0);

  // Load the sidebar roots, and again whenever a permission grant adds more.
  useEffect(() => {
    let alive = true;
    void bridge()
      .roots()
      .then((loaded) => {
        if (!alive) return;
        setRoots(loaded);
        if (!cwd && loaded[0]) {
          history.current = [loaded[0].entry];
          historyIndex.current = 0;
          setCwd(loaded[0].entry);
        }
      })
      .catch((cause: unknown) => alive && setError(String(cause)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsToken]);

  // List the current directory whenever it (or the hidden-files rule) changes.
  useEffect(() => {
    if (!cwd) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);

    void bridge()
      .list(cwd.id, { includeHidden: filter.includeHidden })
      .then((listed) => {
        if (id !== requestId.current) return; // a newer navigation won
        setEntries(listed);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return;
        setEntries([]);
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });
  }, [cwd, filter.includeHidden, reloadToken]);

  // Rebuild the breadcrumb trail by walking up to the filesystem root.
  useEffect(() => {
    if (!cwd) {
      setBreadcrumbs([]);
      return;
    }
    let alive = true;
    const build = async (): Promise<void> => {
      const trail: FsEntry[] = [cwd];
      let current = cwd;
      for (let depth = 0; depth < 32; depth++) {
        const parent = await bridge().parentOf(current.id);
        if (!parent || parent.id === current.id) break;
        trail.unshift(parent);
        current = parent;
      }
      if (alive) setBreadcrumbs(trail);
    };
    void build();
    return () => {
      alive = false;
    };
  }, [cwd]);

  const navigate = useCallback((entry: FsEntry) => {
    if (entry.kind !== 'directory') return;
    const trimmed = history.current.slice(0, historyIndex.current + 1);
    trimmed.push(entry);
    if (trimmed.length > HISTORY_LIMIT) trimmed.shift();
    history.current = trimmed;
    historyIndex.current = trimmed.length - 1;
    setCwd(entry);
  }, []);

  const goBack = useCallback(() => {
    if (historyIndex.current <= 0) return;
    historyIndex.current--;
    setCwd(history.current[historyIndex.current] ?? null);
  }, []);

  const goForward = useCallback(() => {
    if (historyIndex.current >= history.current.length - 1) return;
    historyIndex.current++;
    setCwd(history.current[historyIndex.current] ?? null);
  }, []);

  const goUp = useCallback(() => {
    const parent = breadcrumbs[breadcrumbs.length - 2];
    if (parent) navigate(parent);
  }, [breadcrumbs, navigate]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);
  const reloadRoots = useCallback(() => setRootsToken((token) => token + 1), []);

  // Apply the filter + search, then sort. Directories survive content filters
  // so the user can still navigate into them.
  const { visible, hiddenByFilter } = useMemo(() => {
    const compiled = compileFilter({ ...filter, nameQuery: search || undefined });
    const kept = entries.filter((entry) => testEntry(entry, compiled, entry.name).keep);
    return { visible: sortEntries(kept, sort), hiddenByFilter: entries.length - kept.length };
  }, [entries, filter, sort, search]);

  return {
    cwd,
    entries,
    visible,
    loading,
    error,
    roots,
    breadcrumbs,
    canGoBack: historyIndex.current > 0,
    canGoForward: historyIndex.current < history.current.length - 1,
    canGoUp: breadcrumbs.length > 1,
    hiddenByFilter,
    navigate,
    goBack,
    goForward,
    goUp,
    reload,
    reloadRoots,
  };
}

/** Wraps the core SelectionModel so React re-renders when it mutates. */
export function useSelection(): {
  model: SelectionModel;
  version: number;
  toggle: (entry: FsEntry) => void;
  select: (entries: readonly FsEntry[]) => void;
  deselect: (entries: readonly FsEntry[]) => void;
  clear: () => void;
} {
  const modelRef = useRef<SelectionModel>(null as unknown as SelectionModel);
  if (!modelRef.current) modelRef.current = new SelectionModel();
  const model = modelRef.current;
  const [version, setVersion] = useState(0);

  useEffect(() => model.subscribe(() => setVersion(model.version)), [model]);

  return {
    model,
    version,
    toggle: useCallback((entry: FsEntry) => model.toggle(entry), [model]),
    select: useCallback((items: readonly FsEntry[]) => model.setMany(items, true), [model]),
    deselect: useCallback((items: readonly FsEntry[]) => model.setMany(items, false), [model]),
    clear: useCallback(() => model.clear(), [model]),
  };
}

export { defaultFilterRules, defaultSortRules };
