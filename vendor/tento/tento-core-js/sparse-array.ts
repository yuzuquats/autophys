import { NumRangeLike } from "@tento-core/range";

type AppendRequest<T> = {
  range: NumRangeLike;
  points: Array<[number, T]>;
  resolve: () => void;
  loggingId?: Option<string>;
};

/**
 * SparseArray stores values at arbitrary integer indices without using proxies.
 * Optimized for streaming data where ranges are appended over time.
 *
 * Uses a pivot-based 2-pointer design:
 * - The first data chunk establishes a "pivot" point
 * - Data below pivot goes to lowerData (descending order)
 * - Data at/above pivot goes to upperData (ascending order)
 * - This allows O(1) push to either end for bidirectional growth
 */
export class SparseArray<T> {
  // Pivot point established by first data chunk
  // All data classification is relative to this value
  private pivot: Option<number> = null;

  // Stores data BELOW pivot in DESCENDING order
  // Points closest to pivot come first: [pivot-1, pivot-5, pivot-10, ...]
  readonly lowerData: Array<[number, T]> = [];

  // Stores data AT/ABOVE pivot in ASCENDING order
  // Points closest to pivot come first: [pivot, pivot+1, pivot+5, ...]
  readonly upperData: Array<[number, T]> = [];

  // Cached range for quick access
  private _validRange: Option<NumRangeLike> = null;

  // Buffer for out-of-order append requests
  private pendingRequests: Array<AppendRequest<T>> = [];

  /**
   * Get the current valid data range (union of all appended ranges)
   */
  get validRange(): Option<NumRangeLike> {
    return this._validRange;
  }

  /**
   * Reset the sparse array to empty state.
   * Resolves any pending buffered requests (so their promises don't hang)
   * before clearing all data.
   */
  reset(): void {
    for (const req of this.pendingRequests) {
      req.resolve();
    }
    this.pendingRequests = [];
    this.pivot = null;
    this._validRange = null;
    this.lowerData.length = 0;
    this.upperData.length = 0;
  }

  /**
   * Append streaming data to the sparse array.
   * Handles out-of-order appends by buffering requests until they become
   * continuous with the valid range.
   * @param range - The range this data covers
   * @param points - Array of [index, value] pairs within the range
   * @returns Promise that resolves when the data has been flushed (not just buffered)
   */
  append(
    range: NumRangeLike,
    points: Array<[number, T]>,
    loggingId?: Option<string>,
  ): Promise<void> {
    // Determine pivot: use existing or establish from first chunk
    const pivotValue = this.pivot ?? Math.floor((range.start + range.end) / 2);

    // Separate and sort points relative to pivot
    const lowerPoints: Array<[number, T]> = [];
    const upperPoints: Array<[number, T]> = [];
    for (const pt of points) {
      if (pt[0] < pivotValue) {
        lowerPoints.push(pt);
      } else {
        upperPoints.push(pt);
      }
    }
    // Lower: descending (closest to pivot first, so they can be pushed)
    lowerPoints.sort((a, b) => b[0] - a[0]);
    // Upper: ascending (closest to pivot first, so they can be pushed)
    upperPoints.sort((a, b) => a[0] - b[0]);
    const sortedPoints = [...lowerPoints, ...upperPoints];

    return new Promise((resolve) => {
      // Try to flush this request directly
      if (this.tryFlush({ range, points: sortedPoints, resolve, loggingId })) {
        // After successful flush, try flushing any pending requests
        this.flushPending(loggingId);
        resolve();
        return;
      }

      // Buffer the request - resolve will be called when flushed
      this.pendingRequests.push({ range, points: sortedPoints, resolve, loggingId });
    });
  }

