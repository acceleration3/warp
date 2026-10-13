import { DEFAULT_HTTP_PORT } from './protocol.js';
import {
  THUMBNAIL_SIZE,
  defaultFilterRules,
  defaultSortRules,
  type FilterRules,
  type SortRules,
} from './picker/types.js';

/**
 * Everything the user can tune. Persisted as JSON on both platforms.
 */

export interface TransferSettings {
  /** How many whole transfers run at once; the rest wait in the queue. */
  maxConcurrentTransfers: number;
  /** Automatically retry a failed transfer this many times before giving up. */
  queueAutoRetries: number;
  /** Start queued transfers automatically, or hold them until told to go. */
  autoStartQueue: boolean;
  /** How many files are uploaded at the same time. */
  parallelFiles: number;
  /**
   * How many TCP connections a single large file is split across. 1 disables
   * splitting. Real gains show up on Wi-Fi and on links with latency; on a
   * wired gigabit LAN 2-3 is usually enough to saturate.
   */
  connectionsPerFile: number;
  /** Files below this size are never split (the extra round-trips cost more). */
  splitThresholdBytes: number;
  /** Size of one ranged request when splitting. */
  chunkSizeBytes: number;
  /** Retries per chunk before the file is marked failed. */
  retries: number;
  retryBackoffMs: number;
  /** Re-offer a partially received file instead of restarting it. */
  resumeEnabled: boolean;
  /** Raise/lower parallelism automatically based on observed throughput. */
  adaptiveConcurrency: boolean;
  /** Bytes/sec cap, 0 = unlimited. */
  throttleBytesPerSecond: number;
}

export interface DiscoverySettings {
  /** Announce presence over UDP. Turning this off makes the device invisible. */
  broadcast: boolean;
  /** Also join the multicast group (helps when the AP filters broadcast). */
  multicast: boolean;
  /** Extra hosts probed directly - useful over ZeroTier/VPN where broadcast is filtered. */
  manualPeers: string[];
  /** Interfaces to announce on. Empty = every non-internal IPv4 interface. */
  interfaces: string[];
  httpPort: number;
}

export interface PickerSettings {
  filter: FilterRules;
  sort: SortRules;
  view: 'list' | 'grid' | 'tree';
  /** Thumbnail edge length in pixels; see THUMBNAIL_SIZE for the range. */
  thumbnailSize: number;
  showThumbnails: boolean;
  showHiddenToggleVisible: boolean;
  /** Persisted sidebar bookmarks (provider ids). */
  bookmarks: string[];
  recentLocations: string[];
  /** Named, reusable filter rule sets. */
  presets: PickerPreset[];
}

export interface PickerPreset {
  id: string;
  name: string;
  filter: FilterRules;
  sort?: SortRules;
}

export interface AppSettings {
  deviceName: string;
  /** Where received files land. On Android this is a SAF tree URI. */
  downloadDirectory: string;
  /** Put each transfer in its own subfolder named after the sender. */
  groupBySender: boolean;
  /** Accept offers from these device ids without asking. */
  autoAcceptFrom: string[];
  /** Ask before accepting anything at all. */
  confirmIncoming: boolean;
  notifications: boolean;
  theme: 'system' | 'light' | 'dark';
  transfer: TransferSettings;
  discovery: DiscoverySettings;
  picker: PickerSettings;
}

export const TRANSFER_LIMITS = {
  maxConcurrentTransfers: { min: 1, max: 8, default: 2 },
  queueAutoRetries: { min: 0, max: 5, default: 1 },
  parallelFiles: { min: 1, max: 32, default: 4 },
  connectionsPerFile: { min: 1, max: 16, default: 2 },
  chunkSizeBytes: { min: 256 * 1024, max: 128 * 1024 * 1024, default: 8 * 1024 * 1024 },
  splitThresholdBytes: { min: 1024 * 1024, max: 1024 * 1024 * 1024, default: 16 * 1024 * 1024 },
  retries: { min: 0, max: 10, default: 3 },
} as const;

