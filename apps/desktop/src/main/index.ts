import { app, BrowserWindow, dialog, ipcMain, Notification, protocol, shell } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  PROTOCOL_VERSION,
  SelectionModel,
  formatBytes,
  isFinishedState,
  mergeSettings,
  resolveSelection,
  type AppSettings,
  type AppState,
  type DeviceInfo,
  type FsEntry,
  type Peer,
  type ResolveSummary,
  type ScanProgress,
  type SelectionPayload,
  type TransferSummary,
} from '@share/core';

import { Readable } from 'node:stream';

import { DiscoveryService, listInterfaces } from './discovery.js';
import { parseRange, rangeLength } from './range.js';
import { NodeFsProvider, mimeFor } from './fsProvider.js';
import { TransferServer, type IncomingTransfer } from './server.js';
import { TransferSender } from './sender.js';

const MEDIA_SCHEME = 'share-media';

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

// ---------------------------------------------------------------------------
// Persistent identity + settings
// ---------------------------------------------------------------------------

interface StoredIdentity {
  id: string;
}

function defaultDeviceName(): string {
  const host = os.hostname().replace(/\.local$/, '');
  return host || `${os.userInfo().username}'s PC`;
}

function platformName(): DeviceInfo['platform'] {
  switch (process.platform) {
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    default:
      return 'unknown';
  }
}

class Store {
  private readonly file: string;
  private readonly identityFile: string;
  settings: AppSettings;
  identity: StoredIdentity;

  constructor(directory: string) {
    this.file = path.join(directory, 'settings.json');
    this.identityFile = path.join(directory, 'identity.json');
    this.identity = this.loadIdentity();
    this.settings = this.loadSettings();
  }

  private loadIdentity(): StoredIdentity {
    try {
      return JSON.parse(fs.readFileSync(this.identityFile, 'utf8')) as StoredIdentity;
    } catch {
      const identity = { id: crypto.randomUUID() };
      fs.mkdirSync(path.dirname(this.identityFile), { recursive: true });
      fs.writeFileSync(this.identityFile, JSON.stringify(identity, null, 2));
      return identity;
    }
  }