  private tryFlush(request: AppendRequest<T>): boolean {
    const { range, points } = request;

    // First data - always flush
    if (this._validRange === null) {
      this.doAppend(range, points);
      return true;
    }

    const validRange = this._validRange!;

    // IMPORTANT: Check continuous ranges BEFORE overlap check!
    // During cascade flush, a buffered request's range may now be "inside"
    // the expanded validRange, but if it's continuous we should still add
    // all its points (not filter them as overlapping).

    // Continuous with start (growing down/negative)
    if (range.end === validRange.start) {
      this.doPrependSorted(range, points);
      return true;
    }

    // Continuous with end (growing up/positive)
    if (range.start === validRange.end) {
      this.doAppend(range, points);
      return true;
    }

    // Check if range overlaps with valid range
    const overlaps = range.start < validRange.end && range.end > validRange.start;

    if (overlaps) {
      // Handle overlapping ranges by separating points into prepend (below) and append (above)
      const prependPoints: Array<[number, T]> = [];
      const appendPoints: Array<[number, T]> = [];

      for (const pt of points) {
        if (pt[0] < validRange.start) {
          prependPoints.push(pt);
        } else if (pt[0] >= validRange.end) {
          appendPoints.push(pt);
        }
        // Points within validRange are discarded (already exist)
      }

      // Prepend points that extend below existing range
      if (prependPoints.length > 0) {
        const prependRange: NumRangeLike = {
          start: Math.min(range.start, validRange.start),
          end: validRange.start,
        };
        this.doPrependSorted(prependRange, prependPoints);
      }

      // Append points that extend above existing range
      if (appendPoints.length > 0) {
        const appendRange: NumRangeLike = {
          start: validRange.end,
          end: Math.max(range.end, validRange.end),
        };
        this.doAppend(appendRange, appendPoints);
      }

      return true;
    }

    return false;
  }

