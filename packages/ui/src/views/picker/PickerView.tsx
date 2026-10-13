import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  THUMBNAIL_SIZE,
  categoryOf,
  formatBytes,
  formatCount,
  formatRelativeTime,
  type FilterRules,
  type FsEntry,
  type Peer,
  type SelectionPayload,
  type SortKey,
  type SortRules,
} from '@share/core';

import { bridge, isAndroid } from '../../bridge';
import {
  Badge,
  Button,
  Check,
  Dialog,
  ProgressBar,
  Row,
  SearchEntry,
  Spinner,
  StatusPage,
  useMenu,
  useToast,
  type CheckState,
} from '../../components';
import { Icon, iconForCategory, iconForPlatform, type IconName } from '../../icons';
import { useLocal, useNarrow } from '../../store';
import { FilterSheet } from './FilterSheet';
import { MediaPreview } from './MediaPreview';
import { Thumb, iconFor, isPlayable } from './Thumb';
import { usePicker, useSelection } from './usePickerState';

type ViewMode = 'list' | 'grid' | 'tree';

/** Sidebar sections, in the order they are shown. */
const ROOT_GROUPS = [
  { group: 'app', label: 'Places' },
  { group: 'library', label: 'Library' },
  { group: 'storage', label: 'Storage' },
  { group: 'removable', label: 'Removable' },
  { group: 'bookmark', label: 'Saved' },
] as const;

/* -------------------------------------------------------------------------- */
/* Tree view                                                                   */
/* -------------------------------------------------------------------------- */

