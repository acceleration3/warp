import { useEffect, useState } from 'react';

import {
  formatBytes,
  formatCount,
  formatDuration,
  formatSpeed,
  type AppState,
  type TransferSummary,
} from '@share/core';

import { bridge } from '../bridge';
import { Badge, Button, Group, ProgressBar, Row, StatusPage, useMenu, useToast } from '../components';
import { Icon, iconForPlatform, type IconName } from '../icons';

function stateTone(transfer: TransferSummary): 'accent' | 'success' | 'warning' | 'error' | undefined {
  if (transfer.queue?.state === 'paused') return 'warning';
  switch (transfer.state) {
    case 'complete':
      return 'success';
    case 'failed':
    case 'declined':
      return 'error';
    case 'sending':
      return 'accent';
    default:
      return undefined;
  }
}

/** Re-renders once a second while `active`, for live countdowns. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** True while an automatic retry is backing off before it starts again. */
function isRetrying(transfer: TransferSummary): boolean {
  return transfer.queue?.state === 'queued' && (transfer.queue.attempts ?? 0) > 0;
}

/** "Retry 1 of 3", or null when no automatic retry has happened. */
function retryLabel(transfer: TransferSummary): string | null {
  const queue = transfer.queue;
  if (!queue || queue.attempts <= 0) return null;
  return queue.maxAttempts ? `Retry ${queue.attempts} of ${queue.maxAttempts}` : `Retry ${queue.attempts}`;
}

function stateLabel(transfer: TransferSummary, now: number): string {
  if (transfer.queue?.state === 'paused') return 'Paused';
  if (isRetrying(transfer)) {
    const retryAt = transfer.queue?.retryAt;
    const seconds = retryAt ? Math.ceil((retryAt - now) / 1000) : 0;
    return seconds > 0 ? `Retrying in ${seconds}s` : 'Retrying';
  }
  if (transfer.queue?.state === 'queued') {
    const position = transfer.queue.position;
    return position >= 0 ? `Waiting · #${position + 1}` : 'Waiting';
  }
  switch (transfer.state) {
    case 'pending':
      return transfer.direction === 'incoming' ? 'Needs your approval' : 'Waiting for the other device';
    case 'accepted':
      return 'Starting';
    case 'sending':
      return transfer.direction === 'incoming' ? 'Receiving' : 'Sending';
    case 'complete':
      return 'Done';
    case 'declined':
      return 'Declined';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return transfer.state;
  }
}

function isActive(transfer: TransferSummary): boolean {
  // The queue is the authority for outgoing work: a transfer waiting on an
  // automatic retry still reads "failed" until its next attempt starts.
  const queueState = transfer.queue?.state;
  if (queueState === 'queued' || queueState === 'running' || queueState === 'paused') return true;
  if (queueState) return false;
  return !['complete', 'failed', 'cancelled', 'declined'].includes(transfer.state);
}

