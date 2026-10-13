/**
 * HTTP Range parsing for the local media protocol.
 *
 * Kept apart from the Electron entry point so it can be tested directly: an
 * off-by-one here is the difference between a video that seeks instantly and
 * one that silently refuses to scrub.
 */

export interface ByteRange {
  start: number;
  /** Inclusive, as the Range header and Content-Range both are. */
  end: number;
}

export type RangeResult =
  /** No Range header: serve the whole file with 200. */
  | { kind: 'full' }
  /** A satisfiable range: serve it with 206. */
  | { kind: 'partial'; range: ByteRange }
  /** Unsatisfiable: answer 416 with Content-Range: bytes / size. */
  | { kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Handles the three forms a player actually sends:
 *   bytes=0-        everything from an offset (the common case while playing)
 *   bytes=500-999   an explicit window (seeking)
 *   bytes=-500      the final N bytes, which is how MP4 metadata at the end of
 *                   a file gets fetched before playback can start at all
 */
export function parseRange(size: number, header: string | null | undefined): RangeResult {
  if (!header) return { kind: 'full' };

  const match = SINGLE_RANGE.exec(header.trim());
  if (!match) return { kind: 'unsatisfiable' };

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { kind: 'unsatisfiable' };
  if (size <= 0) return { kind: 'unsatisfiable' };

  let start: number;
  let end: number;

  if (!rawStart) {
    // Suffix form: the last N bytes, clamped to the file.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: 'unsatisfiable' };
    // A start past the end of the file is the one case that must 416; an end
    // past it is simply clamped, which is what every server does.
    if (start >= size) return { kind: 'unsatisfiable' };
    end = Math.min(end, size - 1);
    if (end < start) return { kind: 'unsatisfiable' };
  }

  return { kind: 'partial', range: { start, end } };
}

/** Bytes covered by a range, for Content-Length. */
export function rangeLength(range: ByteRange): number {
  return range.end - range.start + 1;
}