  private flushPending(_loggingId?: Option<string>): void {
    if (this.pendingRequests.length === 0) return;
    if (this._validRange === null) return;

    // Sort pending requests by range start (ascending)
    this.pendingRequests.sort((a, b) => a.range.start - b.range.start);

    let flushed = true;
    while (flushed) {
      flushed = false;

      // Try to extend validRange downward (toward lower indices)
      // Find a request whose range.end === validRange.start
      let connectingIdx = -1;
      for (let i = this.pendingRequests.length - 1; i >= 0; i--) {
        if (this.pendingRequests[i].range.end === this._validRange!.start) {
          connectingIdx = i;
          break;
        }
      }

      if (connectingIdx >= 0) {
        // Walk backward to find the start of the continuous chain
        // Since array is sorted by range.start, we check if adjacent entries connect
        let chainStartIdx = connectingIdx;
        while (chainStartIdx > 0) {
          const prev = this.pendingRequests[chainStartIdx - 1];
          const curr = this.pendingRequests[chainStartIdx];
          if (prev.range.end === curr.range.start) {
            chainStartIdx--;
          } else {
            break; // Gap found, stop extending
          }
        }

        // Flush the entire chain from chainStartIdx to connectingIdx
        // Collect all points from the chain
        const resolveFns: (() => void)[] = [];
        const allChainPoints: Array<[number, T]> = [];
        let chainRangeStart = Infinity;
        let chainRangeEnd = -Infinity;

        for (let i = chainStartIdx; i <= connectingIdx; i++) {
          const req = this.pendingRequests[i];
          allChainPoints.push(...req.points);
          chainRangeStart = Math.min(chainRangeStart, req.range.start);
          chainRangeEnd = Math.max(chainRangeEnd, req.range.end);
          resolveFns.push(req.resolve);
        }
        this.pendingRequests.splice(chainStartIdx, connectingIdx - chainStartIdx + 1);

        // Re-sort all chain points relative to the ACTUAL pivot
        // (buffered requests were sorted with their own range's pivot, not the established one)
        const pivotValue = this.pivot!;
        const lowerPoints: Array<[number, T]> = [];
        const upperPoints: Array<[number, T]> = [];
        for (const pt of allChainPoints) {
          if (pt[0] < pivotValue) {
            lowerPoints.push(pt);
          } else {
            upperPoints.push(pt);
          }
        }
        lowerPoints.sort((a, b) => b[0] - a[0]); // descending
        upperPoints.sort((a, b) => a[0] - b[0]); // ascending
        const sortedChainPoints = [...lowerPoints, ...upperPoints];

        // Prepend the chain data (which has lower indices than existing data)
        this.doPrependSorted(
          { start: chainRangeStart, end: chainRangeEnd },
          sortedChainPoints,
        );

        // Now resolve all promises
        for (const resolve of resolveFns) {
          resolve();
        }

        flushed = true;
        continue; // Re-check from start after modification
      }

      // Try to extend validRange upward (toward higher indices)
      // Find a request whose range.start === validRange.end
      connectingIdx = -1;
      for (let i = 0; i < this.pendingRequests.length; i++) {
        if (this.pendingRequests[i].range.start === this._validRange!.end) {
          connectingIdx = i;
          break;
        }
      }

      if (connectingIdx >= 0) {
        // Walk forward to find the end of the continuous chain
        let chainEndIdx = connectingIdx;
        while (chainEndIdx < this.pendingRequests.length - 1) {
          const curr = this.pendingRequests[chainEndIdx];
          const next = this.pendingRequests[chainEndIdx + 1];
          if (curr.range.end === next.range.start) {
            chainEndIdx++;
          } else {
            break; // Gap found, stop extending
          }
        }

        // Flush the entire chain from connectingIdx to chainEndIdx
        // Collect all points
        const resolveFnsUp: (() => void)[] = [];
        const allChainPointsUp: Array<[number, T]> = [];
        let chainRangeStartUp = Infinity;
        let chainRangeEndUp = -Infinity;

        for (let i = connectingIdx; i <= chainEndIdx; i++) {
          const req = this.pendingRequests[i];
          allChainPointsUp.push(...req.points);
          chainRangeStartUp = Math.min(chainRangeStartUp, req.range.start);
          chainRangeEndUp = Math.max(chainRangeEndUp, req.range.end);
          resolveFnsUp.push(req.resolve);
        }
        this.pendingRequests.splice(connectingIdx, chainEndIdx - connectingIdx + 1);

        // Re-sort all chain points relative to the ACTUAL pivot
        // (buffered requests were sorted with their own range's pivot, not the established one)
        const pivotValueUp = this.pivot!;
        const lowerPointsUp: Array<[number, T]> = [];
        const upperPointsUp: Array<[number, T]> = [];
        for (const pt of allChainPointsUp) {
          if (pt[0] < pivotValueUp) {
            lowerPointsUp.push(pt);
          } else {
            upperPointsUp.push(pt);
          }
        }
        lowerPointsUp.sort((a, b) => b[0] - a[0]); // descending
        upperPointsUp.sort((a, b) => a[0] - b[0]); // ascending
        const sortedChainPointsUp = [...lowerPointsUp, ...upperPointsUp];

        // Append the chain data (which has higher indices than existing data)
        this.doAppend(
          { start: chainRangeStartUp, end: chainRangeEndUp },
          sortedChainPointsUp,
        );

        // Now resolve all promises
        for (const resolve of resolveFnsUp) {
          resolve();
        }

        flushed = true;
      }
    }
  }

  private doAppend(range: NumRangeLike, points: Array<[number, T]>): void {
    // Establish pivot on first data
    if (this.pivot === null) {
      this.pivot = Math.floor((range.start + range.end) / 2);
    }

    // Update valid range
    this._validRange = this._validRange
      ? {
          start: Math.min(this._validRange.start, range.start),
          end: Math.max(this._validRange.end, range.end),
        }
      : { ...range };

    // Push points to appropriate arrays based on pivot
    const pivotValue = this.pivot!; // pivot is set above
    let lowerAdded = 0;
    let upperAdded = 0;
    for (const [index, value] of points) {
      if (index < pivotValue) {
        this.lowerData.push([index, value]);
        lowerAdded++;
      } else {
        this.upperData.push([index, value]);
        upperAdded++;
      }
    }
  }

