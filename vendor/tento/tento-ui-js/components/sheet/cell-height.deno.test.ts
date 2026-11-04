/**
 * # Planned, cached and measured are three claims, not three readings
 *
 * ## Invariants Tested
 * - The three brands are mutually non-assignable at COMPILE time, and each is
 *   still a `number` — so `cached === measured` cannot be written at all, while
 *   `planned === cached` (through {@link CellHeight.honorsPlan}) still can
 * - The constructors are the identity, including on `0`, a fraction and `NaN`;
 *   `ofOption` maps absence to `null` and keeps `0`
 * - {@link CellHeight.honorsPlan} — the SKIP axis — is exactly the `===` it
 *   replaced: false for a missing plan, an unbound cell, and `NaN` on either side
 * - {@link CellHeight.deadColumns} — the REVEAL axis — reads `measured` only,
 *   excludes hidden cells, and refuses to call a partially dead column dead
 * - {@link CellHeight.decideRestrip} — the STRIP axis — is exact equality and
 *   not a tolerance: a strip that moved by one column and a strip that moved to
 *   a different century are the same fact (the settle judgement was made about
 *   a viewport the user is no longer looking at), so both re-arm
 * - A measurement that is not a height — `NaN`, `±Infinity`, negative — is
 *   DEAD, not alive: it is not evidence of paint, and `NaN < 1` is `false`, so
 *   the bare threshold used to score exactly that cell as painting. Such
 *   samples are also counted out separately as `invalid`, in every column, so
 *   one of them inside an otherwise-alive column is reported without that
 *   column being called dead
 * - **C2 itself**: planned 45 · cached 45 · measured 0 makes the reveal report a
 *   dead column while skip eligibility still calls the cell honorable, and the
 *   inverse (planned 45 · cached 0 · measured 45) flips both verdicts
 *
 * ## Where the table lives
 * The `honorsPlan` / `isDeadOnScreen` / `deadColumns` rows are DATA, in
 * `cell-height.cases.json`, driven by the house fixture runner. Each case is a
 * list of PROBES ({@link Probe}) and the answer each must give; `ask: "cell"`
 * builds one {@link CellHeight} triple and asks BOTH consumers about it, which
 * is the shape that splits them. Adding a row is a JSON edit.
 *
 * What stays inline, because it cannot be data: the compile-time brand
 * distinctness (a type-level assertion has no runtime input), and the two
 * constructor suites — `NaN` and `undefined` are not JSON values, and
 * distinguishing `ofOption(undefined)` from `ofOption(null)` is the point of
 * that test. The non-finite ROWS do ride the fixture, through the string
 * sentinels `"NaN"` / `"Infinity"` / `"-Infinity"` decoded at the boundary
 * ({@link measuredOf}) — JSON has no literal for any of them, and `null` is
 * already spoken for by absence.
 *
 * ## Notes
 * - No DOM: `cell-height.ts` is pure by construction, so this file needs no
 *   `deno-noop.ts` shim. The two measuring call sites (`sheet.ts`'s reveal and
 *   `scroll-horizontal.ts`'s sweep) read `getBoundingClientRect()` themselves
 *   and mint {@link MeasuredHeightPx} from the number.
 * - The C2 case is the whole point of the seam: before the brands, all three
 *   notions were `number`, and the reveal check asked the CACHE whether the
 *   pixels were there — a question the cache cannot answer wrong.
 */
import { assert, assertEquals } from "jsr:@std/assert";

import { Fixtures } from "../../../tento-core-js/tests/fixture-runner.deno.ts";
import {
  CachedHeightPx,
  CellHeight,
  MeasuredHeightPx,
  PlannedHeightPx,
} from "./cell-height.ts";

/** `true` only when `A` is NOT assignable to `B`. Compile-time brand distinctness. */
type NotAssignable<A, B> = [A] extends [B] ? false : true;
/** `true` when `A` IS assignable to `B`. */
type Assignable<A, B> = [A] extends [B] ? true : false;

