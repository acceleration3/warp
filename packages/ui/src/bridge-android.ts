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

/**
 * Android implementation of ShareBridge, talking to the Warp Capacitor plugin.
 *
 * The heavy lifting - discovery, the HTTP server, the transfer queue - all
 * happens in Java inside a foreground service, so it keeps running when this
 * WebView is destroyed. This file is only a typed wrapper over that boundary.
 */

interface ListenerHandle {
  remove: () => void | Promise<void>;
}

interface CapacitorPlugin {
  /**
   * Capacitor returns a PluginListenerHandle that is *also* thenable when the
   * typed package is used, but a plain handle when reached through the global
   * bridge. Both shapes have to be handled.
   */
  addListener(
    event: string,
    handler: (payload: unknown) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
  [method: string]: unknown;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  /** Rewrites a file:// or content:// path into something the WebView can load. */
  convertFileSrc?: (url: string) => string;
  Plugins?: Record<string, CapacitorPlugin>;
}

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
  }
}

/**
 * Detects the Android host by the platform alone, never by the presence of the
 * plugin object.
 *
 * Capacitor populates `Plugins` asynchronously relative to the first script
 * evaluation, so testing for `Plugins.Warp` here is a race: lose it once and
 * the UI latches onto the mock bridge for the rest of the session, reporting
 * "preview mode" on a perfectly working device.
 */
export function isAndroidHost(): boolean {
  const capacitor = window.Capacitor;
  if (!capacitor) return false;
  if (capacitor.getPlatform?.() === 'android') return true;
  return Boolean(capacitor.isNativePlatform?.() && capacitor.Plugins?.Warp);
}

/** Extra calls that only exist on Android. */
export interface AndroidExtras {
  /**
   * Asks the system to exempt the app from battery optimisation. The foreground
   * service covers the documented cases, but several OEM skins still freeze
   * background sockets without this.
   */
  requestBatteryExemption(): Promise<boolean>;
  isBatteryExempt(): Promise<boolean>;
  /**
   * Android 13+ gates MediaStore behind per-type permissions. Without them the
   * Photos, Videos and Music shortcuts return empty rather than failing, so the
   * UI has to ask explicitly and explain the empty state.
   */
  checkMediaAccess(): Promise<boolean>;
  requestMediaAccess(): Promise<boolean>;
  /**
   * "All files access", which is the only way to browse the shared storage
   * tree (DCIM, Download, ...) from Android 11. Granted in system settings
   * rather than by a dialog.
   */
  checkAllFilesAccess(): Promise<boolean>;
  requestAllFilesAccess(): Promise<boolean>;
}

