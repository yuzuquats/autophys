/**
 * Unit tests for `SortedDeque` — focuses on the regression family
 * around delete/re-insert at the pivot split.
 *
 * Bug shape: after a `deleteByKey` that empties the pivot's
 * bucket, the next `upsert` could place its entry in `lowerData`
 * via `_insertNew`'s min/max-key heuristic — even though
 * `dse >= _pivot`. Subsequent `upsert(dse, ...)` on the same key
 * would then `_replaceExisting` against the wrong array (chosen
 * by `dse >= _pivot`) and silently fail, leaving `_map`'s pointer
 * out of sync with the array contents. From there `cells()`
 * returned stale entries and `deleteByKey` returned `false`
 * because identity match against either array failed.
 *
 * The contract is that `_insertNew` preserves the pivot split
 * (`lowerData` < pivot, `upperData` >= pivot) and `_replaceExisting`
 * still scans both arrays defensively.
 */

import { assertEquals, assert } from "jsr:@std/assert";

import { SortedDeque } from "../../sorted-deque.ts";

interface Entry {
  key: string;
  value: number;
}

function makeDeque(): SortedDeque<Entry, string> {
  return new SortedDeque<Entry, string>((e) => e.key);
}

// ─── Baseline correctness ────────────────────────────────────────

Deno.test("SortedDeque — empty", () => {
  const d = makeDeque();
  assertEquals(d.size, 0);
  assertEquals(d.get("nope"), undefined);
});

Deno.test("SortedDeque — upsert/get roundtrip", () => {
  const d = makeDeque();
  d.upsert(10, { key: "a", value: 1 });
  d.upsert(20, { key: "b", value: 2 });
  assertEquals(d.size, 2);
  assertEquals(d.get("a"), { key: "a", value: 1 });
  assertEquals(d.get("b"), { key: "b", value: 2 });
});

Deno.test("SortedDeque — upsert replaces in place by secondary key", () => {
  const d = makeDeque();
  d.upsert(10, { key: "a", value: 1 });
  d.upsert(10, { key: "a", value: 99 });
  assertEquals(d.size, 1);
  assertEquals(d.get("a")?.value, 99);
});

Deno.test("SortedDeque — deleteByKey removes from both _map and arrays", () => {
  const d = makeDeque();
  d.upsert(10, { key: "a", value: 1 });
  d.upsert(20, { key: "b", value: 2 });
  assertEquals(d.deleteByKey("a"), true);
  assertEquals(d.size, 1);
  assertEquals(d.get("a"), undefined);
  assertEquals(d.deleteByKey("a"), false);
});

// ─── Regression: pivot delete/re-insert paths ────────────

Deno.test(
  "SortedDeque regression — clear then re-insert at the previous pivot, then upsert again, replaces in place",
  () => {
    // Shape: build a deque where _pivot lands on the entry we'll
    // delete first. Pre-fix, subsequent _insertNew at the same dse
    // routed via the min/max-key heuristic to lowerData and the
    // second upsert silently no-op'd.
    const d = makeDeque();
    d.upsert(10, { key: "a", value: 1 });
    d.upsert(11, { key: "b", value: 2 });
    d.upsert(12, { key: "c", value: 3 });
    // After init: _pivot is 10 (first inserted), upperData has
    // entries at 10/11/12.

    // Delete the pivot's entry — leaves _pivot at 10 but
    // upperData[0] is now at dse=11.
    assertEquals(d.deleteByKey("a"), true);
    assertEquals(d.size, 2);

    // Re-insert at the same dse.
    d.upsert(10, { key: "a", value: 100 });
    assertEquals(d.size, 3);
    assertEquals(d.get("a")?.value, 100);

    // The bug: this second upsert silently no-op'd pre-fix.
    d.upsert(10, { key: "a", value: 200 });
    assertEquals(d.size, 3);
    assertEquals(
      d.get("a")?.value,
      200,
      "second upsert at the same dse must replace the value",
    );
  },
);

Deno.test(
  "SortedDeque regression — range query sees re-insert at the previous pivot",
  () => {
    const d = makeDeque();
    d.upsert(10, { key: "a", value: 1 });
    d.upsert(11, { key: "b", value: 2 });
    d.upsert(12, { key: "c", value: 3 });

    d.deleteByKey("a");
    d.upsert(10, { key: "a", value: 100 });

    assertEquals(d.getInRange(10, 11).map((entry) => entry.value), [100]);
  },
);

