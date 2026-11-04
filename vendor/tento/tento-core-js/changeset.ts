/**
 * Set-based changeset for ID-based diffing.
 * Compares two sets and returns which items were added, kept, or removed.
 */
export type SetChangeset<T = string> = {
  added: T[];
  kept: T[];
  removed: T[];
};

export namespace SetChangeset {
  /**
   * Compute the difference between two sets of IDs.
   * O(n) complexity using Set lookups.
   */
  export function diff<T>(oldSet: Set<T>, newSet: Set<T>): SetChangeset<T> {
    const added: T[] = [];
    const kept: T[] = [];
    const removed: T[] = [];

    // Find removed and kept items
    for (const item of oldSet) {
      if (newSet.has(item)) {
        kept.push(item);
      } else {
        removed.push(item);
      }
    }

    // Find added items
    for (const item of newSet) {
      if (!oldSet.has(item)) {
        added.push(item);
      }
    }

    return { added, kept, removed };
  }

  /**
   * Compute diff from array of IDs using a key function.
   */
  export function diffBy<T, K>(
    oldItems: T[],
    newItems: T[],
    keyFn: (item: T) => K,
  ): SetChangeset<K> {
    const oldSet = new Set(oldItems.map(keyFn));
    const newSet = new Set(newItems.map(keyFn));
    return diff(oldSet, newSet);
  }

  /**
   * Check if the changeset has any changes.
   */
  export function hasChanges<T>(changeset: SetChangeset<T>): boolean {
    return changeset.added.length > 0 || changeset.removed.length > 0;
  }
}

/**
 * Key alignment shared by the two commit compilers of the sheet binder: the
 * positional edit script (`Changeset.make`, a Levenshtein script) and the
 * scene compiler's anchors (`lcsAnchors` in sheets-ui's commit-bundle.ts, a
 * longest common subsequence). Both used to fill a full `(n+1)×(m+1)` table
 * on every column bind, keys unchanged or not — quadratic in sheet rows.
 *
 * `alignKeys` keeps their answers exactly and does the work the change needs:
 *
 * 1. equal sequences (by identity or element-wise) → `"equal"` in O(n);
 * 2. the common prefix and suffix are trimmed where the walk that reads the
 *    table cannot tell the difference (see `trimmedEnds`);
 * 3. the middle gets a BANDED table (Ukkonen): only cells within `band` of
 *    the diagonal, the band doubling until the cost fits inside it, so the
 *    work is O((n+m)·D) for an edit of cost D. A cell outside the band reads
 *    as more than any cost the walk compares against, and every cell the walk
 *    compares is exact once `cost < band` (an optimal path never strays
 *    further from the diagonal than its cost), so the walk takes exactly the
 *    steps it takes over the full table.
 *
 * `cellsComputed` counts the table cells filled, process-wide — the work
 * counter the binder-commit bench gates (zero when keys are unchanged).
 */
export namespace KeyAlignment {
  /** How a mismatch may be repaired: Levenshtein (substitute, insert, delete) or LCS (insert, delete only). */
  export type Costs = "levenshtein" | "indel";

  /**
   * Which end the reading walk starts from. Its own end is always safe to
   * trim; the other end only when the keys are distinct (`trimmedEnds`).
   * `"from-end"`: a backtrack from `(n, m)` over a prefix table (`Changeset.make`).
   * `"from-start"`: a walk from `(0, 0)` over a suffix table (`lcsAnchors`).
   */
  export type Walk = "from-end" | "from-start";

  /** The cost table over the untrimmed middle, in middle coordinates. */
  export interface Table {
    /** Rows (`a`'s middle length) and columns (`b`'s middle length). */
    readonly n: number;
    readonly m: number;
    /** The edit cost of the whole middle (prefix walk: `at(n, m)`; suffix walk: `at(0, 0)`). */
    readonly cost: number;
    /**
     * The cost at `(i, j)`: for `"from-end"` the cost of turning `a[0..i)`
     * into `b[0..j)`; for `"from-start"` of turning `a[i..n)` into `b[j..m)`
     * (middle coordinates). Exact for every cell an optimal walk compares;
     * larger than any such cost elsewhere.
     */
    at(i: number, j: number): number;
  }