/** One transfer card: progress, live stats, queue controls and its file list. */
function TransferCard({ transfer }: { transfer: TransferSummary }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const { menu, open } = useMenu();
  const toast = useToast();

  const paused = transfer.queue?.state === 'paused';
  const queued = transfer.queue?.state === 'queued';
  const percent = transfer.totalBytes > 0 ? (transfer.bytesTransferred / transfer.totalBytes) * 100 : 0;
  const incoming = transfer.direction === 'incoming';
  const awaitingDecision = incoming && transfer.state === 'pending';
  const retrying = isRetrying(transfer);
  const now = useNow(retrying && !!transfer.queue?.retryAt);
  const retries = retryLabel(transfer);
  const chunkRetries = transfer.chunkRetries ?? 0;
  const failed = transfer.state === 'failed' && !isActive(transfer);

  const menuItems = [
    ...(transfer.savedTo
      ? [
          {
            label: 'Open destination folder',
            icon: 'folder-open' as IconName,
            onSelect: () => void bridge().openPath(transfer.savedTo!),
          },
        ]
      : []),
    ...(queued
      ? [
          { label: 'Move to front', icon: 'arrow-up' as IconName, onSelect: () => void bridge().moveTransfer(transfer.id, 'top') },
          { label: 'Move up', icon: 'chevron-up' as IconName, onSelect: () => void bridge().moveTransfer(transfer.id, 'up') },
          { label: 'Move down', icon: 'chevron-down' as IconName, onSelect: () => void bridge().moveTransfer(transfer.id, 'down') },
        ]
      : []),
    ...((transfer.state === 'failed' || transfer.state === 'cancelled') && !isActive(transfer)
      ? [{ label: 'Try again', icon: 'refresh' as IconName, onSelect: () => void bridge().retryTransfer(transfer.id) }]
      : []),
    {
      label: 'Remove from queue',
      icon: 'trash' as IconName,
      destructive: true,
      separatorBefore: true,
      onSelect: () => void bridge().removeTransfer(transfer.id),
    },
  ];

  return (
    <div
      className="boxed-list"
      style={{ marginBottom: 12, borderColor: awaitingDecision ? 'var(--accent-bg)' : undefined }}
    >
      <Row
        title={transfer.label}
        subtitle={
          <>
            {incoming ? 'From' : 'To'} {transfer.peer.name} · {formatCount(transfer.totalFiles, 'file')} ·{' '}
            {formatBytes(transfer.totalBytes)}
          </>
        }
        icon={iconForPlatform(transfer.peer.platform)}
        suffix={
          <>
            <Badge tone={retrying ? 'warning' : stateTone(transfer)}>{stateLabel(transfer, now)}</Badge>
            <Button
              size="small"
              variant="flat"
              circular
              icon="more"
              title="More actions"
              onClick={(event) => open(event, menuItems)}
            />
          </>
        }
      />

      {isActive(transfer) && !awaitingDecision ? (
        <div style={{ padding: '4px 14px 12px' }}>
          <ProgressBar
            value={transfer.bytesTransferred}
            total={transfer.totalBytes}
            variant={paused ? 'paused' : undefined}
            indeterminate={transfer.state === 'pending' && !incoming}
          />
          <div className="hbox" style={{ gap: 10, marginTop: 7, flexWrap: 'wrap' }}>
            <span className="caption numeric">
              {formatBytes(transfer.bytesTransferred)} of {formatBytes(transfer.totalBytes)} ({Math.round(percent)}%)
            </span>
            {transfer.bytesPerSecond > 0 ? (
              <span className="caption numeric">{formatSpeed(transfer.bytesPerSecond)}</span>
            ) : null}
            {transfer.etaSeconds !== null && !paused ? (
              <span className="caption numeric">{formatDuration(transfer.etaSeconds)} left</span>
            ) : null}
            {transfer.activeConnections > 0 ? (
              <span className="caption numeric">
                <Icon name="bolt" size={11} /> {transfer.activeConnections} connections
              </span>
            ) : null}
            {retries ? (
              <span className="caption numeric" title="Automatic retries of the whole transfer">
                <Icon name="refresh" size={11} /> {retries}
              </span>
            ) : null}
            {chunkRetries > 0 ? (
              <span className="caption numeric" title="Pieces re-sent after a failed attempt">
                {formatCount(chunkRetries, 'chunk retry', 'chunk retries')}
              </span>
            ) : null}
            <div className="spacer" />
            <span className="caption numeric">
              {transfer.filesCompleted}/{transfer.totalFiles} files
            </span>
          </div>
        </div>
      ) : null}

      {transfer.error ? (
        <Row
          title={
            <span style={{ color: retrying ? undefined : 'var(--destructive-text)' }}>{transfer.error}</span>
          }
          subtitle={
            failed && transfer.queue && transfer.queue.attempts > 0
              ? `Gave up after ${formatCount(transfer.queue.attempts, 'automatic retry', 'automatic retries')}`
              : undefined
          }
          icon={retrying ? 'refresh' : 'warning'}
        />
      ) : null}

      {transfer.savedTo && transfer.state === 'complete' ? (
        <Row
          title="Saved to"
          subtitle={transfer.savedTo}
          icon="folder"
          activatable
          onClick={() => void bridge().openPath(transfer.savedTo!)}
        />
      ) : null}

      {/* Action bar ------------------------------------------------------ */}
      <div className="hbox hbox--sm" style={{ padding: '8px 14px 12px', gap: 8, flexWrap: 'wrap' }}>
        {awaitingDecision ? (
          <>
            <Button variant="suggested" icon="download" onClick={() => void bridge().acceptTransfer(transfer.id)}>
              Accept
            </Button>
            <Button variant="destructive" onClick={() => void bridge().declineTransfer(transfer.id)}>
              Decline
            </Button>
          </>
        ) : null}

        {isActive(transfer) && !awaitingDecision ? (
          <>
            {paused ? (
              <Button icon="play" onClick={() => void bridge().resumeTransfer(transfer.id)}>
                Resume
              </Button>
            ) : (
              <Button icon="pause" onClick={() => void bridge().pauseTransfer(transfer.id)}>
                Pause
              </Button>
            )}
            <Button
              variant="flat"
              icon="close"
              onClick={() => {
                void bridge().cancelTransfer(transfer.id);
                toast('Transfer cancelled');
              }}
            >
              Cancel
            </Button>
          </>
        ) : null}

        {(transfer.state === 'failed' || transfer.state === 'cancelled') &&
        transfer.direction === 'outgoing' &&
        !isActive(transfer) ? (
          <Button icon="refresh" onClick={() => void bridge().retryTransfer(transfer.id)}>
            Try again
          </Button>
        ) : null}

        <div className="spacer" />

        {transfer.fileProgress && transfer.fileProgress.length > 0 ? (
          <Button
            size="small"
            variant="flat"
            icon={expanded ? 'chevron-up' : 'chevron-down'}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide files' : 'Show files'}
          </Button>
        ) : null}
      </div>

      {/* Per-file list, with individual removal ------------------------- */}
      {expanded && transfer.fileProgress ? (
        <div style={{ maxHeight: 280, overflowY: 'auto', borderTop: '1px solid var(--border-subtle)' }}>
          {transfer.fileProgress.map((file) => (
            <Row
              key={file.fileId}
              title={
                <span style={{ textDecoration: file.state === 'removed' ? 'line-through' : undefined }}>
                  {file.path}
                </span>
              }
              subtitle={
                file.state === 'removed'
                  ? 'Removed'
                  : `${formatBytes(file.transferred)} of ${formatBytes(file.size)}`
              }
              icon={file.state === 'done' ? 'check' : file.state === 'failed' ? 'warning' : 'file'}
              suffix={
                <>
                  {file.state === 'active' ? <span className="caption">sending</span> : null}
                  {transfer.direction === 'outgoing' &&
                  isActive(transfer) &&
                  file.state !== 'done' &&
                  file.state !== 'removed' ? (
                    <Button
                      size="small"
                      variant="flat"
                      circular
                      icon="close"
                      title={`Remove ${file.path} from this transfer`}
                      onClick={() => {
                        void bridge()
                          .removeQueuedFile(transfer.id, file.fileId)
                          .then((ok) => toast(ok ? `Removed ${file.path}` : 'That file is already on its way'));
                      }}
                    />
                  ) : null}
                </>
              }
            />
          ))}
        </div>
      ) : null}

      {menu}
    </div>
  );
}

