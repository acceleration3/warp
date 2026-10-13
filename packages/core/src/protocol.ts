/**
 * Wire protocol shared by every platform.
 *
 * Two channels:
 *   1. Discovery - UDP broadcast/multicast of small JSON beacons on DISCOVERY_PORT.
 *   2. Transfer  - plain HTTP/1.1 between peers. Every device runs a tiny server.
 *
 * HTTP was chosen over a custom framed protocol so the Java (Android) and Node
 * (desktop) implementations stay small and stay debuggable with curl.
 */

export const PROTOCOL_VERSION = 1;

/** UDP port every device listens on for discovery beacons. */
export const DISCOVERY_PORT = 47654;
/** Default TCP port for the per-device HTTP server (falls back upward if busy). */
export const DEFAULT_HTTP_PORT = 47655;
/** Multicast group used alongside subnet broadcast, for APs that drop broadcast. */
export const MULTICAST_GROUP = '239.47.65.4';

/** How often a device re-announces itself. */
export const ANNOUNCE_INTERVAL_MS = 3_000;
/** A peer not heard from within this window is considered gone. */
export const PEER_TIMEOUT_MS = 12_000;

export type Platform = 'linux' | 'windows' | 'macos' | 'android' | 'ios' | 'unknown';
export type DeviceType = 'desktop' | 'laptop' | 'phone' | 'tablet' | 'server';

export interface DeviceInfo {
  /** Stable per-install id (uuid v4), persisted across restarts. */
  id: string;
  name: string;
  platform: Platform;
  deviceType: DeviceType;
  /** Port of this device's HTTP transfer server. */
  port: number;
  protocol: number;
  /** App version, purely informational. */
  appVersion?: string;
  /** Set when the device requires a PIN before it will show an incoming offer. */
  protected?: boolean;
}

/** A peer as tracked locally: the advertised info plus how we reached it. */
export interface Peer extends DeviceInfo {
  address: string;
  /** Epoch ms of the last beacon received. */
  lastSeen: number;
  /** True when the user pinned it manually (never expires from the list). */
  manual?: boolean;
  /** Round-trip of the last successful HTTP probe, if any. */
  rttMs?: number;
  /** Interface the beacon arrived on, for display ("eno1", "zerotier"). */
  via?: string;
}

export type Beacon =
  | { t: 'announce'; device: DeviceInfo }
  /** Asks every listener to announce immediately - sent on app start for instant discovery. */
  | { t: 'query'; from: string }
  | { t: 'bye'; id: string };

export function isBeacon(value: unknown): value is Beacon {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { t?: unknown }).t;
  if (t === 'announce') {
    const d = (value as { device?: unknown }).device;
    return (
      typeof d === 'object' &&
      d !== null &&
      typeof (d as DeviceInfo).id === 'string' &&
      typeof (d as DeviceInfo).port === 'number'
    );
  }
  if (t === 'query') return typeof (value as { from?: unknown }).from === 'string';
  if (t === 'bye') return typeof (value as { id?: unknown }).id === 'string';
  return false;
}

export function encodeBeacon(beacon: Beacon): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(beacon));
}

export function decodeBeacon(bytes: Uint8Array | string): Beacon | null {
  try {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return isBeacon(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/** One file inside an offer. `path` is POSIX-style, relative to the transfer root. */
export interface OfferedFile {
  id: string;
  /** e.g. "photos/2024/img_001.jpg" - forward slashes, never absolute, never "..". */
  path: string;
  size: number;
  mtime?: number;
  mime?: string;
}

export interface TransferOffer {
  transferId: string;
  from: DeviceInfo;
  files: OfferedFile[];
  totalBytes: number;
  /** Human label for the whole batch, e.g. "Holiday photos (412 files)". */
  label: string;
}

export type TransferState =
  | 'pending' // offer delivered, waiting on the receiving human
  | 'accepted' // receiver said yes; sender may upload
  | 'declined'
  | 'sending'
  | 'complete'
  | 'failed'
  | 'cancelled';

export function isTerminal(state: TransferState): boolean {
  return state === 'declined' || state === 'complete' || state === 'failed' || state === 'cancelled';
}

export interface TransferStatus {
  transferId: string;
  state: TransferState;
  /** Issued on accept; required on every upload request. */
  token?: string;
  bytesReceived: number;
  filesReceived: number;
  error?: string;
  /** Absolute directory the receiver saved into, reported back for display. */
  savedTo?: string;
}

/** Per-file progress, used by both ends for the UI. */
export interface FileProgress {
  fileId: string;
  path: string;
  size: number;
  transferred: number;
  state: 'queued' | 'active' | 'done' | 'failed' | 'skipped';
  error?: string;
}

export const HTTP_ROUTES = {
  info: '/api/info',
  offer: '/api/offer',
  status: (id: string) => `/api/transfer/${encodeURIComponent(id)}/status`,
  upload: (id: string, fileId: string) =>
    `/api/transfer/${encodeURIComponent(id)}/file/${encodeURIComponent(fileId)}`,
  finish: (id: string) => `/api/transfer/${encodeURIComponent(id)}/finish`,
  cancel: (id: string) => `/api/transfer/${encodeURIComponent(id)}/cancel`,
  text: '/api/text',
} as const;

export const HEADERS = {
  deviceId: 'x-share-device',
  token: 'x-share-token',
  offset: 'x-share-offset',
  pin: 'x-share-pin',
} as const;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
// Characters illegal in a path segment on Windows, plus C0 control codes.
const ILLEGAL_SEGMENT = new RegExp('[<>:"|?*]|[\\u0000-\\u001f]');

/**
 * Guards against path traversal in received manifests. Returns a safe relative
 * POSIX path, or null when the input can never be trusted.
 */
export function sanitizeRelativePath(input: string): string | null {
  if (!input || input.length > 4096) return null;
  const normalized = input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '');
  if (!normalized) return null;
  const parts: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    if (ILLEGAL_SEGMENT.test(segment)) return null;
    if (WINDOWS_RESERVED.test(segment)) return null;
    // A trailing dot or space breaks on Windows and hides files on some pickers.
    if (/[. ]$/.test(segment)) return null;
    parts.push(segment);
  }
  return parts.length ? parts.join('/') : null;
}