export function createAndroidBridge(): ShareBridge & AndroidExtras {
  // Looked up per call, so a plugin that is not registered yet at module
  // evaluation time still works once it is.
  const resolve = (): CapacitorPlugin => {
    const plugin = window.Capacitor?.Plugins?.Warp;
    if (!plugin) throw new Error('the Warp plugin is not available yet');
    return plugin;
  };

  const call = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => {
    const plugin = resolve();
    const fn = plugin[method] as ((args: Record<string, unknown>) => Promise<T>) | undefined;
    if (typeof fn !== 'function') throw new Error(`the app is missing ${method}`);
    return fn.call(plugin, args);
  };

  const listen = (event: string, handler: (payload: never) => void): (() => void) => {
    let handle: ListenerHandle | null = null;
    let cancelled = false;

    const attach = (resolved: ListenerHandle): void => {
      if (cancelled) void resolved.remove();
      else handle = resolved;
    };

    const result = resolve().addListener(event, (payload) => handler(payload as never));
    if (result && typeof (result as Promise<ListenerHandle>).then === 'function') {
      void (result as Promise<ListenerHandle>).then(attach);
    } else {
      attach(result as ListenerHandle);
    }

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  };

  return {
    platform: 'android',

    getState: () => call<AppState>('getState'),
    onState: (listener) => listen('state', listener as (payload: never) => void),
    // Scanning happens inside the send call on Android, so there is no separate
    // progress channel; the UI simply shows its indeterminate state.
    onScanProgress: (_listener: (progress: ScanProgress) => void) => () => {},
    onText: (listener) => listen('text', listener as (payload: never) => void),

    refreshPeers: () => call<void>('refreshPeers'),
    addManualPeer: async (host, port) => {
      const result = await call<Peer | null>('addManualPeer', { host, port });
      // The plugin resolves with null when nothing answered.
      return result && (result as Peer).id ? result : null;
    },
    removePeer: (peerId) => call<void>('removePeer', { peerId }),

    roots: async () => (await call<{ roots: FsRoot[] }>('roots')).roots ?? [],
    list: async (directoryId: string, options?: ListOptions) =>
      (await call<{ entries: FsEntry[] }>('list', {
        directoryId,
        includeHidden: options?.includeHidden ?? false,
      })).entries ?? [],
    stat: async (id) => (await call<{ entry?: FsEntry }>('stat', { id })).entry ?? null,
    parentOf: async (id) => (await call<{ entry?: FsEntry }>('parentOf', { id })).entry ?? null,
    measure: (directoryId) => call<{ files: number; bytes: number }>('measure', { directoryId }),

    // The Java side expands the selection as part of send(), so resolving here
    // would mean walking the tree twice.
    resolveSelection: async (_payload: SelectionPayload): Promise<ResolveSummary> => ({
      files: [],
      totalBytes: 0,
      excluded: 0,
      truncated: false,
    }),
    cancelScan: async () => {},

    pickFiles: async () => (await call<{ entries: FsEntry[] }>('pickFiles')).entries ?? [],
    pickFolder: async () => (await call<{ root?: FsRoot }>('pickFolder')).root ?? null,
    /**
     * Images go through Capacitor's local file server, which streams them
     * straight into the <img> with no copying. Video cannot be rendered that
     * way, so a frame is decoded natively and returned as a data URI.
     */
    thumbnailUrl: async (entry, sizePx) => {
      if (entry.kind !== 'file' || !entry.mime) return null;
      if (entry.mime.startsWith('image/')) {
        const convert = window.Capacitor?.convertFileSrc;
        return convert ? convert(entry.id) : entry.id;
      }
      if (entry.mime.startsWith('video/')) {
        const result = await call<{ dataUrl?: string }>('thumbnail', {
          id: entry.id,
          // Already device pixels; the native side decodes at exactly this.
          size: Math.max(96, Math.round(sizePx)),
        });
        return result.dataUrl ?? null;
      }
      return null;
    },

    /** Capacitor's local server streams both content:// and file paths, with ranges. */
    mediaUrl: async (entry) => {
      if (entry.kind !== 'file') return null;
      const convert = window.Capacitor?.convertFileSrc;
      return convert ? convert(entry.id) : entry.id;
    },
    openPath: (id) => call<void>('openPath', { id }),
    revealPath: (id) => call<void>('openPath', { id }),

    send: async (peerId, payload, label) =>
      (await call<{ transferId: string }>('send', { peerId, payload, label })).transferId,
    sendText: (peerId, text) => call<void>('sendText', { peerId, text }),
    acceptTransfer: (transferId, destination) =>
      call<void>('acceptTransfer', { transferId, destination }),
    declineTransfer: (transferId) => call<void>('declineTransfer', { transferId }),

    pauseTransfer: (transferId) => call<void>('pauseTransfer', { transferId }),
    resumeTransfer: (transferId) => call<void>('resumeTransfer', { transferId }),
    cancelTransfer: (transferId) => call<void>('cancelTransfer', { transferId }),
    retryTransfer: (transferId) => call<void>('retryTransfer', { transferId }),
    removeTransfer: (transferId) => call<void>('removeTransfer', { transferId }),
    removeQueuedFile: async (transferId, fileId) =>
      (await call<{ removed: boolean }>('removeQueuedFile', { transferId, fileId })).removed,
    moveTransfer: (transferId, direction) => call<void>('moveTransfer', { transferId, direction }),
    pauseAll: () => call<void>('pauseAll'),
    resumeAll: () => call<void>('resumeAll'),
    cancelAll: () => call<void>('cancelAll'),
    clearFinished: () => call<void>('clearFinished'),
    clearTransfer: (transferId) => call<void>('removeTransfer', { transferId }),

    updateSettings: (patch: Partial<AppSettings>) =>
      call<AppSettings>('updateSettings', { patch }),
    chooseDownloadDirectory: async () =>
      (await call<{ directory?: string }>('chooseDownloadDirectory')).directory ?? null,

    requestBatteryExemption: async () =>
      (await call<{ granted: boolean }>('requestBatteryExemption')).granted,
    isBatteryExempt: async () => (await call<{ exempt: boolean }>('isBatteryExempt')).exempt,
    checkMediaAccess: async () => (await call<{ granted: boolean }>('checkMediaAccess')).granted,
    requestMediaAccess: async () => (await call<{ granted: boolean }>('requestMediaAccess')).granted,
    checkAllFilesAccess: async () =>
      (await call<{ granted: boolean }>('checkAllFilesAccess')).granted,
    requestAllFilesAccess: async () =>
      (await call<{ granted: boolean }>('requestAllFilesAccess')).granted,
  };
}

export type { DeviceInfo };
