/**
 * Tracks which byte ranges of a file have actually landed.
 *
 * Needed because several connections write into the same file at once: the
 * receiver cannot use "bytes written so far" as progress, and on resume it has
 * to know precisely which holes are left.
 */

export interface Range {
  /** Inclusive. */
  start: number;
  /** Exclusive. */
  end: number;
}

export class RangeSet {
  private ranges: Range[] = [];

  constructor(initial: readonly Range[] = []) {
    for (const range of initial) this.add(range.start, range.end);
  }

  /** Marks [start, end) as present, merging with any touching neighbours. */
  add(start: number, end: number): void {
    if (end <= start) return;
    const next: Range[] = [];
    let cursor: Range = { start, end };
    let inserted = false;

    for (const range of this.ranges) {
      if (range.end < cursor.start) {
        next.push(range);
        continue;
      }
      if (range.start > cursor.end) {
        if (!inserted) {
          next.push(cursor);
          inserted = true;
        }
        next.push(range);
        continue;
      }
      // Overlapping or adjacent: absorb.
      cursor = {
        start: Math.min(cursor.start, range.start),
        end: Math.max(cursor.end, range.end),
      };
    }
    if (!inserted) next.push(cursor);
    this.ranges = next.sort((a, b) => a.start - b.start);
  }

  has(start: number, end: number): boolean {
    if (end <= start) return true;
    return this.ranges.some((range) => range.start <= start && range.end >= end);
  }

  /** The gaps inside [0, total) that are still missing. */
  missing(total: number): Range[] {
    const gaps: Range[] = [];
    let cursor = 0;
    for (const range of this.ranges) {
      if (range.start > cursor) gaps.push({ start: cursor, end: Math.min(range.start, total) });
      cursor = Math.max(cursor, range.end);
      if (cursor >= total) break;
    }
    if (cursor < total) gaps.push({ start: cursor, end: total });
    return gaps.filter((gap) => gap.end > gap.start);
  }

  /** Total bytes covered. */
  size(): number {
    return this.ranges.reduce((sum, range) => sum + (range.end - range.start), 0);
  }

  isComplete(total: number): boolean {
    // An empty file is whole before a single byte arrives.
    if (total <= 0) return true;
    return this.ranges.length === 1 && this.ranges[0]!.start <= 0 && this.ranges[0]!.end >= total;
  }

  /** Longest prefix that is contiguous from 0 - what a naive appender could trust. */
  contiguousPrefix(): number {
    const first = this.ranges[0];
    return first && first.start === 0 ? first.end : 0;
  }

  toJSON(): Range[] {
    return this.ranges.map((range) => ({ ...range }));
  }

  static fromJSON(data: readonly Range[] | undefined): RangeSet {
    return new RangeSet(data ?? []);
  }

  clear(): void {
    this.ranges = [];
  }
}