  /**
   * Prepend points that are known to have indices LOWER than all existing data.
   * This maintains sorted order by prepending to the arrays.
   * The prependPoints must already be sorted (descending for lower, ascending for upper).
   */
  private doPrependSorted(
    range: NumRangeLike,
    prependPoints: Array<[number, T]>,
  ): void {
    // Establish pivot on first data
    if (this.pivot === null) {
      this.pivot = Math.floor((range.start + range.end) / 2);
    }

    // Update valid range
    this._validRange = this._validRange
      ? {
          start: Math.min(this._validRange.start, range.start),
          end: Math.max(this._validRange.end, range.end),
        }
      : { ...range };

    // Separate points by pivot, maintaining order
    const lowerPoints: Array<[number, T]> = [];
    const upperPoints: Array<[number, T]> = [];
    const pivotValue = this.pivot!; // pivot is set above

    for (const [index, value] of prependPoints) {
      if (index < pivotValue) {
        lowerPoints.push([index, value]);
      } else {
        upperPoints.push([index, value]);
      }
    }

    // For prepending:
    // - upperData is ascending, so new lower values need to go at the front
    // - lowerData is descending, so new lower values (more negative relative to pivot) go at the end
    if (upperPoints.length > 0) {
      this.upperData.unshift(...upperPoints);
    }
    if (lowerPoints.length > 0) {
      // lowerData is descending, and these are even lower values, so push to end
      this.lowerData.push(...lowerPoints);
    }
  }

  /**
   * Get value at specific index
   * @param index - Index to lookup
   * @returns Value at index or null if not present
   */
  get(index: number): Option<T> {
    if (this.pivot == null) return null;
    const pivotValue = this.pivot;

    if (index < pivotValue) {
      const pos = this.binarySearch(this.lowerData, index, false); // descending
      return pos < this.lowerData.length && this.lowerData[pos][0] === index
        ? this.lowerData[pos][1]
        : null;
    } else {
      const pos = this.binarySearch(this.upperData, index, true); // ascending
      return pos < this.upperData.length && this.upperData[pos][0] === index
        ? this.upperData[pos][1]
        : null;
    }
  }

  /**
   * Get array indices for efficient range iteration without copying data
   * @param start - Start of range (inclusive)
   * @param end - End of range (inclusive)
   * @returns Object with start/end indices for lower and upper arrays
   */
  getRangeIndices(
    start: number,
    end: number,
  ): {
    lower: { start: number; end: number } | null;
    upper: { start: number; end: number } | null;
  } {
    if (start > end || this.pivot == null) {
      return { lower: null, upper: null };
    }
    const pivotValue = this.pivot;

    let lower: { start: number; end: number } | null = null;
    let upper: { start: number; end: number } | null = null;

    // lowerData is descending: [pivot-1, pivot-5, pivot-10, ...]
    // For range [start, end], we want elements where start <= index <= min(end, pivot-1)
    if (start < pivotValue && this.lowerData.length > 0) {
      const lowerEnd = Math.min(end, pivotValue - 1);
      // In descending array, smaller values come later
      // startIdx = first element <= lowerEnd (closest to pivot in our range)
      // endIdx = last element >= start (farthest from pivot in our range)
      const startIdx = this.findRangeStartDescending(this.lowerData, lowerEnd);
      const endIdx = this.findRangeEndDescending(this.lowerData, start);

      if (startIdx <= endIdx) {
        lower = { start: startIdx, end: endIdx };
      }
    }

    // upperData is ascending: [pivot, pivot+1, pivot+5, ...]
    if (end >= pivotValue && this.upperData.length > 0) {
      const upperStart = Math.max(start, pivotValue);
      const startIdx = this.findRangeStart(this.upperData, upperStart);
      const endIdx = this.findRangeEnd(this.upperData, end);

      if (startIdx <= endIdx) {
        upper = { start: startIdx, end: endIdx };
      }
    }

    return { lower, upper };
  }

  /**
   * Get the number of stored data points
   */
  get size(): number {
    return this.lowerData.length + this.upperData.length;
  }