  /** `alignKeys`'s answer. */
  export type Alignment =
    | { readonly kind: "equal" }
    | {
      readonly kind: "edit";
      /** Leading positions where `a[k] === b[k]` (non-null) that the walk treats as matched. */
      readonly prefix: number;
      /** Trailing positions matched likewise. */
      readonly suffix: number;
      /** The middle's cost table. */
      readonly table: Table;
    };

  let computed = 0;

  /** Table cells filled since the process started (work counter; see the namespace notes). */
  export function cellsComputed(): number {
    return computed;
  }

  /** Whether `a` and `b` hold the same keys in the same order. */
  export function same(a: readonly Option<string>[], b: readonly Option<string>[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
    return true;
  }

  /** Whether the non-null keys of `keys` are pairwise distinct. */
  export function distinct(keys: readonly Option<string>[]): boolean {
    const seen = new Set<string>();
    for (const key of keys) {
      if (key == null) continue;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  }

  /**
   * The prefix and suffix the walk may skip. Matches at the walk's own end are
   * taken first by both walks (a match is always an optimal step), so that
   * end trims unconditionally. At the far end a trimmed walk stops at the
   * prefix (or suffix) boundary, where the full walk would keep stepping
   * through the matched run; the two take the same steps unless a key of the
   * run reappears beyond it, which needs a duplicate key — so the far end
   * trims only when both sides' non-null keys are distinct.
   */
  function trimmedEnds(
    a: readonly Option<string>[],
    b: readonly Option<string>[],
    walk: Walk,
  ): { prefix: number; suffix: number } {
    const limit = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < limit && a[prefix] != null && a[prefix] === b[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < limit - prefix &&
      a[a.length - 1 - suffix] != null &&
      a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) suffix += 1;
    if ((prefix > 0 || suffix > 0) && !(distinct(a) && distinct(b))) {
      if (walk === "from-end") prefix = 0;
      else suffix = 0;
      // Re-measure the safe end alone (the far end's trim no longer bounds it).
      if (walk === "from-end") {
        suffix = 0;
        while (
          suffix < limit &&
          a[a.length - 1 - suffix] != null &&
          a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
        ) suffix += 1;
      }
    }
    return { prefix, suffix };
  }

  /** Larger than any cost a walk compares (`n + m` bounds every cost). */
  const FAR = 0x3fffffff;

  /**
   * The banded prefix-cost table of `x` against `y` (`x[i]`/`y[j]` read through
   * accessors so a suffix table is the prefix table of the reversed middle).
   */
  function prefixTable(
    n: number,
    m: number,
    match: (i: number, j: number) => boolean,
    costs: Costs,
  ): { readonly cost: number; at(i: number, j: number): number } {
    const span = Math.max(n, m);
    let band = Math.max(8, Math.abs(n - m) + 8);
    for (;;) {
      const full = band >= span || 2 * band + 1 >= m + 1;
      const width = full ? m + 1 : 2 * band + 1;
      const cells = new Int32Array((n + 1) * width);
      const slot = full
        ? (i: number, j: number): number => i * width + j
        : (i: number, j: number): number => i * width + (j - i + band);
      const read = (i: number, j: number): number => {
        if (i < 0 || j < 0 || i > n || j > m) return FAR;
        if (!full && (j - i > band || i - j > band)) return FAR;
        return cells[slot(i, j)] ?? FAR;
      };
      for (let i = 0; i <= n; i++) {
        const lo = full ? 0 : Math.max(0, i - band);
        const hi = full ? m : Math.min(m, i + band);
        for (let j = lo; j <= hi; j++) {
          let v: number;
          if (i === 0) v = j;
          else if (j === 0) v = i;
          else if (costs === "levenshtein") {
            v = Math.min(
              read(i, j - 1) + 1,
              read(i - 1, j) + 1,
              read(i - 1, j - 1) + (match(i - 1, j - 1) ? 0 : 1),
            );
          } else {
            v = match(i - 1, j - 1) ? read(i - 1, j - 1) : Math.min(read(i - 1, j), read(i, j - 1)) + 1;
          }
          cells[slot(i, j)] = Math.min(v, FAR);
        }
        computed += hi - lo + 1;
      }
      const cost = read(n, m);
      if (full || cost < band) return { cost, at: read };
      band *= 2;
    }
  }

  /**
   * Align `a` (the pool: live keys, `null` for a never-bound slot that matches
   * nothing) with `b` (the target), for a walk of `walk` over `costs`. See the
   * namespace notes for what is exact and why.
   */
  export function alignKeys(
    a: readonly Option<string>[],
    b: readonly Option<string>[],
    costs: Costs,
    walk: Walk,
  ): Alignment {
    if (same(a, b) && !a.some((key) => key == null)) return { kind: "equal" };
    const { prefix, suffix } = trimmedEnds(a, b, walk);
    const n = a.length - prefix - suffix;
    const m = b.length - prefix - suffix;
    const matches = (x: Option<string>, y: Option<string>): boolean => x != null && x === y;
    if (walk === "from-end") {
      const t = prefixTable(n, m, (i, j) => matches(a[prefix + i], b[prefix + j]), costs);
      return { kind: "edit", prefix, suffix, table: { n, m, cost: t.cost, at: t.at } };
    }
    // Suffix costs of the middle = prefix costs of the reversed middle.
    const t = prefixTable(n, m, (i, j) => matches(a[prefix + n - 1 - i], b[prefix + m - 1 - j]), costs);
    return {
      kind: "edit",
      prefix,
      suffix,
      table: { n, m, cost: t.cost, at: (i, j) => t.at(n - i, m - j) },
    };
  }
}

/** {@link KeyAlignment.alignKeys}. */
export const alignKeys = KeyAlignment.alignKeys;

/**
 * Sequence-based changeset for ordered array diffing: the Levenshtein edit
 * script of `source` → `target`.
 */
export type Changeset = {
  type: "replace" | "insert" | "delete";
  index: number;
  value?: string;
};

export namespace Changeset {
  /**
   * The edit script that turns `source` into `target`, in the order to APPLY
   * it: the backtrack's order, from the tail to the head, so each op's
   * `index` names a position the ops before it have not shifted (replace and
   * delete at the source position, insert before it).
   *
   * The script is the one the full Levenshtein table's backtrack gives
   * (prefer a match, then replace, insert, delete); `alignKeys` computes it
   * over a banded table of the changed middle only, and an unchanged key
   * list costs one comparison per key.
   *
   * Order: this used to reverse the backtrack and then sort with a
   * comparator that indexed the op objects as tuples (`a[0]`, `a[1]`), so
   * every comparison returned -1 and V8's sort reversed the array back into
   * backtrack order. The script is now emitted in that order directly; the
   * ops are byte-identical, minus the inconsistent comparator.
   */
  export function make(
    source: readonly Option<string>[],
    target: readonly string[],
  ): Changeset[] {
    const changes: Changeset[] = [];
    const aligned = alignKeys(source, target, "levenshtein", "from-end");
    if (aligned.kind === "equal") return changes;
    const { prefix, suffix, table } = aligned;

    let i = source.length - suffix;
    let j = target.length - suffix;
    while (i > prefix && j > prefix) {
      const ti = i - prefix;
      const tj = j - prefix;
      const here = table.at(ti, tj);
      if (source[i - 1] === target[j - 1]) {
        i--;
        j--;
      } else if (here === table.at(ti - 1, tj - 1) + 1) {
        changes.push({ type: "replace", index: i - 1, value: target[j - 1] });
        i--;
        j--;
      } else if (here === table.at(ti, tj - 1) + 1) {
        changes.push({ type: "insert", index: i, value: target[j - 1] });
        j--;
      } else if (here === table.at(ti - 1, tj) + 1) {
        changes.push({ type: "delete", index: i - 1 });
        i--;
      } else {
        throw new Error("Changeset.make: the cost table has no step from (" + i + ", " + j + ")");
      }
    }

    // One side is exhausted: the rest of the other is inserted at (or deleted
    // down to) the walk's position.
    while (j > prefix) {
      changes.push({ type: "insert", index: i, value: target[j - 1] });
      j--;
    }
    while (i > prefix) {
      changes.push({ type: "delete", index: i - 1 });
      i--;
    }

    return changes;
  }
}