  private loadSettings(): AppSettings {
    let stored: unknown = null;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run */
    }
    const settings = mergeSettings(stored, defaultDeviceName());
    if (!settings.downloadDirectory) {
      settings.downloadDirectory = path.join(app.getPath('downloads'), 'Shared');
    }
    return settings;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Application wiring
// ---------------------------------------------------------------------------

let store: Store;
let discovery: DiscoveryService;
let server: TransferServer;
let sender: TransferSender;
let window: BrowserWindow | null = null;
const provider = new NodeFsProvider();
let scanController: AbortController | null = null;
let networkError: string | undefined;
let firewall: 'ufw' | 'firewalld' | undefined;

/**
 * Notes whether a host firewall is running.
 *
 * Only the service state is checked, because reading the rules needs root.
 * That is enough: the UI mentions it only when no peers have been found, where
 * it is the single most likely explanation.
 */
async function detectFirewall(): Promise<void> {
  if (process.platform !== 'linux') return;
  for (const service of ['ufw', 'firewalld'] as const) {
    const active = await new Promise<boolean>((resolve) => {
      execFile('systemctl', ['is-active', service], (_error, stdout) => {
        resolve(stdout.trim() === 'active');
      });
    });
    if (active) {
      firewall = service;
      return;
    }
  }
}

/**
 * Re-attaches manually added peers over HTTP.
 *
 * A UDP probe is useless here: the reason a peer was added by hand is that
 * broadcast does not reach it. Entries are stored as "host" or "host:port".
 */
async function reconnectManualPeers(): Promise<void> {
  for (const entry of store.settings.discovery.manualPeers) {
    const [host, port] = entry.split(':');
    if (!host) continue;
    const target = port ? Number(port) : store.settings.discovery.httpPort;
    discovery.probe(host);
    const info = await TransferSender.probe(host, target);
    if (!info) {
      discovery.forgetManualAddress(host);
      continue;
    }
    discovery.addManualPeer({ ...info, address: host, lastSeen: Date.now(), manual: true });
  }
  pushState(true);
}

function selfDevice(): DeviceInfo {
  return {
    id: store.identity.id,
    name: store.settings.deviceName,
    platform: platformName(),
    deviceType: 'desktop',
    port: server?.port || store.settings.discovery.httpPort,
    protocol: PROTOCOL_VERSION,
    appVersion: app.getVersion(),
  };
}

function incomingSummary(transfer: IncomingTransfer): TransferSummary {
  const files = [...transfer.files.values()];
  const totalBytes = transfer.offer.totalBytes;
  return {
    id: transfer.id,
    direction: 'incoming',
    peer: {
      id: transfer.from.id,
      name: transfer.from.name,
      address: transfer.fromAddress,
      platform: transfer.from.platform,
    },
    label: transfer.offer.label,
    state: transfer.state,
    totalBytes,
    totalFiles: files.length,
    bytesTransferred: transfer.bytesReceived,
    filesCompleted: transfer.filesReceived,
    bytesPerSecond: 0,
    etaSeconds: null,
    activeConnections: 0,
    activeFiles: [],
    startedAt: transfer.startedAt,
    finishedAt: transfer.finishedAt,
    error: transfer.error,
    savedTo: transfer.destination,
    files: transfer.offer.files,
    fileProgress: files.map((file) => ({
      fileId: file.offered.id,
      path: file.relativePath,
      size: file.offered.size,
      transferred: file.ranges.size(),
      state: file.done ? 'done' : file.error ? 'failed' : file.ranges.size() > 0 ? 'active' : 'queued',
    })),
    // Lets the card offer Resume. Only meaningful while bytes can still arrive.
    queue:
      transfer.paused && (transfer.state === 'accepted' || transfer.state === 'sending')
        ? { state: 'paused', position: -1, attempts: 0 }
        : undefined,
  };
}

function outgoingSummary(transfer: ReturnType<TransferSender['list']>[number]): TransferSummary {
  const job = sender.jobOf(transfer.id);
  return {
    id: transfer.id,
    direction: 'outgoing',
    peer: {
      id: transfer.peer.id,
      name: transfer.peer.name,
      address: transfer.peer.address,
      platform: transfer.peer.platform,
    },
    label: transfer.label,
    state: transfer.state,
    totalBytes: transfer.totalBytes,
    totalFiles: transfer.files.filter((file) => !file.removed).length,
    bytesTransferred: transfer.progress.bytesTransferred,
    filesCompleted: transfer.progress.filesCompleted,
    bytesPerSecond: transfer.progress.bytesPerSecond,
    etaSeconds: transfer.progress.etaSeconds,
    activeConnections: transfer.progress.activeConnections,
    activeFiles: transfer.progress.activeFiles,
    startedAt: transfer.startedAt,
    finishedAt: transfer.finishedAt,
    error: transfer.error,
    savedTo: transfer.savedTo,
    fileProgress: transfer.files.map((file) => ({
      fileId: file.id,
      path: file.path,
      size: file.size,
      transferred: file.transferred,
      state: file.removed ? 'removed' : file.done ? 'done' : file.transferred > 0 ? 'active' : 'queued',
    })),
    queue: job
      ? {
          state: job.state,
          position: sender.queue.positionOf(transfer.id),
          attempts: job.attempts,
          maxAttempts: sender.queue.retryLimit,
          retryAt: job.retryAt,
        }
      : undefined,
    chunkRetries: transfer.progress.chunkRetries,
  };
}

function buildState(): AppState {
  const stats = sender.queue.stats();
  return {
    self: selfDevice(),
    peers: discovery.list(),
    transfers: [
      ...sender.list().map(outgoingSummary),
      ...server.list().map(incomingSummary),
    ].sort((a, b) => b.startedAt - a.startedAt),
    queue: {
      ...stats,
      pausedGlobally: sender.queue.paused,
      concurrency: sender.queue.concurrency,
    },
    settings: store.settings,
    interfaces: listInterfaces().map((iface) => ({
      name: iface.name,
      address: iface.address,
      overlay: iface.overlay,
    })),
    networkError,
    firewall,
  };
}

let pushTimer: NodeJS.Timeout | null = null;
function pushState(immediate = false): void {
  if (!window || window.isDestroyed()) return;
  if (immediate) {
    window.webContents.send('state', buildState());
    return;
  }
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (window && !window.isDestroyed()) window.webContents.send('state', buildState());
  }, 120);
}

function notify(title: string, body: string): void {
  if (!store.settings.notifications) return;
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
}