export function defaultTransferSettings(): TransferSettings {
  return {
    maxConcurrentTransfers: TRANSFER_LIMITS.maxConcurrentTransfers.default,
    queueAutoRetries: TRANSFER_LIMITS.queueAutoRetries.default,
    autoStartQueue: true,
    parallelFiles: TRANSFER_LIMITS.parallelFiles.default,
    connectionsPerFile: TRANSFER_LIMITS.connectionsPerFile.default,
    splitThresholdBytes: TRANSFER_LIMITS.splitThresholdBytes.default,
    chunkSizeBytes: TRANSFER_LIMITS.chunkSizeBytes.default,
    retries: TRANSFER_LIMITS.retries.default,
    retryBackoffMs: 500,
    resumeEnabled: true,
    adaptiveConcurrency: true,
    throttleBytesPerSecond: 0,
  };
}

export function defaultSettings(deviceName: string): AppSettings {
  return {
    deviceName,
    downloadDirectory: '',
    groupBySender: true,
    autoAcceptFrom: [],
    confirmIncoming: true,
    notifications: true,
    theme: 'system',
    transfer: defaultTransferSettings(),
    discovery: {
      broadcast: true,
      multicast: true,
      manualPeers: [],
      interfaces: [],
      httpPort: DEFAULT_HTTP_PORT,
    },
    picker: {
      filter: defaultFilterRules(),
      sort: defaultSortRules(),
      view: 'list',
      thumbnailSize: THUMBNAIL_SIZE.default,
      showThumbnails: true,
      showHiddenToggleVisible: true,
      bookmarks: [],
      recentLocations: [],
      presets: [],
    },
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Defensive normalization - settings files get hand-edited and survive upgrades. */
export function normalizeTransferSettings(input: Partial<TransferSettings> | undefined): TransferSettings {
  const base = defaultTransferSettings();
  if (!input) return base;
  const L = TRANSFER_LIMITS;
  return {
    maxConcurrentTransfers: clamp(input.maxConcurrentTransfers ?? base.maxConcurrentTransfers, L.maxConcurrentTransfers.min, L.maxConcurrentTransfers.max, base.maxConcurrentTransfers),
    queueAutoRetries: clamp(input.queueAutoRetries ?? base.queueAutoRetries, L.queueAutoRetries.min, L.queueAutoRetries.max, base.queueAutoRetries),
    autoStartQueue: input.autoStartQueue ?? base.autoStartQueue,
    parallelFiles: clamp(input.parallelFiles ?? base.parallelFiles, L.parallelFiles.min, L.parallelFiles.max, base.parallelFiles),
    connectionsPerFile: clamp(input.connectionsPerFile ?? base.connectionsPerFile, L.connectionsPerFile.min, L.connectionsPerFile.max, base.connectionsPerFile),
    splitThresholdBytes: clamp(input.splitThresholdBytes ?? base.splitThresholdBytes, L.splitThresholdBytes.min, L.splitThresholdBytes.max, base.splitThresholdBytes),
    chunkSizeBytes: clamp(input.chunkSizeBytes ?? base.chunkSizeBytes, L.chunkSizeBytes.min, L.chunkSizeBytes.max, base.chunkSizeBytes),
    retries: clamp(input.retries ?? base.retries, L.retries.min, L.retries.max, base.retries),
    retryBackoffMs: clamp(input.retryBackoffMs ?? base.retryBackoffMs, 0, 60_000, base.retryBackoffMs),
    resumeEnabled: input.resumeEnabled ?? base.resumeEnabled,
    adaptiveConcurrency: input.adaptiveConcurrency ?? base.adaptiveConcurrency,
    throttleBytesPerSecond: Math.max(0, input.throttleBytesPerSecond ?? 0),
  };
}

export function mergeSettings(stored: unknown, deviceName: string): AppSettings {
  const base = defaultSettings(deviceName);
  if (typeof stored !== 'object' || stored === null) return base;
  const input = stored as Partial<AppSettings>;
  return {
    ...base,
    ...input,
    transfer: normalizeTransferSettings(input.transfer),
    discovery: { ...base.discovery, ...(input.discovery ?? {}) },
    picker: {
      ...base.picker,
      ...(input.picker ?? {}),
      filter: { ...base.picker.filter, ...(input.picker?.filter ?? {}) },
      sort: { ...base.picker.sort, ...(input.picker?.sort ?? {}) },
      thumbnailSize: clamp(
        input.picker?.thumbnailSize ?? base.picker.thumbnailSize,
        THUMBNAIL_SIZE.min,
        THUMBNAIL_SIZE.max,
        base.picker.thumbnailSize,
      ),
    },
  };
}
