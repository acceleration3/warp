import type {
  AppSettings,
  AppState,
  FsEntry,
  FsRoot,
  ShareBridge,
} from '@share/core';
import { defaultSettings } from '@share/core';

import { createAndroidBridge, isAndroidHost, type AndroidExtras } from './bridge-android';

/** Desktop adds window controls on top of the shared contract. */
export interface DesktopExtras {
  window?: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
  };
}

export type Bridge = ShareBridge & DesktopExtras & Partial<AndroidExtras>;

/**
 * A stand-in used when the UI runs in a plain browser (vite dev server).
 * It makes the whole interface explorable without a native shell.
 */
function createMockBridge(): Bridge {
  const settings: AppSettings = defaultSettings('Mock Desktop');
  settings.downloadDirectory = '/home/you/Downloads/Shared';

  const now = Date.now();
  const dir = (path: string, name: string, childCount = 4): FsEntry => ({
    id: path,
    key: path,
    name,
    kind: 'directory',
    size: 0,
    mtime: now - 86_400_000,
    isHidden: name.startsWith('.'),
    readable: true,
    childCount,
  });
  const file = (path: string, name: string, size: number, mime?: string): FsEntry => ({
    id: path,
    key: path,
    name,
    kind: 'file',
    size,
    mtime: now - Math.random() * 86_400_000 * 30,
    mime,
    isHidden: name.startsWith('.'),
    readable: true,
  });

  const tree: Record<string, FsEntry[]> = {
    '/home/you': [
      dir('/home/you/Pictures', 'Pictures', 128),
      dir('/home/you/Documents', 'Documents', 42),
      dir('/home/you/Downloads', 'Downloads', 17),
      dir('/home/you/Music', 'Music', 9),
      dir('/home/you/.config', '.config', 60),
      file('/home/you/notes.md', 'notes.md', 4_210, 'text/markdown'),
      file('/home/you/backup.zip', 'backup.zip', 1_482_112_000, 'application/zip'),
    ],
    '/home/you/Pictures': [
      dir('/home/you/Pictures/2024', '2024', 340),
      dir('/home/you/Pictures/Screenshots', 'Screenshots', 88),
      file('/home/you/Pictures/beach.jpg', 'beach.jpg', 3_842_000, 'image/jpeg'),
      file('/home/you/Pictures/sunset.png', 'sunset.png', 5_120_000, 'image/png'),
      file('/home/you/Pictures/img10.jpg', 'img10.jpg', 2_100_000, 'image/jpeg'),
      file('/home/you/Pictures/img9.jpg', 'img9.jpg', 2_400_000, 'image/jpeg'),
    ],
    '/home/you/Pictures/2024': [
      file('/home/you/Pictures/2024/a.jpg', 'a.jpg', 4_000_000, 'image/jpeg'),
      file('/home/you/Pictures/2024/b.jpg', 'b.jpg', 4_500_000, 'image/jpeg'),
    ],
    '/home/you/Pictures/Screenshots': [
      file('/home/you/Pictures/Screenshots/shot1.png', 'shot1.png', 800_000, 'image/png'),
    ],
    '/home/you/Documents': [
      file('/home/you/Documents/taxes.pdf', 'taxes.pdf', 240_000, 'application/pdf'),
      file('/home/you/Documents/cv.docx', 'cv.docx', 82_000),
      dir('/home/you/Documents/projects', 'projects', 12),
    ],
    '/home/you/Documents/projects': [
      dir('/home/you/Documents/projects/app', 'app', 400),
      file('/home/you/Documents/projects/readme.md', 'readme.md', 2_000, 'text/markdown'),
    ],
    '/home/you/Documents/projects/app': [
      dir('/home/you/Documents/projects/app/node_modules', 'node_modules', 9000),
      file('/home/you/Documents/projects/app/index.ts', 'index.ts', 12_000),
    ],
    '/home/you/Downloads': [
      file('/home/you/Downloads/video.mkv', 'video.mkv', 8_200_000_000, 'video/x-matroska'),
      file('/home/you/Downloads/song.flac', 'song.flac', 42_000_000, 'audio/flac'),
    ],
    '/home/you/Music': [file('/home/you/Music/track.mp3', 'track.mp3', 9_000_000, 'audio/mpeg')],
    '/home/you/.config': [file('/home/you/.config/settings.json', 'settings.json', 900)],
  };

  const state: AppState = {
    self: {
      id: 'self',
      name: 'Mock Desktop',
      platform: 'linux',
      deviceType: 'desktop',
      port: 47655,
      protocol: 1,
    },
    peers: [
      {
        id: 'peer-phone',
        name: 'Pixel 8',
        platform: 'android',
        deviceType: 'phone',
        port: 47655,
        protocol: 1,
        address: '192.168.1.42',
        lastSeen: Date.now(),
        via: 'eno1',
      },
      {
        id: 'peer-remote',
        name: 'Work Laptop',
        platform: 'linux',
        deviceType: 'laptop',
        port: 47655,
        protocol: 1,
        address: '192.168.192.70',
        lastSeen: Date.now(),
        via: 'ztyqb65h7c',
      },
    ],
    transfers: [],
    queue: { queued: 0, running: 0, paused: 0, finished: 0, pausedGlobally: false, concurrency: 2 },
    settings,
    interfaces: [
      { name: 'eno1', address: '192.168.1.190', overlay: false },
      { name: 'ztyqb65h7c', address: '192.168.192.148', overlay: true },
    ],
  };

  const listeners = new Set<(state: AppState) => void>();
  const push = (): void => {
    for (const listener of listeners) listener({ ...state });
  };

  return {
    platform: 'desktop',
    getState: async () => state,
    onState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onScanProgress: () => () => {},
    onText: () => () => {},
    refreshPeers: async () => push(),
    addManualPeer: async () => null,
    removePeer: async () => {},
    roots: async (): Promise<FsRoot[]> => [
      { id: '/home/you', name: 'Home', kind: 'home', entry: dir('/home/you', 'Home') },
      { id: '/home/you/Downloads', name: 'Downloads', kind: 'downloads', entry: dir('/home/you/Downloads', 'Downloads') },
      { id: '/home/you/Pictures', name: 'Pictures', kind: 'pictures', entry: dir('/home/you/Pictures', 'Pictures') },
      { id: '/home/you/Documents', name: 'Documents', kind: 'documents', entry: dir('/home/you/Documents', 'Documents') },
      { id: '/home/you/Music', name: 'Music', kind: 'music', entry: dir('/home/you/Music', 'Music') },
    ],
    list: async (id, options) => {
      const entries = tree[id] ?? [];
      return options?.includeHidden ? entries : entries.filter((entry) => !entry.isHidden);
    },
    stat: async (id) => {
      for (const entries of Object.values(tree)) {
        const found = entries.find((entry) => entry.id === id);
        if (found) return found;
      }
      return id === '/home/you' ? dir('/home/you', 'Home') : null;
    },
    parentOf: async (id) => {
      const parent = id.slice(0, id.lastIndexOf('/')) || '/';
      return parent === id ? null : dir(parent, parent.slice(parent.lastIndexOf('/') + 1) || '/');
    },
    measure: async () => ({ files: 128, bytes: 1_200_000_000 }),
    resolveSelection: async () => ({ files: [], totalBytes: 0, excluded: 0, truncated: false }),
    cancelScan: async () => {},
    pickFiles: async () => [],
    pickFolder: async () => null,
    thumbnailUrl: async () => null,
    mediaUrl: async () => null,
    openPath: async () => {},
    revealPath: async () => {},
    send: async () => 'mock-transfer',
    sendText: async () => {},
    acceptTransfer: async () => {},
    declineTransfer: async () => {},
    pauseTransfer: async () => {},
    resumeTransfer: async () => {},
    cancelTransfer: async () => {},
    retryTransfer: async () => {},
    removeTransfer: async () => {},
    removeQueuedFile: async () => true,
    moveTransfer: async () => {},
    pauseAll: async () => {},
    resumeAll: async () => {},
    cancelAll: async () => {},
    clearFinished: async () => {},
    clearTransfer: async () => {},
    updateSettings: async (patch) => {
      Object.assign(state.settings, patch);
      push();
      return state.settings;
    },
    chooseDownloadDirectory: async () => null,
  };
}

let cached: Bridge | null = null;

/**
 * Picks the right backing for wherever the UI happens to be running:
 * Electron's preload, the Android plugin, or a mock for a bare browser.
 */
export function bridge(): Bridge {
  if (cached) return cached;
  if (window.shareBridge) cached = window.shareBridge as Bridge;
  else if (isAndroidHost()) cached = createAndroidBridge() as Bridge;
  else cached = createMockBridge();
  return cached;
}

export function isMock(): boolean {
  return !window.shareBridge && !isAndroidHost();
}

export function isAndroid(): boolean {
  return isAndroidHost();
}
