/** Display helpers shared by every UI surface. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number, decimals?: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const places = decimals ?? (value < 10 ? 1 : 0);
  return `${value.toFixed(places)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '-';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '-';
  if (seconds < 1) return 'less than a second';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  if (!epochMs) return 'unknown';
  const diff = now - epochMs;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days} d ago`;
  return new Date(epochMs).toLocaleDateString();
}

/** "photos" + 412 files -> "photos (412 files, 1.2 GB)" */
export function describeBatch(label: string, fileCount: number, bytes: number): string {
  return `${label} (${formatCount(fileCount, 'file')}, ${formatBytes(bytes)})`;
}