function TreeNode({
  entry,
  depth,
  includeHidden,
  stateOf,
  onToggle,
  onOpen,
}: {
  entry: FsEntry;
  depth: number;
  includeHidden: boolean;
  stateOf: (entry: FsEntry) => CheckState;
  onToggle: (entry: FsEntry) => void;
  onOpen: (entry: FsEntry) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const expand = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children) return;
    setLoading(true);
    void bridge()
      .list(entry.id, { includeHidden })
      .then((listed) => setChildren(listed.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))))
      .catch(() => setChildren([]))
      .finally(() => setLoading(false));
  }, [expanded, children, entry.id, includeHidden]);

  return (
    <>
      <Row
        title={entry.name}
        subtitle={entry.kind === 'file' ? formatBytes(entry.size) : undefined}
        selected={stateOf(entry) === 'checked'}
        style={{ paddingLeft: 10 + depth * 18 }}
        prefix={
          <>
            {entry.kind === 'directory' ? (
              <button
                type="button"
                className="btn btn--flat btn--small btn--circular"
                onClick={(event) => {
                  event.stopPropagation();
                  expand();
                }}
                aria-label={expanded ? 'Collapse' : 'Expand'}
              >
                <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
              </button>
            ) : (
              <span style={{ width: 28 }} />
            )}
            <Check state={stateOf(entry)} onChange={() => onToggle(entry)} label={entry.name} />
          </>
        }
        icon={iconFor(entry)}
        onClick={() => (entry.kind === 'directory' ? expand() : onToggle(entry))}
        onDoubleClick={() => entry.kind === 'directory' && onOpen(entry)}
      />
      {expanded && loading ? (
        <div style={{ padding: `6px 0 6px ${28 + depth * 18}px` }}>
          <Spinner />
        </div>
      ) : null}
      {expanded && children
        ? children.map((child) => (
            <TreeNode
              key={child.id}
              entry={child}
              depth={depth + 1}
              includeHidden={includeHidden}
              stateOf={stateOf}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))
        : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Picker                                                                      */
/* -------------------------------------------------------------------------- */

export interface PickerViewProps {
  peers: Peer[];
  filter: FilterRules;
  sort: SortRules;
  bookmarks: string[];
  thumbnailSize: number;
  showThumbnails: boolean;
  onFilterChange: (filter: FilterRules) => void;
  onSortChange: (sort: SortRules) => void;
  onBookmarksChange: (bookmarks: string[]) => void;
  onThumbnailSizeChange: (size: number) => void;
  onShowThumbnailsChange: (show: boolean) => void;
  /** Called after a transfer has been queued. */
  onSent: () => void;
}

export function PickerView({
  peers,
  filter,
  sort,
  bookmarks,
  thumbnailSize,
  showThumbnails,
  onFilterChange,
  onSortChange,
  onBookmarksChange,
  onThumbnailSizeChange,
  onShowThumbnailsChange,
  onSent,
}: PickerViewProps): React.ReactElement {
  const [view, setView] = useLocal<ViewMode>('picker.view', 'list');
  const narrow = useNarrow();
  // Remembered per width class: a phone wants the column out of the way by
  // default, a desktop wants it there, and either choice should stick.
  const [placesOpenWide, setPlacesOpenWide] = useLocal('picker.places.wide', true);
  const [placesOpenNarrow, setPlacesOpenNarrow] = useLocal('picker.places.narrow', false);
  const placesOpen = narrow ? placesOpenNarrow : placesOpenWide;
  const setPlacesOpen = narrow ? setPlacesOpenNarrow : setPlacesOpenWide;
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [peerDialog, setPeerDialog] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [scan, setScan] = useState<{ files: number; bytes: number } | null>(null);
  const [measured, setMeasured] = useState<Record<string, { files: number; bytes: number }>>({});
  // null until asked; Android only.
  const [mediaAccess, setMediaAccess] = useState<boolean | null>(null);
  const [playing, setPlaying] = useState<FsEntry | null>(null);
  const [allFiles, setAllFiles] = useState<boolean | null>(null);

  const picker = usePicker(filter, sort, search);

  useEffect(() => {
    const check = bridge().checkMediaAccess;
    if (check) void check().then(setMediaAccess).catch(() => setMediaAccess(null));
    const checkAll = bridge().checkAllFilesAccess;
    if (checkAll) void checkAll().then(setAllFiles).catch(() => setAllFiles(null));
  }, []);

  /**
   * Browsing the storage tree needs all-files access, which is granted in
   * system settings rather than by a dialog - so the user leaves the app and
   * comes back, and the roots have to be re-read when they do.
   */
  const askForAllFiles = useCallback(() => {
    const request = bridge().requestAllFilesAccess;
    if (!request) return;
    void request().then((granted) => {
      setAllFiles(granted);
      if (granted) {
        picker.reloadRoots();
        toast('Internal storage is now browsable');
      } else {
        toast('Access was not granted', { tone: 'error' });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker.reloadRoots]);

  /** MediaStore-backed shortcuts look empty rather than failing when denied. */
  const needsMediaAccess =
    isAndroid() && mediaAccess === false && (picker.cwd?.id ?? '').startsWith('media:');

  const askForMediaAccess = useCallback(() => {
    const request = bridge().requestMediaAccess;
    if (!request) return;
    void request().then((granted) => {
      setMediaAccess(granted);
      if (granted) picker.reload();
      else toast('Access was not granted, so these stay empty', { tone: 'error' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker.reload]);
  const selection = useSelection();
  const toast = useToast();
  const { menu, open: openMenu } = useMenu();
  const listRef = useRef<HTMLDivElement>(null);
  const lastClickIndex = useRef<number | null>(null);

  const stateOf = useCallback(
    (entry: FsEntry): CheckState => selection.model.stateOf(entry),
    // The model mutates in place, so the version is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection.model, selection.version],
  );

  const selectedRoots = useMemo(
    () => selection.model.roots(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection.model, selection.version],
  );

  // Live tally of what is staged. Directories need a walk, so they are measured
  // on demand and cached.
  const tally = useMemo(() => {
    let files = 0;
    let bytes = 0;
    let unknownFolders = 0;
    for (const node of selectedRoots) {
      if (node.entry.kind === 'file') {
        files++;
        bytes += node.entry.size;
        continue;
      }
      const cached = measured[node.entry.id];
      if (cached) {
        files += cached.files;
        bytes += cached.bytes;
      } else {
        unknownFolders++;
      }
    }
    return { files, bytes, unknownFolders, roots: selectedRoots.length };
  }, [selectedRoots, measured]);

  // Measure any newly staged folder so the tray total stops saying "unknown".
  useEffect(() => {
    const pending = selectedRoots.filter((node) => node.entry.kind === 'directory' && !measured[node.entry.id]);
    if (pending.length === 0) return;
    let alive = true;
    void (async () => {
      for (const node of pending) {
        try {
          const result = await bridge().measure(node.entry.id);
          if (!alive) return;
          setMeasured((current) => ({ ...current, [node.entry.id]: result }));
        } catch {
          /* unreadable folder: leave it unmeasured */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedRoots, measured]);

  const payload = useCallback(
    (): SelectionPayload => ({
      included: selection.model.roots().map((node) => node.entry),
      excluded: selection.model.exclusions().map((node) => node.entry),
      filter,
    }),
    [selection.model, filter],
  );

  const send = useCallback(
    async (peer: Peer) => {
      setSending(true);
      setPeerDialog(false);
      try {
        const roots = selection.model.roots();
        const label =
          roots.length === 1 && roots[0]
            ? roots[0].entry.name
            : `${formatCount(roots.length, 'item')} from ${picker.cwd?.name ?? 'this device'}`;
        await bridge().send(peer.id, payload(), label);
        toast(`Sending to ${peer.name}`);
        selection.clear();
        setMeasured({});
        setTrayOpen(false);
        onSent();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), { tone: 'error' });
      } finally {
        setSending(false);
      }
    },
    [payload, picker.cwd, selection, toast, onSent],
  );

  const startSend = useCallback(() => {
    if (selection.model.isEmpty()) return;
    if (peers.length === 0) {
      toast('No devices found on your network yet', { tone: 'error' });
      return;
    }
    if (peers.length === 1 && peers[0]) {
      void send(peers[0]);
      return;
    }
    setPeerDialog(true);
  }, [peers, selection.model, send, toast]);

  // Keyboard navigation over the visible list.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((index) => Math.min(picker.visible.length - 1, index + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((index) => Math.max(0, index - 1));
      } else if (event.key === ' ') {
        const entry = picker.visible[cursor];
        if (entry) {
          event.preventDefault();
          selection.toggle(entry);
        }
      } else if (event.key === 'Enter') {
        const entry = picker.visible[cursor];
        if (entry?.kind === 'directory') picker.navigate(entry);
      } else if (event.key === 'Backspace') {
        picker.goUp();
      } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        selection.select(picker.visible);
      } else if (event.key === 'F9') {
        event.preventDefault();
        setPlacesOpen(!placesOpen);
      } else if (event.key === 'Escape') {
        setSearch('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picker, cursor, selection, placesOpen, setPlacesOpen]);

  useEffect(() => setCursor(0), [picker.cwd]);

  /** Shift-click selects the whole run between the anchor and this row. */
  const handleRowClick = (entry: FsEntry, index: number, event: React.MouseEvent): void => {
    if (event.shiftKey && lastClickIndex.current !== null) {
      const from = Math.min(lastClickIndex.current, index);
      const to = Math.max(lastClickIndex.current, index);
      selection.select(picker.visible.slice(from, to + 1));
      return;
    }
    lastClickIndex.current = index;
    setCursor(index);
    selection.toggle(entry);
  };

  const contextItems = (entry: FsEntry) => [
    {
      label: stateOf(entry) === 'checked' ? 'Remove from selection' : 'Add to selection',
      icon: (stateOf(entry) === 'checked' ? 'minus' : 'plus') as IconName,
      onSelect: () => selection.toggle(entry),
    },
    ...(entry.kind === 'directory'
      ? [
          { label: 'Open', icon: 'folder-open' as IconName, onSelect: () => picker.navigate(entry) },
          {
            label: bookmarks.includes(entry.id) ? 'Remove bookmark' : 'Bookmark this folder',
            icon: 'star' as IconName,
            onSelect: () =>
              onBookmarksChange(
                bookmarks.includes(entry.id)
                  ? bookmarks.filter((item) => item !== entry.id)
                  : [...bookmarks, entry.id],
              ),
          },
          {
            label: 'Calculate size',
            icon: 'clock' as IconName,
            onSelect: () => {
              setScan({ files: 0, bytes: 0 });
              void bridge()
                .measure(entry.id)
                .then((result) => {
                  setMeasured((current) => ({ ...current, [entry.id]: result }));
                  setScan(null);
                  toast(`${entry.name}: ${formatCount(result.files, 'file')}, ${formatBytes(result.bytes)}`);
                })
                .catch(() => setScan(null));
            },
          },
        ]
      : []),
    {
      label: 'Open in file manager',
      icon: 'link' as IconName,
      separatorBefore: true,
      onSelect: () => void bridge().revealPath(entry.id),
    },
  ];

  const sortMenuItems = [
    ...(['name', 'size', 'mtime', 'type'] as SortKey[]).map((key) => ({
      label: { name: 'Name', size: 'Size', mtime: 'Modified', type: 'Type', random: 'Random' }[key],
      icon: (sort.key === key ? 'check' : undefined) as IconName | undefined,
      onSelect: () => onSortChange({ ...sort, key }),
    })),
    {
      label: sort.direction === 'asc' ? 'Descending' : 'Ascending',
      icon: (sort.direction === 'asc' ? 'arrow-down' : 'arrow-up') as IconName,
      separatorBefore: true,
      onSelect: () => onSortChange({ ...sort, direction: sort.direction === 'asc' ? 'desc' : 'asc' }),
    },
    {
      label: sort.foldersFirst ? 'Mix folders in' : 'Folders first',
      icon: 'folder' as IconName,
      onSelect: () => onSortChange({ ...sort, foldersFirst: !sort.foldersFirst }),
    },
  ];

  const activeFilterCount =
    filter.categories.length +
    filter.extensions.length +
    filter.includeGlobs.length +
    filter.excludeGlobs.length +
    (filter.minSize !== undefined ? 1 : 0) +
    (filter.maxSize !== undefined ? 1 : 0) +
    (filter.modifiedAfter !== undefined ? 1 : 0) +
    (filter.maxDepth !== undefined ? 1 : 0);

  return (
    <>
      {/* Toolbar -------------------------------------------------------- */}
      <div
        className="hbox hbox--sm"
        style={{
          padding: '10px 14px',
          gap: 8,
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--window-bg)',
          flexWrap: 'wrap',
        }}
      >
        <Button
          icon="sidebar"
          title={placesOpen ? 'Hide places (F9)' : 'Show places (F9)'}
          active={placesOpen}
          onClick={() => setPlacesOpen(!placesOpen)}
        />

        <div className="linked">
          <Button icon="chevron-left" title="Back" disabled={!picker.canGoBack} onClick={picker.goBack} />
          <Button icon="chevron-right" title="Forward" disabled={!picker.canGoForward} onClick={picker.goForward} />
          <Button icon="arrow-up" title="Up one folder" disabled={!picker.canGoUp} onClick={picker.goUp} />
        </div>

        <SearchEntry value={search} onChange={setSearch} placeholder="Search this folder" />

        <div className="toggle-group">
          {([
            { mode: 'list' as ViewMode, icon: 'list' as IconName, label: 'List' },
            { mode: 'grid' as ViewMode, icon: 'grid' as IconName, label: 'Thumbnails' },
            { mode: 'tree' as ViewMode, icon: 'tree' as IconName, label: 'Tree' },
          ]).map((option) => (
            <button
              key={option.mode}
              type="button"
              className={view === option.mode ? 'is-active' : ''}
              title={`${option.label} view`}
              aria-pressed={view === option.mode}
              onClick={() => setView(option.mode)}
            >
              <Icon name={option.icon} size={14} />
              {view === option.mode ? option.label : null}
            </button>
          ))}
        </div>

        {/* Only meaningful where thumbnails are actually drawn. */}
        {view === 'grid' ? (
          <label
            className="hbox hbox--sm"
            title={`Thumbnail size: ${thumbnailSize}px`}
            style={{ gap: 6 }}
          >
            <Icon name="image" size={13} style={{ opacity: 0.55 }} />
            <input
              type="range"
              min={THUMBNAIL_SIZE.min}
              max={THUMBNAIL_SIZE.max}
              step={THUMBNAIL_SIZE.step}
              value={thumbnailSize}
              aria-label="Thumbnail size"
              style={{ width: 110 }}
              onChange={(event) => onThumbnailSizeChange(Number(event.target.value))}
            />
          </label>
        ) : null}

        <Button
          icon="eye"
          title={showThumbnails ? 'Show icons instead of previews' : 'Show image previews'}
          active={showThumbnails}
          onClick={() => onShowThumbnailsChange(!showThumbnails)}
        />

        <Button icon="sort" title="Sort" onClick={(event) => openMenu(event, sortMenuItems)} />
        <Button
          icon="funnel"
          title="Filters"
          active={activeFilterCount > 0}
          onClick={() => setShowFilters(true)}
        >
          {activeFilterCount > 0 ? String(activeFilterCount) : undefined}
        </Button>
        <Button
          icon="shield"
          title={filter.includeHidden ? 'Hide hidden files' : 'Show hidden files'}
          active={filter.includeHidden}
          onClick={() => onFilterChange({ ...filter, includeHidden: !filter.includeHidden })}
        />
        <Button icon="refresh" title="Reload" onClick={picker.reload} />
      </div>

      {/* Breadcrumbs ---------------------------------------------------- */}
      <div
        className="hbox"
        style={{
          gap: 2,
          padding: '7px 14px',
          overflowX: 'auto',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--window-bg)',
        }}
      >
        {picker.breadcrumbs.map((crumb, index) => (
          <div key={crumb.id} className="hbox" style={{ gap: 2 }}>
            {index > 0 ? <Icon name="chevron-right" size={12} style={{ opacity: 0.4 }} /> : null}
            <Button
              size="small"
              variant="flat"
              pill
              onClick={() => picker.navigate(crumb)}
              icon={index === 0 ? 'home' : undefined}
            >
              {index === 0 && crumb.name === '/' ? 'Computer' : crumb.name}
            </Button>
          </div>
        ))}
        <div className="spacer" />
        <Button
          size="small"
          variant="flat"
          pill
          icon="star"
          title="Bookmark this folder"
          active={picker.cwd ? bookmarks.includes(picker.cwd.id) : false}
          onClick={() => {
            if (!picker.cwd) return;
            onBookmarksChange(
              bookmarks.includes(picker.cwd.id)
                ? bookmarks.filter((item) => item !== picker.cwd!.id)
                : [...bookmarks, picker.cwd.id],
            );
          }}
        />
      </div>

      {/* Places + entries ----------------------------------------------- */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <nav
          className={`picker-places ${placesOpen ? '' : 'is-collapsed'}`}
          aria-hidden={!placesOpen}
          aria-label="Places"
        >
          {ROOT_GROUPS.map(({ group, label }) => {
            const inGroup = picker.roots.filter((root) => (root.group ?? 'app') === group);
            if (inGroup.length === 0) return null;
            return (
              <div key={group}>
                <div className="sidebar__section">{label}</div>
                {inGroup.map((root) => (
                  <button
                    key={root.id}
                    type="button"
                    className={`nav-item ${picker.cwd?.id === root.id ? 'is-active' : ''}`}
                    onClick={() => picker.navigate(root.entry)}
                  >
              <Icon
                name={
                  root.kind === 'home'
                    ? 'home'
                    : root.kind === 'usb' || root.kind === 'volume'
                      ? 'archive'
                      : root.kind === 'pictures'
                        ? 'image'
                        : root.kind === 'videos'
                          ? 'video'
                          : root.kind === 'music'
                            ? 'audio'
                            : root.kind === 'downloads'
                              ? 'download'
                              : 'folder'
                }
              />
                    <span className="ellipsis">{root.name}</span>
                  </button>
                ))}
              </div>
            );
          })}

          {bookmarks.length > 0 ? (
            <>
              <div className="sidebar__section">Bookmarks</div>
              {bookmarks.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`nav-item ${picker.cwd?.id === id ? 'is-active' : ''}`}
                  onClick={() => void bridge().stat(id).then((entry) => entry && picker.navigate(entry))}
                  onContextMenu={(event) =>
                    openMenu(event, [
                      {
                        label: 'Remove bookmark',
                        icon: 'trash',
                        destructive: true,
                        onSelect: () => onBookmarksChange(bookmarks.filter((item) => item !== id)),
                      },
                    ])
                  }
                >
                  <Icon name="star" />
                  <span className="ellipsis">{id.slice(id.lastIndexOf('/') + 1)}</span>
                </button>
              ))}
            </>
          ) : null}

          {allFiles === false ? (
            <>
              <div className="sidebar__section">Storage</div>
              <button type="button" className="nav-item" onClick={askForAllFiles}>
                <Icon name="shield" />
                <span className="ellipsis">Allow full access…</span>
              </button>
            </>
          ) : null}

          <div className="sidebar__section">Add</div>
          <button
            type="button"
            className="nav-item"
            onClick={() =>
              void bridge()
                .pickFiles({ multiple: true })
                .then((entries) => {
                  if (entries.length > 0) {
                    selection.select(entries);
                    toast(`Added ${formatCount(entries.length, 'file')}`);
                  }
                })
            }
          >
            <Icon name="file" />
            Choose files…
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={() =>
              void bridge()
                .pickFolder()
                .then((root) => {
                  if (root) {
                    selection.select([root.entry]);
                    picker.navigate(root.entry);
                  }
                })
            }
          >
            <Icon name="folder-open" />
            Choose folder…
          </button>
        </nav>

        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
          {picker.loading ? (
            <div style={{ padding: 40, display: 'grid', placeItems: 'center' }}>
              <Spinner large />
            </div>
          ) : picker.error ? (
            <StatusPage icon="warning" title="Cannot open this folder" description={picker.error} />
          ) : needsMediaAccess ? (
            <StatusPage
              icon="image"
              title="Allow access to your media"
              description="Android keeps photos, videos and music behind a permission. Until it is granted these shortcuts stay empty - you can still browse folders and send anything from them."
            >
              <Button variant="suggested" icon="shield" onClick={askForMediaAccess}>
                Allow access
              </Button>
            </StatusPage>
          ) : picker.visible.length === 0 ? (
            <StatusPage
              icon="folder-open"
              title={search || activeFilterCount > 0 ? 'Nothing matches' : 'This folder is empty'}
              description={
                picker.hiddenByFilter > 0
                  ? `${formatCount(picker.hiddenByFilter, 'item')} hidden by the current filters`
                  : undefined
              }
            >
              {picker.hiddenByFilter > 0 ? (
                <Button onClick={() => setShowFilters(true)}>Adjust filters</Button>
              ) : null}
            </StatusPage>
          ) : view === 'grid' ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(auto-fill, minmax(${thumbnailSize + 24}px, 1fr))`,
                gap: 10,
                padding: 14,
              }}
            >
              {picker.visible.map((entry, index) => {
                const state = stateOf(entry);
                return (
                  <div
                    key={entry.id}
                    role="button"
                    tabIndex={0}
                    onClick={(event) => handleRowClick(entry, index, event)}
                    onDoubleClick={() => entry.kind === 'directory' && picker.navigate(entry)}
                    onContextMenu={(event) => openMenu(event, contextItems(entry))}
                    onKeyDown={(event) => {
                      if (event.key === ' ' || event.key === 'Enter') {
                        event.preventDefault();
                        selection.toggle(entry);
                      }
                    }}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 7,
                      padding: 11,
                      border: '1px solid',
                      borderColor: state === 'unchecked' ? 'var(--border-subtle)' : 'var(--accent-bg)',
                      background: state === 'unchecked' ? 'var(--card-bg)' : 'color-mix(in srgb, var(--accent-bg) 12%, var(--card-bg))',
                      borderRadius: 'var(--radius-lg)',
                      cursor: 'default',
                    }}
                  >
                    <span style={{ position: 'absolute', top: 7, left: 7 }}>
                      <Check state={state} onChange={() => selection.toggle(entry)} label={entry.name} />
                    </span>
                    <Thumb
                      entry={entry}
                      size={thumbnailSize}
                      enabled={showThumbnails}
                      onPlay={setPlaying}
                    />
                    <span className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600, width: '100%', textAlign: 'center' }}>
                      {entry.name}
                    </span>
                    <span className="caption">
                      {entry.kind === 'directory' ? 'Folder' : formatBytes(entry.size)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : view === 'tree' ? (
            <div className="boxed-list" style={{ margin: 14, borderRadius: 'var(--radius-lg)' }}>
              {picker.visible.map((entry) => (
                <TreeNode
                  key={entry.id}
                  entry={entry}
                  depth={0}
                  includeHidden={filter.includeHidden}
                  stateOf={stateOf}
                  onToggle={selection.toggle}
                  onOpen={picker.navigate}
                />
              ))}
            </div>
          ) : (
            <div className="boxed-list" style={{ margin: 14 }}>
              {picker.visible.map((entry, index) => (
                <Row
                  key={entry.id}
                  title={entry.name}
                  subtitle={
                    entry.kind === 'directory'
                      ? measured[entry.id]
                        ? `${formatCount(measured[entry.id]!.files, 'file')} · ${formatBytes(measured[entry.id]!.bytes)}`
                        : 'Folder'
                      : `${formatBytes(entry.size)} · ${formatRelativeTime(entry.mtime)}`
                  }
                  selected={index === cursor}
                  activatable
                  prefix={
                    <>
                      <Check state={stateOf(entry)} onChange={() => selection.toggle(entry)} label={entry.name} />
                      <span className="row__icon" style={{ width: 32 }}>
                        <Thumb entry={entry} size={28} enabled={showThumbnails} />
                      </span>
                    </>
                  }
                  suffix={
                    entry.kind === 'directory' ? (
                      <Button
                        size="small"
                        variant="flat"
                        circular
                        icon="chevron-right"
                        title={`Open ${entry.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          picker.navigate(entry);
                        }}
                      />
                    ) : isPlayable(entry) ? (
                      <Button
                        size="small"
                        variant="flat"
                        circular
                        icon="play"
                        title={`Play ${entry.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setPlaying(entry);
                        }}
                      />
                    ) : entry.isSymlink ? (
                      <Badge icon="link">link</Badge>
                    ) : undefined
                  }
                  onClick={(event) => handleRowClick(entry, index, event)}
                  onDoubleClick={() => entry.kind === 'directory' && picker.navigate(entry)}
                  onContextMenu={(event) => openMenu(event, contextItems(entry))}
                />
              ))}
            </div>
          )}

          {picker.hiddenByFilter > 0 && picker.visible.length > 0 ? (
            <p className="caption" style={{ padding: '0 18px 18px' }}>
              {formatCount(picker.hiddenByFilter, 'item')} hidden by filters
            </p>
          ) : null}
        </div>
      </div>

      {/* Selection tray -------------------------------------------------- */}
      {selectedRoots.length > 0 ? (
        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--headerbar-bg)',
            boxShadow: '0 -1px 0 var(--headerbar-border)',
          }}
        >
          {trayOpen ? (
            <div style={{ maxHeight: 240, overflowY: 'auto', padding: '10px 14px 0' }}>
              <div className="boxed-list">
                {selectedRoots.map((node) => {
                  const info = measured[node.entry.id];
                  return (
                    <Row
                      key={node.key}
                      title={node.entry.name}
                      subtitle={
                        node.entry.kind === 'directory'
                          ? info
                            ? `${formatCount(info.files, 'file')} · ${formatBytes(info.bytes)}`
                            : 'Measuring…'
                          : formatBytes(node.entry.size)
                      }
                      icon={iconFor(node.entry)}
                      suffix={
                        <Button
                          size="small"
                          variant="flat"
                          circular
                          icon="close"
                          title={`Remove ${node.entry.name}`}
                          onClick={() => selection.model.deselect(node.entry)}
                        />
                      }
                    />
                  );
                })}
              </div>
              {selection.model.exclusions().length > 0 ? (
                <p className="caption" style={{ padding: '8px 2px 0' }}>
                  {formatCount(selection.model.exclusions().length, 'item')} excluded from the folders above
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="hbox hbox--sm" style={{ padding: '10px 14px', gap: 10 }}>
            <Button
              variant="flat"
              icon={trayOpen ? 'chevron-down' : 'chevron-up'}
              onClick={() => setTrayOpen(!trayOpen)}
            >
              {formatCount(tally.roots, 'item')}
            </Button>
            <div className="stack" style={{ minWidth: 0, flex: 1 }}>
              <strong style={{ fontSize: 13.5 }}>
                {tally.unknownFolders > 0
                  ? `${formatCount(tally.files, 'file')} and counting…`
                  : formatCount(tally.files, 'file')}
              </strong>
              <span className="caption">
                {formatBytes(tally.bytes)}
                {tally.unknownFolders > 0 ? ` · measuring ${tally.unknownFolders} folder(s)` : ''}
              </span>
            </div>
            <Button variant="flat" onClick={() => { selection.clear(); setMeasured({}); }}>
              Clear
            </Button>
            <Button variant="suggested" icon="send" pill disabled={sending} onClick={startSend}>
              {sending ? 'Preparing…' : 'Send'}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Dialogs --------------------------------------------------------- */}
      {showFilters ? (
        <FilterSheet filter={filter} onChange={onFilterChange} onClose={() => setShowFilters(false)} />
      ) : null}

      {peerDialog ? (
        <Dialog
          title="Send to"
          description={`${formatCount(tally.files, 'file')} · ${formatBytes(tally.bytes)}`}
          onClose={() => setPeerDialog(false)}
          actions={
            <Button variant="flat" onClick={() => setPeerDialog(false)}>
              Cancel
            </Button>
          }
        >
          <div className="boxed-list">
            {peers.map((peer) => (
              <Row
                key={peer.id}
                title={peer.name}
                subtitle={`${peer.address}${peer.via ? ` · ${peer.via}` : ''}`}
                icon={iconForPlatform(peer.platform)}
                activatable
                onClick={() => void send(peer)}
                suffix={<Icon name="chevron-right" />}
              />
            ))}
          </div>
        </Dialog>
      ) : null}

      {scan ? (
        <div style={{ position: 'fixed', bottom: 90, left: '50%', transform: 'translateX(-50%)', width: 280 }}>
          <div className="toast">
            <Spinner />
            <span style={{ flex: 1 }}>Calculating size…</span>
          </div>
        </div>
      ) : null}

      {playing ? <MediaPreview entry={playing} onClose={() => setPlaying(null)} /> : null}

      {sending ? <ProgressBar value={0} total={1} indeterminate /> : null}
      {menu}
    </>
  );
}