/** Rebuilds a SelectionModel from the renderer's payload and walks it. */
async function resolvePayload(payload: SelectionPayload): Promise<ResolveSummary> {
  scanController?.abort();
  const controller = new AbortController();
  scanController = controller;

  const model = SelectionModel.hydrate(
    payload.included.map((entry) => ({ entry, key: entry.key })),
    payload.excluded.map((entry) => ({ entry, key: entry.key })),
  );

  const result = await resolveSelection(model, provider, {
    filter: payload.filter,
    signal: controller.signal,
    onProgress: (progress: ScanProgress) => {
      if (window && !window.isDestroyed()) window.webContents.send('scan', progress);
    },
  });

  scanController = null;
  return {
    files: result.files.map((file) => ({
      id: file.entry.id,
      path: file.relativePath,
      size: file.entry.size,
      mtime: file.entry.mtime,
      source: file.entry.id,
    })),
    totalBytes: result.totalBytes,
    excluded: result.excluded,
    truncated: result.truncated,
  };
}

// ---------------------------------------------------------------------------
// IPC surface (mirrors ShareBridge)
// ---------------------------------------------------------------------------

function registerIpc(): void {
  const handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, ...args) => fn(...(args as never[])));
  };

  handle('state:get', () => buildState());

  // Discovery -------------------------------------------------------------
  handle('peers:refresh', async () => {
    discovery.announce();
    await reconnectManualPeers();
  });
  handle('peers:add', async (host: string, port?: number) => {
    const target = port ?? store.settings.discovery.httpPort;
    const info = await TransferSender.probe(host, target);
    if (!info) return null;
    const peer: Peer = { ...info, address: host, lastSeen: Date.now(), manual: true };
    discovery.addManualPeer(peer);
    // Remember the port too, or the next reconnect guesses the default.
    const remembered = `${host}:${target}`;
    if (!store.settings.discovery.manualPeers.includes(remembered)) {
      store.settings.discovery.manualPeers = store.settings.discovery.manualPeers.filter(
        (entry) => entry !== host && !entry.startsWith(`${host}:`),
      );
      store.settings.discovery.manualPeers.push(remembered);
      store.save();
    }
    pushState(true);
    return peer;
  });
  handle('peers:remove', (peerId: string) => {
    const peer = discovery.list().find((candidate) => candidate.id === peerId);
    discovery.removePeer(peerId);
    if (peer?.manual) {
      store.settings.discovery.manualPeers = store.settings.discovery.manualPeers.filter(
        (entry) => entry !== peer.address && !entry.startsWith(`${peer.address}:`),
      );
      store.save();
    }
    pushState(true);
  });

  // Filesystem ------------------------------------------------------------
  handle('fs:roots', () => provider.roots(store.settings.picker.bookmarks));
  handle('fs:list', (id: string, options: { includeHidden?: boolean }) =>
    provider.list(id, options ?? {}),
  );
  handle('fs:stat', (id: string) => provider.stat(id));
  handle('fs:parent', (id: string) => provider.parentOf(id));
  handle('fs:measure', (id: string) => provider.measure(id));
  handle('fs:resolve', (payload: SelectionPayload) => resolvePayload(payload));
  handle('fs:cancelScan', () => {
    scanController?.abort();
    scanController = null;
  });
  handle('fs:pickFiles', async () => {
    if (!window) return [];
    const result = await dialog.showOpenDialog(window, {
      title: 'Select files to send',
      properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
    });
    if (result.canceled) return [];
    const entries: FsEntry[] = [];
    for (const file of result.filePaths) {
      const entry = await provider.stat(file);
      if (entry) entries.push(entry);
    }
    return entries;
  });
  handle('fs:pickFolder', async () => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Select a folder to send',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const entry = await provider.stat(result.filePaths[0]);
    if (!entry) return null;
    return { id: entry.id, name: entry.name, kind: 'custom' as const, entry };
  });
  handle('fs:thumb', async (id: string) => {
    const entry = await provider.stat(id);
    if (!entry || entry.kind !== 'file') return null;
    if (!entry.mime?.startsWith('image/')) return null;
    if (entry.size > 64 * 1024 * 1024) return null;
    return `${MEDIA_SCHEME}://file/${encodeURIComponent(entry.id)}`;
  });
  handle('fs:media', async (id: string) => {
    const entry = await provider.stat(id);
    if (!entry || entry.kind !== 'file') return null;
    const mime = entry.mime ?? '';
    if (!mime.startsWith('video/') && !mime.startsWith('audio/') && !mime.startsWith('image/')) {
      return null;
    }
    return `${MEDIA_SCHEME}://file/${encodeURIComponent(entry.id)}`;
  });
  handle('fs:open', (id: string) => shell.openPath(id).then(() => undefined));
  handle('fs:reveal', (id: string) => {
    shell.showItemInFolder(id);
  });

  // Transfers -------------------------------------------------------------
  handle('transfer:send', async (peerId: string, payload: SelectionPayload, label: string) => {
    const peer = discovery.list().find((candidate) => candidate.id === peerId);
    if (!peer) throw new Error('that device is no longer on the network');
    const resolved = await resolvePayload(payload);
    if (resolved.files.length === 0) throw new Error('nothing to send after filtering');

    const transfer = sender.enqueue({
      self: selfDevice(),
      peer,
      label,
      settings: store.settings.transfer,
      files: resolved.files.map((file) => ({
        absolutePath: file.source,
        relativePath: file.path,
        size: file.size,
        mtime: file.mtime,
      })),
    });
    pushState(true);
    return transfer.id;
  });
  handle('transfer:text', async (peerId: string, text: string) => {
    const peer = discovery.list().find((candidate) => candidate.id === peerId);
    if (!peer) throw new Error('that device is no longer on the network');
    await sender.sendText(selfDevice(), peer, text);
  });
  handle('transfer:accept', async (id: string, destination?: string) => {
    await server.accept(id, destination);
    pushState(true);
  });
  handle('transfer:decline', (id: string) => {
    server.decline(id);
    pushState(true);
  });

  // Queue -----------------------------------------------------------------
  // Incoming transfers are not in the send queue; the server holds them.
  handle('queue:pause', (id: string) => {
    if (sender.get(id)) sender.queue.pause(id);
    else server.pause(id);
    pushState(true);
  });
  handle('queue:resume', (id: string) => {
    if (sender.get(id)) sender.queue.resume(id);
    else server.resume(id);
    pushState(true);
  });
  handle('queue:cancel', (id: string) => {
    if (sender.get(id)) sender.queue.cancel(id);
    else void server.cancel(id, 'cancelled here');
    pushState(true);
  });
  handle('queue:retry', (id: string) => {
    sender.queue.retry(id);
    pushState(true);
  });
  handle('queue:remove', async (id: string) => {
    if (sender.get(id)) sender.forget(id);
    else await server.remove(id);
    pushState(true);
  });
  handle('queue:removeFile', (transferId: string, fileId: string) => {
    const removed = sender.queue.removeFileFromJob(transferId, fileId);
    pushState(true);
    return removed;
  });
  handle('queue:move', (id: string, direction: 'up' | 'down' | 'top') => {
    if (direction === 'up') sender.queue.moveUp(id);
    else if (direction === 'down') sender.queue.moveDown(id);
    else sender.queue.prioritize(id);
    pushState(true);
  });
  handle('queue:pauseAll', () => {
    sender.queue.pauseAll();
    for (const transfer of server.list()) server.pause(transfer.id);
    pushState(true);
  });
  handle('queue:resumeAll', () => {
    sender.queue.resumeAll();
    for (const transfer of server.list()) server.resume(transfer.id);
    pushState(true);
  });
  handle('queue:cancelAll', () => {
    sender.queue.cancelAll();
    pushState(true);
  });
  handle('queue:clearFinished', () => {
    for (const transfer of sender.list()) {
      const job = sender.jobOf(transfer.id);
      if (job && isFinishedState(job.state)) sender.forget(transfer.id);
    }
    for (const transfer of server.list()) {
      if (['complete', 'failed', 'declined', 'cancelled'].includes(transfer.state)) {
        server.forget(transfer.id);
      }
    }
    pushState(true);
  });
  handle('queue:clear', async (id: string) => {
    if (sender.get(id)) sender.forget(id);
    else await server.remove(id);
    pushState(true);
  });

  // Settings --------------------------------------------------------------
  handle('settings:update', async (patch: Partial<AppSettings>) => {
    const previous = store.settings;
    store.settings = mergeSettings({ ...previous, ...patch }, defaultDeviceName());
    store.save();
    sender.applySettings(store.settings.transfer);
    discovery.updateOptions({
      broadcast: store.settings.discovery.broadcast,
      multicast: store.settings.discovery.multicast,
      interfaces: store.settings.discovery.interfaces,
    });
    if (patch.deviceName) discovery.announce();
    pushState(true);
    return store.settings;
  });
  handle('settings:chooseDownloadDir', async () => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose where received files are saved',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: store.settings.downloadDirectory,
    });
    if (result.canceled || !result.filePaths[0]) return null;
    store.settings.downloadDirectory = result.filePaths[0];
    store.save();
    pushState(true);
    return result.filePaths[0];
  });

  // Window controls (the UI draws its own GNOME-style header bar).
  handle('window:minimize', () => window?.minimize());
  handle('window:toggleMaximize', () => {
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  handle('window:close', () => window?.close());
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 400,
    minHeight: 560,
    backgroundColor: '#fafafa',
    show: false,
    autoHideMenuBar: true,
    // GNOME apps use client-side decorations; the renderer draws the header bar.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once('ready-to-show', () => window?.show());
  window.on('maximize', () => pushState(true));
  window.on('unmaximize', () => pushState(true));

  const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html');
  await window.loadFile(indexHtml);
}

async function bootstrap(): Promise<void> {
  store = new Store(app.getPath('userData'));
  await fsp.mkdir(store.settings.downloadDirectory, { recursive: true }).catch(() => {});

  sender = new TransferSender(store.settings.transfer);
  sender.on('update', () => pushState(true));
  sender.on('progress', () => pushState());
  sender.on('queue', () => pushState());

  server = new TransferServer({
    self: selfDevice,
    downloadDirectory: () => store.settings.downloadDirectory,
    groupBySender: () => store.settings.groupBySender,
    autoAccept: (offer) =>
      !store.settings.confirmIncoming || store.settings.autoAcceptFrom.includes(offer.from.id),
    port: store.settings.discovery.httpPort,
  });

  server.on('offer', (transfer: IncomingTransfer) => {
    notify(
      `${transfer.from.name} wants to send you files`,
      `${transfer.offer.label} - ${formatBytes(transfer.offer.totalBytes)}`,
    );
    pushState(true);
  });
  server.on('update', () => pushState(true));
  server.on('progress', () => pushState());
  server.on('text', (payload: { text: string; from?: DeviceInfo }) => {
    if (window && !window.isDestroyed()) window.webContents.send('text', payload);
    notify(`Text from ${payload.from?.name ?? 'a device'}`, payload.text.slice(0, 120));
  });

  try {
    await server.start();
  } catch (error) {
    networkError = error instanceof Error ? error.message : String(error);
  }

  discovery = new DiscoveryService({
    self: selfDevice,
    broadcast: store.settings.discovery.broadcast,
    multicast: store.settings.discovery.multicast,
    interfaces: store.settings.discovery.interfaces,
  });
  discovery.on('peers', () => pushState(true));
  discovery.on('error', (error: Error) => {
    networkError = `discovery: ${error.message}`;
    pushState(true);
  });

  try {
    await discovery.start();
  } catch (error) {
    networkError = `discovery could not start: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  void reconnectManualPeers();
  void detectFirewall().then(() => pushState(true));
}

app.whenReady().then(async () => {
  /*
   * Serves local media to the renderer without handing it the filesystem.
   *
   * Range support is what makes a <video> seekable: without a 206 the element
   * has to buffer from the start for every scrub, and long files never seek at
   * all. The whole file is never read into memory - each request streams only
   * the slice that was asked for.
   */
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const target = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const stats = await fsp.stat(target);
      if (!stats.isFile()) return new Response('not a file', { status: 403 });

      const type = mimeFor(path.basename(target)) ?? 'application/octet-stream';
      const wanted = parseRange(stats.size, request.headers.get('Range'));

      if (wanted.kind === 'unsatisfiable') {
        return new Response('bad range', {
          status: 416,
          headers: { 'content-range': `bytes */${stats.size}` },
        });
      }

      if (wanted.kind === 'full') {
        return new Response(Readable.toWeb(fs.createReadStream(target)) as ReadableStream, {
          status: 200,
          headers: {
            'content-type': type,
            'content-length': String(stats.size),
            'accept-ranges': 'bytes',
          },
        });
      }

      const { start, end } = wanted.range;
      const stream = fs.createReadStream(target, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          'content-type': type,
          'content-length': String(rangeLength(wanted.range)),
          'content-range': `bytes ${start}-${end}/${stats.size}`,
          'accept-ranges': 'bytes',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  await bootstrap();
  registerIpc();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await discovery?.stop();
  await server?.stop();
});
