import { useEffect, useState } from 'react';

import { categoryOf, type FsEntry } from '@share/core';

import { bridge } from '../../bridge';
import { Icon, iconForCategory, type IconName } from '../../icons';

export function iconFor(entry: FsEntry): IconName {
  if (entry.kind === 'directory') return 'folder';
  return iconForCategory(categoryOf(entry));
}

export function isPlayable(entry: FsEntry): boolean {
  if (entry.kind !== 'file') return false;
  const category = categoryOf(entry);
  return category === 'video' || category === 'audio';
}

/**
 * Thumbnails are requested in *device* pixels, rounded up to a bucket.
 *
 * Asking for CSS pixels is what makes a preview look soft: on a phone at 2.6x
 * density a 104px tile is drawn across ~270 real pixels, so a 104px decode is
 * upscaled by two and a half. Bucketing keeps the slider from firing a fresh
 * native decode on every single step while still growing the image when the
 * tile grows past the current bucket.
 */
function requestPixels(cssSize: number): number {
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const wanted = cssSize * ratio;
  const bucket = Math.ceil(wanted / 64) * 64;
  return Math.min(1024, Math.max(96, bucket));
}

export function Thumb({
  entry,
  size,
  enabled = true,
  onPlay,
}: {
  entry: FsEntry;
  size: number;
  enabled?: boolean;
  /** When given, a playable file gets a centred play button. */
  onPlay?: (entry: FsEntry) => void;
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const pixels = requestPixels(size);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!enabled || entry.kind === 'directory') return;
    void bridge()
      .thumbnailUrl(entry, pixels)
      .then((resolved) => alive && setUrl(resolved))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [entry, enabled, pixels]);

  const playable = Boolean(onPlay) && isPlayable(entry);
  // Big enough to hit with a thumb, but never wider than the tile itself.
  const badge = Math.max(22, Math.min(52, Math.round(size * 0.42)));

  const surface = url ? (
    <img
      src={url}
      alt=""
      loading="lazy"
      // The decode is already the right size; let the browser scale smoothly.
      style={{
        width: size,
        height: size,
        objectFit: 'cover',
        display: 'block',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--button-bg)',
      }}
      onError={() => setUrl(null)}
    />
  ) : (
    <span
      style={{
        width: size,
        height: size,
        display: 'grid',
        placeItems: 'center',
        color: entry.kind === 'directory' ? 'var(--accent-text)' : 'var(--dim-fg)',
      }}
    >
      <Icon name={iconFor(entry)} size={Math.min(28, size * 0.55)} />
    </span>
  );

  if (!playable) return surface;

  return (
    <span style={{ position: 'relative', display: 'inline-block', lineHeight: 0 }}>
      {surface}
      <button
        type="button"
        className="thumb-play"
        title={`Play ${entry.name}`}
        aria-label={`Play ${entry.name}`}
        style={{ width: badge, height: badge }}
        onClick={(event) => {
          // The tile itself toggles selection; playing must not also select.
          event.stopPropagation();
          event.preventDefault();
          onPlay?.(entry);
        }}
      >
        <Icon name="play" size={Math.round(badge * 0.42)} />
      </button>
    </span>
  );
}
