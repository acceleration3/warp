import { useEffect, useState } from 'react';

import { categoryOf, formatBytes, type FsEntry } from '@share/core';

import { bridge } from '../../bridge';
import { Button, Spinner } from '../../components';

/**
 * Plays a file in place, without leaving the picker.
 *
 * The URL comes from the platform: the desktop serves it over its own protocol
 * handler with range support, Android through Capacitor's local file server.
 * Both matter for video - without ranges the element cannot seek, and a long
 * clip would have to buffer from the beginning on every scrub.
 */
export function MediaPreview({
  entry,
  onClose,
}: {
  entry: FsEntry;
  onClose: () => void;
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAudio = categoryOf(entry) === 'audio';

  useEffect(() => {
    let alive = true;
    const resolve = bridge().mediaUrl;
    if (!resolve) {
      setError('This device cannot play files in the app.');
      return;
    }
    void resolve(entry)
      .then((resolved) => {
        if (!alive) return;
        if (resolved) setUrl(resolved);
        else setError('That file cannot be played here.');
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [entry]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="media-preview"
        role="dialog"
        aria-modal="true"
        aria-label={entry.name}
      >
        <header className="hbox hbox--sm media-preview__bar">
          <div className="stack" style={{ minWidth: 0, flex: 1 }}>
            <strong className="ellipsis">{entry.name}</strong>
            <span className="caption">{formatBytes(entry.size)}</span>
          </div>
          <Button variant="flat" circular icon="close" title="Close" onClick={onClose} />
        </header>

        <div className="media-preview__stage">
          {error ? (
            <p className="dim" style={{ padding: 24, textAlign: 'center' }}>
              {error}
            </p>
          ) : !url ? (
            <Spinner large />
          ) : isAudio ? (
            <audio src={url} controls autoPlay style={{ width: '100%' }} />
          ) : (
            <video
              src={url}
              controls
              autoPlay
              playsInline
              style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
              onError={() => setError('That file could not be decoded on this device.')}
            />
          )}
        </div>
      </div>
    </div>
  );
}