Deno.test(
  "SortedDeque regression — deleteByKey works after re-insert into the unexpected array",
  () => {
    const d = makeDeque();
    d.upsert(10, { key: "a", value: 1 });
    d.upsert(11, { key: "b", value: 2 });
    d.upsert(12, { key: "c", value: 3 });

    d.deleteByKey("a");
    d.upsert(10, { key: "a", value: 100 });
    d.upsert(10, { key: "a", value: 200 });

    // Pre-fix: deleteByKey returned `false` here because the
    // _map pointed at the new entry but neither array contained
    // it (the array still had the previous entry, not yet
    // replaced).
    assertEquals(d.deleteByKey("a"), true);
    assertEquals(d.size, 2);
    assertEquals(d.get("a"), undefined);
  },
);

Deno.test(
  "SortedDeque regression — same-value upsert pair after a clear still leaves a single entry",
  () => {
    // The user-visible symptom from the tento/tento-lona-js/sheets fuzz:
    // duplicate `setCell` after a `clearCell` was leaving the
    // store with an unkillable cell. Pin that the second
    // identical upsert remains a single-entry state.
    const d = makeDeque();
    d.upsert(10, { key: "a", value: 1 });
    d.upsert(11, { key: "b", value: 2 });

    d.deleteByKey("a");
    d.upsert(10, { key: "a", value: 5 });
    d.upsert(10, { key: "a", value: 5 }); // identical re-set

    assertEquals(d.size, 2);
    assertEquals(d.get("a")?.value, 5);

    // And the next deleteByKey must drop it.
    assert(d.deleteByKey("a"));
    assertEquals(d.size, 1);
  },
);

// ─── Coverage: dse < _pivot path also scans both arrays ─────────

Deno.test(
  "SortedDeque — replace-existing finds the entry regardless of which array holds it (dse < pivot variant)",
  () => {
    // Mirror image of the upper-side regression. Build a deque
    // where the pivot is high; delete it; re-insert at a low dse
    // that goes to lowerData; verify replace works.
    const d = makeDeque();
    d.upsert(20, { key: "p", value: 0 }); // pivot = 20
    d.upsert(10, { key: "a", value: 1 }); // lowerData
    d.upsert(15, { key: "b", value: 2 }); // lowerData
    d.deleteByKey("p");

    // Replace `a` (in lowerData) — must succeed.
    d.upsert(10, { key: "a", value: 100 });
    assertEquals(d.get("a")?.value, 100);

    // And again to exercise the replace-existing path.
    d.upsert(10, { key: "a", value: 200 });
    assertEquals(d.get("a")?.value, 200);
  },
);

Deno.test(
  "SortedDeque regression — set, deleteByKey of last entry, set at a different dse no longer crashes",
  () => {
    // Found by the tento/tento-lona-js/sheets multi-sheet fuzz target (commit
    // <pending>). Pre-fix `deleteByKey` left `_pivot` non-null
    // when the deque became empty; the next `_insertNew` then
    // skipped the `pivot === null` early return and crashed
    // reading `upperData[0]` (or `lowerData[0]`).
    const d = makeDeque();
    d.upsert(10, { key: "a", value: 1 });
    assertEquals(d.deleteByKey("a"), true);
    assertEquals(d.size, 0);
    // Pre-fix: TypeError "Cannot read properties of undefined (reading '0')"
    d.upsert(20, { key: "b", value: 2 });
    assertEquals(d.size, 1);
    assertEquals(d.get("b")?.value, 2);
  },
);

Deno.test(
  "SortedDeque regression — same as above but with multiple entries cleared in sequence",
  () => {
    // Variant: build up + tear down the deque, then re-populate.
    // Confirms the pivot reset triggers regardless of which
    // entry was the last one removed.
    const d = makeDeque();
    d.upsert(10, { key: "a", value: 1 });
    d.upsert(20, { key: "b", value: 2 });
    d.upsert(30, { key: "c", value: 3 });
    d.deleteByKey("a");
    d.deleteByKey("c");
    d.deleteByKey("b");
    assertEquals(d.size, 0);
    d.upsert(99, { key: "z", value: 99 });
    assertEquals(d.get("z")?.value, 99);
  },
);