export function QueueView({ state }: { state: AppState }): React.ReactElement {
  const active = state.transfers.filter((transfer) => isActive(transfer));
  const finished = state.transfers.filter((transfer) => !isActive(transfer));

  if (state.transfers.length === 0) {
    return (
      <StatusPage
        icon="send"
        title="No transfers yet"
        description="Pick files or a folder, choose a device, and they will show up here with full control over the queue."
      />
    );
  }

  return (
    <div className="content__inner">
      {active.length > 0 ? (
        <Group
          title={`Active · ${formatCount(active.length, 'transfer')}`}
          actions={
            <div className="hbox hbox--sm">
              {state.queue.pausedGlobally ? (
                <Button size="small" icon="play" onClick={() => void bridge().resumeAll()}>
                  Resume all
                </Button>
              ) : (
                <Button size="small" icon="pause" onClick={() => void bridge().pauseAll()}>
                  Pause all
                </Button>
              )}
              <Button size="small" variant="flat" icon="close" onClick={() => void bridge().cancelAll()}>
                Cancel all
              </Button>
            </div>
          }
        >
          <Row
            title={`${state.queue.running} running, ${state.queue.queued} waiting`}
            subtitle={`Up to ${state.queue.concurrency} transfer(s) at once`}
            icon="bolt"
          />
        </Group>
      ) : null}

      {active.map((transfer) => (
        <TransferCard key={transfer.id} transfer={transfer} />
      ))}

      {finished.length > 0 ? (
        <>
          <div className="hbox" style={{ margin: '18px 2px 10px' }}>
            <h2 className="group__title">Finished</h2>
            <div className="spacer" />
            <Button size="small" variant="flat" icon="trash" onClick={() => void bridge().clearFinished()}>
              Clear
            </Button>
          </div>
          {finished.map((transfer) => (
            <TransferCard key={transfer.id} transfer={transfer} />
          ))}
        </>
      ) : null}
    </div>
  );
}