Deno.test("cell-height: the three brands do not interconvert, but are all numbers", () => {
  // Compile-time. If any of these flips, the line stops type-checking — which
  // is the entire mechanism: `cached === measured` becomes "no overlap".
  const plannedIsNotCached: NotAssignable<PlannedHeightPx, CachedHeightPx> =
    true;
  const cachedIsNotMeasured: NotAssignable<CachedHeightPx, MeasuredHeightPx> =
    true;
  const measuredIsNotPlanned: NotAssignable<MeasuredHeightPx, PlannedHeightPx> =
    true;
  const plainIsNotPlanned: NotAssignable<number, PlannedHeightPx> = true;

  // …and each brand is still a number, so arithmetic and `<` keep working.
  const plannedIsNumber: Assignable<PlannedHeightPx, number> = true;
  const cachedIsNumber: Assignable<CachedHeightPx, number> = true;
  const measuredIsNumber: Assignable<MeasuredHeightPx, number> = true;

  assertEquals(
    [
      plannedIsNotCached,
      cachedIsNotMeasured,
      measuredIsNotPlanned,
      plainIsNotPlanned,
      plannedIsNumber,
      cachedIsNumber,
      measuredIsNumber,
    ],
    [true, true, true, true, true, true, true],
  );
});

Deno.test("cell-height: the constructors are the identity", () => {
  // The brand names WHICH notion a number is, not which values are legal: every
  // notion admits 0 (a scrubbed or recycled cell) and a fractional measurement,
  // and the reveal path must never throw. So no validation, and nothing is
  // coerced on the way in.
  assertEquals(PlannedHeightPx.of(45), 45);
  assertEquals(CachedHeightPx.of(0), 0);
  assertEquals(MeasuredHeightPx.of(44.5), 44.5);
  assertEquals(PlannedHeightPx.of(-1), -1);
  assert(Number.isNaN(CachedHeightPx.of(Number.NaN)));
});

Deno.test("cell-height: ofOption maps absence to null and keeps zero", () => {
  assertEquals(PlannedHeightPx.ofOption(null), null);
  assertEquals(PlannedHeightPx.ofOption(undefined), null);
  assertEquals(CachedHeightPx.ofOption(null), null);
  // 0 is a real height (a scrubbed cell), not an absent one.
  assertEquals(CachedHeightPx.ofOption(0), 0);
  assertEquals(PlannedHeightPx.ofOption(45), 45);
});

// ── the three predicates, as data ───────────────────────────────────

/**
 * A height as JSON can carry it: a number, or one of the string sentinels for
 * the values JSON has no literal for. The non-finite ones are not exotica here
 * — `getBoundingClientRect()` on a detached element hands back `NaN`, and that
 * is the reading the threshold could not judge — so the axis has to be able to
 * state them as data.
 */
type MeasuredSpec = number | "NaN" | "Infinity" | "-Infinity";

/** Decode a {@link MeasuredSpec}. The ONE place a sentinel becomes a number. */
function measuredOf(spec: MeasuredSpec): number {
  switch (spec) {
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Number.POSITIVE_INFINITY;
    case "-Infinity":
      return Number.NEGATIVE_INFINITY;
    default:
      return spec;
  }
}

/**
 * A PLANNED or CACHED height as JSON can carry it — a {@link MeasuredSpec}, or
 * absent: no plan this pass, or a cell that has never been bound. `null` means
 * absence and nothing else.
 */
type HeightSpec = Option<MeasuredSpec>;

function heightOf(spec: HeightSpec): Option<number> {
  return spec == null ? null : measuredOf(spec);
}

/** One column as the reveal contract sees it, in JSON height specs. */
interface ColumnSpec {
  readonly index: Option<number>;
  readonly cells: readonly {
    readonly hidden: boolean;
    readonly measured: MeasuredSpec;
  }[];
}

