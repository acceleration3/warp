import { contextBridge, ipcRenderer } from 'electron';

import type {
  AppSettings,
  AppState,
  DeviceInfo,
  FsEntry,
  FsRoot,
  ListOptions,
  Peer,
  ResolveSummary,
  ScanProgress,
  SelectionPayload,
  ShareBridge,
} from '@share/core';

/** Extra desktop-only calls the GNOME-style header bar needs. */
export interface DesktopBridge extends ShareBridge {
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
  };
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge: DesktopBridge = {
  platform: 'desktop',

  getState: () => ipcRenderer.invoke('state:get') as Promise<AppState>,
  onState: (listener) => subscribe<AppState>('state', listener),
  onScanProgress: (listener) => subscribe<ScanProgress>('scan', listener),
  onText: (listener) => subscribe<{ text: string; from?: DeviceInfo }>('text', listener),

  refreshPeers: () => ipcRenderer.invoke('peers:refresh') as Promise<void>,
  addManualPeer: (host, port) => ipcRenderer.invoke('peers:add', host, port) as Promise<Peer | null>,
  removePeer: (peerId) => ipcRenderer.invoke('peers:remove', peerId) as Promise<void>,

  roots: () => ipcRenderer.invoke('fs:roots') as Promise<FsRoot[]>,
  list: (directoryId: string, options?: ListOptions) =>
    // AbortSignal cannot cross IPC; strip it and let the main side own cancellation.
    ipcRenderer.invoke('fs:list', directoryId, {
      includeHidden: options?.includeHidden ?? false,
    }) as Promise<FsEntry[]>,
  stat: (id) => ipcRenderer.invoke('fs:stat', id) as Promise<FsEntry | null>,
  parentOf: (id) => ipcRenderer.invoke('fs:parent', id) as Promise<FsEntry | null>,
  measure: (id) => ipcRenderer.invoke('fs:measure', id) as Promise<{ files: number; bytes: number }>,
  resolveSelection: (payload: SelectionPayload) =>
    ipcRenderer.invoke('fs:resolve', payload) as Promise<ResolveSummary>,
  cancelScan: () => ipcRenderer.invoke('fs:cancelScan') as Promise<void>,
  pickFiles: () => ipcRenderer.invoke('fs:pickFiles') as Promise<FsEntry[]>,
  pickFolder: () => ipcRenderer.invoke('fs:pickFolder') as Promise<FsRoot | null>,
  thumbnailUrl: (entry) => ipcRenderer.invoke('fs:thumb', entry.id) as Promise<string | null>,
  mediaUrl: (entry) => ipcRenderer.invoke('fs:media', entry.id) as Promise<string | null>,
  openPath: (id) => ipcRenderer.invoke('fs:open', id) as Promise<void>,
  revealPath: (id) => ipcRenderer.invoke('fs:reveal', id) as Promise<void>,

  send: (peerId, payload, label) =>
    ipcRenderer.invoke('transfer:send', peerId, payload, label) as Promise<string>,
  sendText: (peerId, text) => ipcRenderer.invoke('transfer:text', peerId, text) as Promise<void>,
  acceptTransfer: (id, destination) =>
    ipcRenderer.invoke('transfer:accept', id, destination) as Promise<void>,
  declineTransfer: (id) => ipcRenderer.invoke('transfer:decline', id) as Promise<void>,

  pauseTransfer: (id) => ipcRenderer.invoke('queue:pause', id) as Promise<void>,
  resumeTransfer: (id) => ipcRenderer.invoke('queue:resume', id) as Promise<void>,
  cancelTransfer: (id) => ipcRenderer.invoke('queue:cancel', id) as Promise<void>,
  retryTransfer: (id) => ipcRenderer.invoke('queue:retry', id) as Promise<void>,
  removeTransfer: (id) => ipcRenderer.invoke('queue:remove', id) as Promise<void>,
  removeQueuedFile: (transferId, fileId) =>
    ipcRenderer.invoke('queue:removeFile', transferId, fileId) as Promise<boolean>,
  moveTransfer: (id, direction) => ipcRenderer.invoke('queue:move', id, direction) as Promise<void>,
  pauseAll: () => ipcRenderer.invoke('queue:pauseAll') as Promise<void>,
  resumeAll: () => ipcRenderer.invoke('queue:resumeAll') as Promise<void>,
  cancelAll: () => ipcRenderer.invoke('queue:cancelAll') as Promise<void>,
  clearFinished: () => ipcRenderer.invoke('queue:clearFinished') as Promise<void>,
  clearTransfer: (id) => ipcRenderer.invoke('queue:clear', id) as Promise<void>,

  updateSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.invoke('settings:update', patch) as Promise<AppSettings>,
  chooseDownloadDirectory: () =>
    ipcRenderer.invoke('settings:chooseDownloadDir') as Promise<string | null>,

  window: {
    minimize: () => void ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => void ipcRenderer.invoke('window:toggleMaximize'),
    close: () => void ipcRenderer.invoke('window:close'),
  },
};

contextBridge.exposeInMainWorld('shareBridge', bridge);
