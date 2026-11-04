/**
 * Two-ended sorted sequence keyed by integer, with a secondary Map for O(1)
 * point lookups by a caller-supplied unique key.
 *
 * Stores values in two arrays around a pivot:
 *   lowerData — descending (closest to pivot at index 0, farthest at the end)
 *   upperData — ascending  (closest to pivot at index 0, farthest at the end)
 *
 * This layout gives O(1) push to either boundary (the dominant write pattern
 * when a fetch window expands left or right) and O(log n + k) range queries via
 * binary search. In-range upserts (re-fetch) are O(log n) + O(1) in-place.
 * Mid-range inserts of entirely new entries are O(n) via splice — expected to
 * be rare since data arrives in contiguous chunks.
 *
 * Multiple entries may share the same integer key (e.g. a day entry and a month
 * entry can both start on DSE=X). The secondary key K (from `keyOf`) uniquely
 * identifies each entry for point lookups and in-place updates.
 */
export class SortedDeque<V, K> {
  private readonly _map = new Map<K, V>();
  readonly lowerData: Array<[number, V]> = []; // descending
  readonly upperData: Array<[number, V]> = []; // ascending
  private _pivot: number | null = null;

  constructor(private readonly keyOf: (v: V) => K) {}

  get size(): number {
    return this._map.size;
  }

  /**
   * O(1) point lookup by the secondary key returned by `keyOf`.
   */
  get(key: K): V | undefined {
    return this._map.get(key);
  }

  /**
   * Upsert an entry at `dse`.
   *
   * - New key → insert into sorted arrays (O(1) boundary push or O(n) splice)
   * - Existing key → locate old entry by reference in arrays and replace in-place
   */
  upsert(dse: number, value: V): void {
    const key = this.keyOf(value);
    const old = this._map.get(key);
    this._map.set(key, value);

    if (old === undefined) {
      this._insertNew(dse, value);
    } else {
      this._replaceExisting(dse, old, value);
    }
  }

  private _insertNew(dse: number, value: V): void {
    if (this._pivot === null) {
      this._pivot = dse;
      this.upperData.push([dse, value]);
      return;
    }

    const pivot = this._pivot;
    if (dse >= pivot) {
      const maxKey = this.upperData[this.upperData.length - 1]?.[0];
      if (maxKey == null || dse > maxKey) {
        this.upperData.push([dse, value]);
        return;
      }
      const pos = rangeStart(this.upperData, dse);
      this.upperData.splice(pos, 0, [dse, value]);
      return;
    }

    const minKey = this.lowerData[this.lowerData.length - 1]?.[0];
    if (minKey == null || dse < minKey) {
      this.lowerData.push([dse, value]);
      return;
    }
    const pos = rangeStartDesc(this.lowerData, dse);
    this.lowerData.splice(pos, 0, [dse, value]);
  }

  private _replaceExisting(dse: number, old: V, value: V): void {
    if (this._pivot === null) return;
    // Scan both arrays defensively. Older invalid split states and
    // future changes to insertion should not make replacement lose
    // the array entry while updating the point-lookup map.
    const upperPos = rangeStart(this.upperData, dse);
    for (let i = upperPos; i < this.upperData.length && this.upperData[i][0] === dse; i++) {
      if (this.upperData[i][1] === old) {
        this.upperData[i] = [dse, value];
        return;
      }
    }
    const lowerPos = rangeStartDesc(this.lowerData, dse);
    for (let i = lowerPos; i < this.lowerData.length && this.lowerData[i][0] === dse; i++) {
      if (this.lowerData[i][1] === old) {
        this.lowerData[i] = [dse, value];
        return;
      }
    }
  }

  /**
   * Remove the entry identified by the secondary key returned by `keyOf`.
   * Returns true if an entry was removed. O(log n) for the binary search
   * plus O(n) worst-case for the splice — only relevant when the entry
   * lies mid-range; boundary removals are O(log n).
   */
  deleteByKey(key: K): boolean {
    const existing = this._map.get(key);
    if (existing === undefined || this._pivot === null) return false;
    this._map.delete(key);
    // Locate via a linear sweep from the correct end. The keyOf value
    // is unique; ties at the same dse resolve by reference identity.
    let removed = false;
    for (let i = 0; i < this.upperData.length; i++) {
      if (this.upperData[i][1] === existing) {
        this.upperData.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed) {
      for (let i = 0; i < this.lowerData.length; i++) {
        if (this.lowerData[i][1] === existing) {
          this.lowerData.splice(i, 1);
          removed = true;
          break;
        }
      }
    }
    // When the deque becomes empty, reset the pivot. Otherwise
    // `_insertNew` would skip the `pivot === null` early return on
    // the next upsert and crash reading `upperData[0]` /
    // `lowerData[0]`.
    if (this._map.size === 0) this._pivot = null;
    return removed;
  }

  /**
   * Range query [start, end) — start inclusive, end exclusive.
   * Returns values in ascending key order. O(log n + k).
   */
  getInRange(start: number, end: number): V[] {
    if (start >= end || this._pivot === null) return [];
    const pivot = this._pivot;
    const last = end - 1; // convert to inclusive
    const out: V[] = [];

    // Lower half (descending): entries with key in [start, min(last, pivot-1)]
    if (this.lowerData.length > 0 && start < pivot) {
      const lo = Math.min(last, pivot - 1);
      const si = rangeStartDesc(this.lowerData, lo);
      const ei = rangeEndDesc(this.lowerData, start);
      // Iterate from farthest-from-pivot (ei) to closest (si) → ascending order
      for (let i = ei; i >= si; i--) {
        out.push(this.lowerData[i][1]);
      }
    }

    // Upper half (ascending): entries with key in [max(start, pivot), last]
    if (this.upperData.length > 0 && last >= pivot) {
      const lo = Math.max(start, pivot);
      const si = rangeStart(this.upperData, lo);
      const ei = rangeEnd(this.upperData, last);
      for (let i = si; i <= ei; i++) {
        out.push(this.upperData[i][1]);
      }
    }

    return out;
  }

  /**
   * Full scan in ascending key order. O(n).
   */
  forEach(fn: (key: number, value: V) => void): void {
    for (let i = this.lowerData.length - 1; i >= 0; i--) {
      fn(this.lowerData[i][0], this.lowerData[i][1]);
    }
    for (const [k, v] of this.upperData) {
      fn(k, v);
    }
  }

  clear(): void {
    this._map.clear();
    this._pivot = null;
    this.lowerData.length = 0;
    this.upperData.length = 0;
  }
}

// ── Binary search helpers ────────────────────────────────────────────────────
// All operate on Array<[number, unknown]> tuples sorted by the first element.

/** Ascending array: first index where arr[i][0] >= target, or arr.length. */
function rangeStart(arr: Array<[number, unknown]>, target: number): number {
  let lo = 0, hi = arr.length - 1, result = arr.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] >= target) { result = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return result;
}

/** Ascending array: last index where arr[i][0] <= target, or -1. */
function rangeEnd(arr: Array<[number, unknown]>, target: number): number {
  let lo = 0, hi = arr.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] <= target) { result = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}

/** Descending array: first index where arr[i][0] <= target, or arr.length. */
function rangeStartDesc(arr: Array<[number, unknown]>, target: number): number {
  let lo = 0, hi = arr.length - 1, result = arr.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] <= target) { result = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return result;
}

/** Descending array: last index where arr[i][0] >= target, or -1. */
function rangeEndDesc(arr: Array<[number, unknown]>, target: number): number {
  let lo = 0, hi = arr.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] >= target) { result = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}
