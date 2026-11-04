import { GenericRange } from "@tento-chrono";

export type _AbstractRange<T> = { start: T; end: T };

export type RFC3339Range = _AbstractRange<RFC3339>;
export type NumRangeLike = _AbstractRange<number>;
export type NumOptRange = _AbstractRange<Option<number>>;

export class NumberRange extends GenericRange<number> {
  // Generates a changeset for transitioning from existing range to this range
  changeset(existing: NumberRange): {
    adds: NumberRange[];
    removes: NumberRange[];
  } {
    const adds: NumberRange[] = [];
    const removes: NumberRange[] = [];

    // Check if ranges overlap
    if (!NumRangeLike.intersects(this, existing)) {
      // No overlap - remove entire existing range, add entire new range
      removes.push(existing);
      adds.push(this);
    } else {
      // Has overlap - calculate the differences
      // Remove the part of existing that's not in this
      if (existing.start < this.start) {
        removes.push(new NumberRange(existing.start, this.start - 1));
      }
      if (existing.end > this.end) {
        removes.push(new NumberRange(this.end + 1, existing.end));
      }

      // Add the part of this that's not in existing
      if (this.start < existing.start) {
        adds.push(new NumberRange(this.start, existing.start - 1));
      }
      if (this.end > existing.end) {
        adds.push(new NumberRange(existing.end + 1, this.end));
      }
    }

    return { adds, removes };
  }

  equals(o: NumberRange): boolean {
    return this.start === o.start && this.end === o.end;
  }

  clamp(minIndex: Option<number>, maxIndex: Option<number>): NumberRange {
    const clampedStart =
      minIndex != null ? Math.max(this.start, minIndex) : this.start;
    const clampedEnd =
      maxIndex != null ? Math.min(this.end, maxIndex) : this.end;
    if (clampedStart > clampedEnd) {
      return NumberRange.INVALID;
    }
    return new NumberRange(clampedStart, clampedEnd);
  }
}

export class NumberOptionRange extends GenericRange<Option<Number>> {}

export namespace NumberRange {
  export const ZERO = new NumberRange(0, 0);
  export const INVALID = new NumberRange(1, -1);
}

export namespace NumRangeLike {
  export function make(a: number[]): NumRangeLike {
    return {
      start: a[0],
      end: a[1],
    };
  }

  export function containsRange(
    larger: NumRangeLike,
    smaller: NumRangeLike,
  ): boolean {
    return (
      NumRangeLike.contains(larger, smaller.start) &&
      NumRangeLike.contains(larger, smaller.end)
    );
  }

  export function intersects(r1: NumRangeLike, r2: NumRangeLike): boolean {
    return r1.start <= r2.end && r1.end >= r2.start;
  }

  export function contains(s: NumRangeLike, n: number): boolean {
    return n >= s.start && n <= s.end;
  }

  export function containsExclusiveEnd(s: NumRangeLike, n: number): boolean {
    return n >= s.start && n < s.end;
  }

  export function intervalUnionArea(intervals: NumRangeLike[]): number {
    if (intervals.length === 0) return 0;
    if (intervals.length === 1) return intervals[0].end - intervals[0].start;
    intervals.sort((a, b) => a.start - b.start);
    let currentStart = intervals[0].start;
    let currentEnd = intervals[0].end;
    let totalArea = 0;
    for (let i = 1; i < intervals.length; i++) {
      const interval = intervals[i];
      if (interval.start > currentEnd) {
        totalArea += currentEnd - currentStart;
        currentStart = interval.start;
        currentEnd = interval.end;
      } else {
        currentEnd = Math.max(currentEnd, interval.end);
      }
    }
    totalArea += currentEnd - currentStart;
    return totalArea;
  }

  export function progress(pct: number, range: NumRangeLike): number {
    return range.start + pct * (range.end - range.start);
  }

  export function getProgressPct(
    progress: number,
    range: NumRangeLike,
  ): number {
    return (progress - range.start) / (range.end - range.start);
  }
}
