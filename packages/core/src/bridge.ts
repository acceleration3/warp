import type { DeviceInfo, OfferedFile, Peer, TransferState } from './protocol.js';
import type { QueueJobState } from './net/queue.js';
import type { AppSettings } from './settings.js';
import type { FilterRules, FsEntry, FsRoot, ListOptions, PickFilesOptions } from './picker/types.js';

/**
 * The contract between the UI and whatever native shell is hosting it.
 * Electron implements it in the preload; Android implements it over the
 * Capacitor plugin bridge. The UI never talks to a platform API directly.
 */

export type TransferDirection = 'incoming' | 'outgoing';

/** Serializable view of a transfer, safe to send over IPC. */
export interface TransferSummary {
  id: string;
  direction: TransferDirection;
  peer: { id: string; name: string; address: string; platform: string };
  label: string;
  state: TransferState;
  totalBytes: number;
  totalFiles: number;
  bytesTransferred: number;
  filesCompleted: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  activeConnections: number;
  activeFiles: string[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
  savedTo?: string;
  /** Only populated for incoming offers awaiting a decision. */
  files?: OfferedFile[];
  /** Per-file progress, so the UI can show and remove individual entries. */
  fileProgress?: Array<{
    fileId: string;
    path: string;
    size: number;
    transferred: number;
    state: 'queued' | 'active' | 'done' | 'failed' | 'skipped' | 'removed';
  }>;
  /** Queue bookkeeping. Absent for transfers that never entered the queue. */
  queue?: {
    state: QueueJobState;
    /** 0-based place in the waiting line; -1 when not waiting. */
    position: number;
    /** Automatic retries used so far. */
    attempts: number;
    /** Automatic retries allowed before the transfer is marked failed. */
    maxAttempts?: number;
    /** Set while an automatic retry is backing off: when it will start (epoch ms). */
    retryAt?: number;
  };
  /** Chunks re-sent after a failed attempt during the current run. */
  chunkRetries?: number;
}

export interface QueueStats {
  queued: number;
  running: number;
  paused: number;
  finished: number;
  /** True when the whole queue is held. */
  pausedGlobally: boolean;
  concurrency: number;
}

export interface NetworkInterfaceSummary {
  name: string;
  address: string;
  /** VPN / mesh interfaces such as ZeroTier or Tailscale. */
  overlay: boolean;
}

export interface AppState {
  self: DeviceInfo;
  peers: Peer[];
  transfers: TransferSummary[];
  queue: QueueStats;
  settings: AppSettings;
  interfaces: NetworkInterfaceSummary[];
  /** Populated when the transfer server could not bind. */
  networkError?: string;
  /**
   * Name of a host firewall that is running, when one is. Discovery is inbound
   * UDP and transfers are inbound TCP, so a default-deny firewall makes this
   * device invisible and unreachable while everything still looks healthy from
   * the inside - worth naming explicitly when no peers show up.
   */
  firewall?: 'ufw' | 'firewalld';
}

/** A selection sent from the renderer to be resolved by the native side. */
export interface SelectionPayload {
  included: FsEntry[];
  excluded: FsEntry[];
  filter: FilterRules;
}

export interface ResolveSummary {
  files: Array<{ id: string; path: string; size: number; mtime?: number; source: string }>;
  totalBytes: number;
  excluded: number;
  truncated: boolean;
}

export interface ScanProgress {
  filesFound: number;
  bytesFound: number;
  directoriesScanned: number;
  currentPath: string;
  excluded: number;
}

export interface ShareBridge {
  readonly platform: 'desktop' | 'android';

  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  onScanProgress(listener: (progress: ScanProgress) => void): () => void;
  /** Fired when a peer sends plain text. */
  onText(listener: (payload: { text: string; from?: DeviceInfo }) => void): () => void;

  // Discovery -------------------------------------------------------------
  refreshPeers(): Promise<void>;
  addManualPeer(host: string, port?: number): Promise<Peer | null>;
  removePeer(peerId: string): Promise<void>;

  // Filesystem ------------------------------------------------------------
  roots(): Promise<FsRoot[]>;
  list(directoryId: string, options?: ListOptions): Promise<FsEntry[]>;
  stat(id: string): Promise<FsEntry | null>;
  parentOf(id: string): Promise<FsEntry | null>;
  /** Recursive size/count for one directory, for the "how big is this?" readout. */
  measure(directoryId: string): Promise<{ files: number; bytes: number }>;
  /** Turns a tri-state selection into a concrete file list. */
  resolveSelection(payload: SelectionPayload): Promise<ResolveSummary>;
  /** Cancels an in-flight resolveSelection. */
  cancelScan(): Promise<void>;
  /** Native OS picker. On Android this is the SAF dialog. */
  pickFiles(options?: PickFilesOptions): Promise<FsEntry[]>;
  pickFolder(): Promise<FsRoot | null>;
  /**
   * A URL the renderer may use as an <img> source, or null.
   * `sizePx` is in device pixels, so pass the CSS size scaled by the pixel
   * ratio or the result looks soft on a high-density screen.
   */
  thumbnailUrl(entry: FsEntry, sizePx: number): Promise<string | null>;
  /**
   * A URL the renderer can play in a <video> or <audio>, or null when the
   * platform cannot stream it. Must support range requests so seeking works.
   */
  mediaUrl?(entry: FsEntry): Promise<string | null>;
  /** Opens a path in the system file manager / viewer. */
  openPath(id: string): Promise<void>;
  revealPath(id: string): Promise<void>;

  // Transfers -------------------------------------------------------------
  send(peerId: string, payload: SelectionPayload, label: string): Promise<string>;
  sendText(peerId: string, text: string): Promise<void>;
  acceptTransfer(transferId: string, destination?: string): Promise<void>;
  declineTransfer(transferId: string): Promise<void>;

  // Queue -----------------------------------------------------------------
  pauseTransfer(transferId: string): Promise<void>;
  resumeTransfer(transferId: string): Promise<void>;
  cancelTransfer(transferId: string): Promise<void>;
  retryTransfer(transferId: string): Promise<void>;
  /** Takes the transfer out of the queue entirely. */
  removeTransfer(transferId: string): Promise<void>;
  /** Drops one file from a transfer that has not sent it yet. */
  removeQueuedFile(transferId: string, fileId: string): Promise<boolean>;
  /** Reorders the waiting line. */
  moveTransfer(transferId: string, direction: 'up' | 'down' | 'top'): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  cancelAll(): Promise<void>;
  clearFinished(): Promise<void>;
  clearTransfer(transferId: string): Promise<void>;

  // Settings --------------------------------------------------------------
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  chooseDownloadDirectory(): Promise<string | null>;
}

declare global {
  interface Window {
    shareBridge?: ShareBridge;
  }
}
