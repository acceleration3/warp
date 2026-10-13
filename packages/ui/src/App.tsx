import { useEffect, useMemo, useState } from 'react';

import { formatBytes, formatCount, type FilterRules, type SortRules } from '@share/core';

import { bridge, isMock } from './bridge';
import { Badge, Banner, Button, Dialog, Row, Spinner, ToastProvider, useToast } from './components';
import { Icon, iconForPlatform, type IconName } from './icons';
import { useAppState, useNarrow, useSettings, useTheme } from './store';
import { DevicesView } from './views/DevicesView';
import { QueueView } from './views/QueueView';
import { SettingsView } from './views/SettingsView';
import { PickerView } from './views/picker/PickerView';

type Page = 'devices' | 'send' | 'queue' | 'settings';

const PAGES: Array<{ id: Page; label: string; icon: IconName }> = [
  { id: 'devices', label: 'Devices', icon: 'network' },
  { id: 'send', label: 'Send files', icon: 'folder-open' },
  { id: 'queue', label: 'Transfers', icon: 'send' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

const PAGE_SUBTITLES: Record<Page, string> = {
  devices: 'Everyone reachable right now',
  send: 'Pick files or whole folders',
  queue: 'Pause, reorder, remove',
  settings: 'Tune speed and behaviour',
};

function WindowControls(): React.ReactElement | null {
  const controls = bridge().window;
  if (!controls) return null;
  return (
    <div className="window-controls">
      <button type="button" onClick={() => controls.minimize()} aria-label="Minimize">
        <Icon name="window-min" size={12} />
      </button>
      <button type="button" onClick={() => controls.toggleMaximize()} aria-label="Maximize">
        <Icon name="window-max" size={11} />
      </button>
      <button type="button" className="close" onClick={() => controls.close()} aria-label="Close">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function Shell(): React.ReactElement {
  const state = useAppState();
  const [page, setPage] = useState<Page>('devices');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [incomingText, setIncomingText] = useState<{ text: string; from?: string } | null>(null);
  const narrow = useNarrow();
  const toast = useToast();
  const { settings, update } = useSettings(state);

  useTheme(settings.theme);

  // Text drops arrive out of band; surface them as a dismissible dialog.
  useEffect(
    () =>
      bridge().onText((payload) => {
        setIncomingText({ text: payload.text, from: payload.from?.name });
      }),
    [],
  );

  const pending = useMemo(
    () => (state?.transfers ?? []).filter((t) => t.direction === 'incoming' && t.state === 'pending'),
    [state],
  );

  const activeCount = useMemo(
    () =>
      (state?.transfers ?? []).filter(
        (t) => !['complete', 'failed', 'cancelled', 'declined'].includes(t.state),
      ).length,
    [state],
  );

  // An incoming offer is the one thing worth stealing focus for.
  useEffect(() => {
    if (pending.length > 0) setPage('queue');
  }, [pending.length]);

  if (!state) {
    return (
      <div className="app" style={{ placeItems: 'center', display: 'grid' }}>
        <Spinner large />
      </div>
    );
  }

  const offer = pending[0];

  const setFilter = (filter: FilterRules): void =>
    update({ picker: { ...settings.picker, filter } });
  const setSort = (sort: SortRules): void => update({ picker: { ...settings.picker, sort } });

  return (
    <div className="app">
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="headerbar" style={{ background: 'transparent', boxShadow: 'none' }}>
          <strong style={{ padding: '0 8px', fontSize: 15, letterSpacing: '-0.2px' }}>Warp</strong>
          <div className="spacer" />
          {narrow ? (
            <Button variant="flat" circular icon="close" title="Close menu" onClick={() => setSidebarOpen(false)} />
          ) : null}
        </div>
        <div className="sidebar__scroll">
          {PAGES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${page === item.id ? 'is-active' : ''}`}
              onClick={() => {
                setPage(item.id);
                setSidebarOpen(false);
              }}
            >
              <Icon name={item.icon} />
              {item.label}
              {item.id === 'devices' && state.peers.length > 0 ? (
                <span className="nav-item__count">{state.peers.length}</span>
              ) : null}
              {item.id === 'queue' && activeCount > 0 ? (
                <span className="nav-item__count">{activeCount}</span>
              ) : null}
            </button>
          ))}

          <div className="sidebar__section">Status</div>
          <div style={{ padding: '2px 10px 10px' }} className="stack stack--sm">
            <div className="hbox hbox--sm">
              <Icon name={iconForPlatform(state.self.platform)} size={14} />
              <span className="caption ellipsis">{state.self.name}</span>
            </div>
            <div className="hbox hbox--sm">
              <Icon name="network" size={14} />
              <span className="caption ellipsis">
                {state.interfaces[0]?.address ?? 'offline'}:{state.self.port}
              </span>
            </div>
            {state.queue.running > 0 ? (
              <Badge tone="accent" icon="bolt">
                {formatCount(state.queue.running, 'transfer')} running
              </Badge>
            ) : null}
            {state.queue.pausedGlobally ? <Badge tone="warning">Queue paused</Badge> : null}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="headerbar">
          <div className="headerbar__start">
            {narrow ? (
              <Button variant="flat" circular icon="sidebar" title="Menu" onClick={() => setSidebarOpen(true)} />
            ) : null}
          </div>
          <div className="headerbar__title">
            <strong>{PAGES.find((item) => item.id === page)?.label}</strong>
            <span>{PAGE_SUBTITLES[page]}</span>
          </div>
          <div className="headerbar__end">
            {page !== 'send' ? (
              <Button variant="suggested" pill icon="plus" onClick={() => setPage('send')}>
                {narrow ? undefined : 'Send'}
              </Button>
            ) : null}
            <WindowControls />
          </div>
        </header>

        {state.networkError ? (
          <Banner
            tone="error"
            action={
              <Button size="small" onClick={() => void bridge().refreshPeers()}>
                Retry
              </Button>
            }
          >
            {state.networkError}
          </Banner>
        ) : null}

        {isMock() ? (
          <Banner>Preview mode - no native bridge, so nothing is actually sent.</Banner>
        ) : null}

        {page === 'send' ? (
          <div className="main" style={{ minHeight: 0 }}>
            <PickerView
              peers={state.peers}
              filter={settings.picker.filter}
              sort={settings.picker.sort}
              bookmarks={settings.picker.bookmarks}
              thumbnailSize={settings.picker.thumbnailSize}
              showThumbnails={settings.picker.showThumbnails}
              onFilterChange={setFilter}
              onSortChange={setSort}
              onBookmarksChange={(bookmarks) => update({ picker: { ...settings.picker, bookmarks } })}
              onThumbnailSizeChange={(thumbnailSize) =>
                update({ picker: { ...settings.picker, thumbnailSize } })
              }
              onShowThumbnailsChange={(showThumbnails) =>
                update({ picker: { ...settings.picker, showThumbnails } })
              }
              onSent={() => setPage('queue')}
            />
          </div>
        ) : (
          <div className="content">
            {page === 'devices' ? <DevicesView state={state} onPick={() => setPage('send')} /> : null}
            {page === 'queue' ? <QueueView state={state} /> : null}
            {page === 'settings' ? <SettingsView state={state} /> : null}
          </div>
        )}
      </main>

      {/* Incoming offer ------------------------------------------------- */}
      {offer ? (
        <Dialog
          title={`${offer.peer.name} wants to send you files`}
          description={`${formatCount(offer.totalFiles, 'file')} · ${formatBytes(offer.totalBytes)}`}
          onClose={() => void bridge().declineTransfer(offer.id)}
          actions={
            <>
              <Button variant="flat" onClick={() => void bridge().declineTransfer(offer.id)}>
                Decline
              </Button>
              <Button variant="suggested" icon="download" onClick={() => void bridge().acceptTransfer(offer.id)}>
                Accept
              </Button>
            </>
          }
        >
          <div className="boxed-list" style={{ maxHeight: 240, overflowY: 'auto' }}>
            {(offer.files ?? []).slice(0, 40).map((file) => (
              <Row key={file.id} title={file.path} subtitle={formatBytes(file.size)} icon="file" />
            ))}
            {(offer.files?.length ?? 0) > 40 ? (
              <Row title={`and ${formatCount((offer.files?.length ?? 0) - 40, 'more file')}`} icon="more" />
            ) : null}
          </div>
          <p className="caption" style={{ marginTop: 10 }}>
            Saving to <span className="monospace">{settings.downloadDirectory}</span>
            {settings.groupBySender ? ` / ${offer.peer.name}` : ''}
          </p>
        </Dialog>
      ) : null}

      {/* Text drop ------------------------------------------------------- */}
      {incomingText ? (
        <Dialog
          title={`Text from ${incomingText.from ?? 'a device'}`}
          onClose={() => setIncomingText(null)}
          actions={
            <>
              <Button variant="flat" onClick={() => setIncomingText(null)}>
                Close
              </Button>
              <Button
                variant="suggested"
                icon="link"
                onClick={() => {
                  void navigator.clipboard?.writeText(incomingText.text);
                  toast('Copied to clipboard');
                  setIncomingText(null);
                }}
              >
                Copy
              </Button>
            </>
          }
        >
          <pre
            className="monospace"
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              padding: 12,
              background: 'var(--view-bg)',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border-subtle)',
              maxHeight: 300,
              overflow: 'auto',
            }}
          >
            {incomingText.text}
          </pre>
        </Dialog>
      ) : null}
    </div>
  );
}

export function App(): React.ReactElement {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