/** One question asked of `cell-height.ts`. */
type Probe =
  /** The SKIP axis: does the cache already display this pass's plan? */
  | { readonly ask: "honorsPlan"; readonly planned: HeightSpec; readonly cached: HeightSpec }
  /** The sub-pixel threshold, measured only. */
  | { readonly ask: "isDeadOnScreen"; readonly measured: MeasuredSpec }
  /** The REVEAL axis: one `deadColumns` call over these columns. */
  | { readonly ask: "deadColumns"; readonly columns: readonly ColumnSpec[] }
  /** Where the dead columns are, against the engine's visible strip. */
  | {
    readonly ask: "partitionDead";
    readonly deadIndices: readonly Option<number>[];
    readonly strip: CellHeight.VisibleStrip;
  }
  /**
   * The reveal's strip re-read: is the strip about to be audited the strip the
   * settle wait was armed on?
   */
  | {
    readonly ask: "decideRestrip";
    readonly armed: CellHeight.VisibleStrip;
    readonly live: CellHeight.VisibleStrip;
  }
  /**
   * All three notions of ONE cell, asked of BOTH consumers — the shape that
   * shows them disagreeing (C2). The reveal sees a single-cell column at
   * `index`, built from the triple's own `measured`.
   */
  | {
    readonly ask: "cell";
    readonly planned: number;
    readonly cached: number;
    readonly measured: number;
    readonly index: Option<number>;
  };

/** The answer a probe must produce, parallel to `Input.probes`. */
type Answer =
  | { readonly honorsPlan: boolean }
  | { readonly dead: boolean }
  | { readonly report: CellHeight.DeadColumnReport }
  | { readonly partition: CellHeight.DeadPartition }
  | { readonly restrip: CellHeight.RestripDecision }
  | { readonly honorsPlan: boolean; readonly report: CellHeight.DeadColumnReport };

interface Input {
  readonly probes: readonly Probe[];
}

interface Expected {
  readonly answers: readonly Answer[];
}

function revealColumns(
  columns: readonly ColumnSpec[],
): CellHeight.RevealColumn[] {
  return columns.map((column) => ({
    index: column.index,
    cells: column.cells.map((cell) => ({
      hidden: cell.hidden,
      measured: MeasuredHeightPx.of(measuredOf(cell.measured)),
    })),
  }));
}

function answer(probe: Probe): Answer {
  switch (probe.ask) {
    case "honorsPlan":
      return {
        honorsPlan: CellHeight.honorsPlan(
          PlannedHeightPx.ofOption(heightOf(probe.planned)),
          CachedHeightPx.ofOption(heightOf(probe.cached)),
        ),
      };
    case "isDeadOnScreen":
      return {
        dead: CellHeight.isDeadOnScreen(
          MeasuredHeightPx.of(measuredOf(probe.measured)),
        ),
      };
    case "deadColumns":
      return { report: CellHeight.deadColumns(revealColumns(probe.columns)) };
    case "partitionDead":
      return { partition: CellHeight.partitionDead(probe.deadIndices, probe.strip) };
    case "decideRestrip":
      return { restrip: CellHeight.decideRestrip(probe.armed, probe.live) };
    case "cell": {
      const cell = CellHeight.of(probe.planned, probe.cached, probe.measured);
      // SKIP is entitled to planned vs cached; the REVEAL is entitled to the
      // pixels. One cell, two questions — before the brands both consumers
      // read the cache and therefore could not disagree, which is C2 exactly.
      const measured = cell.measured;
      if (measured == null) {
        throw new Error("a triple built from three numbers knows its pixels");
      }
      return {
        honorsPlan: CellHeight.honorsPlan(cell.planned, cell.cached),
        report: CellHeight.deadColumns([
          { index: probe.index, cells: [{ hidden: false, measured }] },
        ]),
      };
    }
    default: {
      const unhandled: never = probe;
      return unhandled;
    }
  }
}

Fixtures.load<Input, Expected>(
  new URL(".", import.meta.url).pathname,
  "cell-height",
).run(
  (input) => ({ answers: input.probes.map(answer) }),
  (result, expected, caseName) => assertEquals(result, expected, caseName),
);