  /**
   * Get the next point after the given index
   * @param index - Index to search after
   * @returns Tuple of [index, value] or null if no point exists after the given index
   */
  getNextPoint(index: number): Option<[number, T]> {
    if (this.pivot == null) return null;
    const pivotValue = this.pivot;

    // If index is below pivot, check lowerData first
    // lowerData is descending: [pivot-1, pivot-5, pivot-10], so "next" (larger) is earlier in array
    if (index < pivotValue - 1 && this.lowerData.length > 0) {
      // Find first element <= index, then go one before it (which is > index)
      const pos = this.findRangeStartDescending(this.lowerData, index);
      if (pos > 0) {
        return this.lowerData[pos - 1];
      }
      // If pos is 0, check if first element is > index
      if (pos === 0 && this.lowerData[0][0] > index) {
        return this.lowerData[0];
      }
    }

    // If index is in lower range, check if there's a lower element > index (closer to pivot)
    if (index < pivotValue && this.lowerData.length > 0) {
      if (this.lowerData[0][0] > index) {
        return this.lowerData[0];
      }
    }

    // Check upperData if index >= pivot - 1
    if (index >= pivotValue - 1 && this.upperData.length > 0) {
      const targetIndex = Math.max(pivotValue, index + 1);
      const pos = this.findRangeStart(this.upperData, targetIndex);
      if (pos < this.upperData.length) {
        return this.upperData[pos];
      }
    }

    // If index is below pivot but no lower elements > index, check upper
    if (index < pivotValue && this.upperData.length > 0) {
      return this.upperData[0];
    }

    return null;
  }

  /**
   * Get the previous point before the given index
   * @param index - Index to search before
   * @returns Tuple of [index, value] or null if no point exists before the given index
   */
  getPreviousPoint(index: number): Option<[number, T]> {
    if (this.pivot == null) return null;
    const pivotValue = this.pivot;

    // Check upperData first if index > pivot
    if (index > pivotValue && this.upperData.length > 0) {
      const pos = this.findRangeEnd(this.upperData, index - 1);
      if (pos >= 0) {
        return this.upperData[pos];
      }
    }

    // If index is at/above pivot but no upper elements < index, check lower
    // lowerData is descending: [pivot-1, pivot-5, pivot-10], so first element is closest to pivot
    if (index >= pivotValue && this.lowerData.length > 0) {
      return this.lowerData[0];
    }

    // Check lowerData if index <= pivot
    // lowerData is descending, so "previous" (smaller) is later in array
    if (index <= pivotValue && this.lowerData.length > 0) {
      const targetIndex = index - 1;
      // Find last element >= targetIndex would give us elements too large
      // We want elements < index, so find first element < index
      const pos = this.findRangeEndDescending(this.lowerData, targetIndex);
      // pos is last element >= targetIndex, so pos+1 is first element < targetIndex
      if (pos + 1 < this.lowerData.length) {
        return this.lowerData[pos + 1];
      }
      // Check if there's any element < index
      if (pos >= 0 && this.lowerData[pos][0] < index) {
        return this.lowerData[pos];
      }
    }

    return null;
  }

  // Private helper methods

  /**
   * Binary search helper for finding insertion/lookup positions
   * @param array - Array to search in
   * @param index - Index to find
   * @param ascending - Whether array is sorted ascending (true) or descending (false)
   * @returns Position where index is found or should be inserted
   */
  private binarySearch(
    array: Array<[number, T]>,
    index: number,
    ascending: boolean,
  ): number {
    let left = 0;
    let right = array.length - 1;
    const compareFn = ascending
      ? (a: number, b: number) => a - b
      : (a: number, b: number) => b - a;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const cmp = compareFn(array[mid][0], index);
      if (cmp === 0) return mid;
      if (cmp < 0) left = mid + 1;
      else right = mid - 1;
    }
    return left; // insertion point
  }

  /**
   * Find the first array index where the element's index >= targetIndex
   * @param array - Array to search (must be sorted ascending)
   * @param targetIndex - Index to find the start position for
   * @returns Array index of first element >= targetIndex, or array.length if none found
   */
  private findRangeStart(
    array: Array<[number, T]>,
    targetIndex: number,
  ): number {
    let left = 0;
    let right = array.length - 1;
    let result = array.length;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (array[mid][0] >= targetIndex) {
        result = mid;
        right = mid - 1; // Look for earlier occurrence
      } else {
        left = mid + 1;
      }
    }

    return result;
  }

  /**
   * Find the last array index where the element's index <= targetIndex
   * @param array - Array to search (must be sorted ascending)
   * @param targetIndex - Index to find the end position for
   * @returns Array index of last element <= targetIndex, or -1 if none found
   */
  private findRangeEnd(array: Array<[number, T]>, targetIndex: number): number {
    let left = 0;
    let right = array.length - 1;
    let result = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (array[mid][0] <= targetIndex) {
        result = mid;
        left = mid + 1; // Look for later occurrence
      } else {
        right = mid - 1;
      }
    }

    return result;
  }

  /**
   * Find first element <= targetIndex in descending array
   * @param array - Array to search (must be sorted descending)
   * @param targetIndex - Index to find the start position for
   * @returns Array index of first element <= targetIndex, or array.length if none found
   */
  private findRangeStartDescending(
    array: Array<[number, T]>,
    targetIndex: number,
  ): number {
    let left = 0;
    let right = array.length - 1;
    let result = array.length;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (array[mid][0] <= targetIndex) {
        result = mid;
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    return result;
  }

  /**
   * Find last element >= targetIndex in descending array
   * @param array - Array to search (must be sorted descending)
   * @param targetIndex - Index to find the end position for
   * @returns Array index of last element >= targetIndex, or -1 if none found
   */
  private findRangeEndDescending(
    array: Array<[number, T]>,
    targetIndex: number,
  ): number {
    let left = 0;
    let right = array.length - 1;
    let result = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (array[mid][0] >= targetIndex) {
        result = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    return result;
  }

  iter(range: NumRangeLike, fn: (d: [number, T]) => void) {
    for (const i of iterateSparseRange(this, range.start, range.end)) {
      fn(i);
    }
  }
}

/**
 * Standalone iterator function for efficient range iteration.
 * Uses direct array access with pre-computed indices to avoid method call overhead.
 * @param sparseArray - The SparseArray to iterate over
 * @param start - Start of range (inclusive)
 * @param end - End of range (inclusive)
 * @returns Generator that yields [index, value] pairs in ascending order
 */
export function* iterateSparseRange<T>(
  sparseArray: SparseArray<T>,
  start: number,
  end: number,
): Generator<[number, T]> {
  if (start > end) return;

  const indices = sparseArray.getRangeIndices(start, end);

  // Yield from lower array in reverse (descending storage -> ascending output)
  if (indices.lower) {
    const lowerArr = sparseArray.lowerData;
    for (let i = indices.lower.end; i >= indices.lower.start; i--) {
      yield lowerArr[i];
    }
  }

  // Then yield from upper array (already in ascending order)
  if (indices.upper) {
    const upperArr = sparseArray.upperData;
    for (let i = indices.upper.start; i <= indices.upper.end; i++) {
      yield upperArr[i];
    }
  }
}

/**
 * Get range data as arrays with direct access - most performant for tight loops.
 * @param sparseArray - The SparseArray to query
 * @param start - Start of range (inclusive)
 * @param end - End of range (inclusive)
 * @returns Object with array references and indices for manual iteration
 */
export function getSparseRangeArrays<T>(
  sparseArray: SparseArray<T>,
  start: number,
  end: number,
): {
  lowerArray: Array<[number, T]> | null;
  lowerStart: number;
  lowerEnd: number;
  upperArray: Array<[number, T]> | null;
  upperStart: number;
  upperEnd: number;
} {
  if (start > end) {
    return {
      lowerArray: null,
      lowerStart: -1,
      lowerEnd: -1,
      upperArray: null,
      upperStart: -1,
      upperEnd: -1,
    };
  }

  const indices = sparseArray.getRangeIndices(start, end);

  return {
    lowerArray: indices.lower ? sparseArray.lowerData : null,
    lowerStart: indices.lower?.start ?? -1,
    lowerEnd: indices.lower?.end ?? -1,
    upperArray: indices.upper ? sparseArray.upperData : null,
    upperStart: indices.upper?.start ?? -1,
    upperEnd: indices.upper?.end ?? -1,
  };
}
