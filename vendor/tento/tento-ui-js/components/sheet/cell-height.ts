/**
 * # Three notions of a cell's height, named so they cannot be compared by accident
 *
 * A sheet cell's height exists three times over, and until this file they were
 * all a bare `number`:
 *
 * ```text
 *   PLANNED   plan.layout.cellHeightPx   what the layout DECIDED this pass
 *   CACHED    $cell.height               what the last bind WROTE (a JS field)
 *   MEASURED  getBoundingClientRect()    what the DOM SAYS right now
 * ```
 *
 * They are not three readings of one value; they are three claims that can all
 * agree while the pixels are zero — sdk-0's finding C2, seam 10 of
 * `sdk(5)-encapsulation`. The 2026-08-06 operator break was exactly that shape:
 * `scrubPreviousSheetVisualState` zeroed every rendered cell's CACHED height on
 * the way into a navigation, a bind pass restored the cache and the plan agreed
 * with it, and the column was still a dead band on screen. Cached is a memo of a
 * write, not an observation; only MEASURED can contradict it.
 *
 * So each consumer names the notion it is entitled to, and the brands make the
 * wrong pairing a type error rather than a plausible-looking line of code:
 *
 * ```text
 *   SKIP eligibility (default-binder `cellEligibility.domHonorable`)
 *       planned vs cached — it runs per cell per bind pass and MUST NOT force
 *       layout; "did the last write agree with this pass's plan" is the whole
 *       question it can afford to ask.
 *   REVEAL contract (sheet.ts, navigation `idle` → reveal)
 *       measured — the sheet is about to be SEEN. A cached 0 that the DOM
 *       disagrees with is precisely C2, and layout is already being read here.
 *   Header SWEEP (scroll-horizontal `sweepHeaderInvariants`)
 *       measured — the DOM-truth tripwire, at quiesce, inside a `$$.measure`.
 * ```
 *
 * `PlannedHeightPx === CachedHeightPx` still compiles (a plan legitimately
 * checks itself against the cache, through {@link CellHeight.honorsPlan}), but
 * `CachedHeightPx === MeasuredHeightPx` does not: the brands have no overlap, so
 * TypeScript rejects the comparison that produced the break.
 *
 * The constructors are the identity: they name WHICH notion a number is, they
 * do not police values, because minting one happens on the reveal path where
 * the standing rule is "loud, but NEVER block the reveal". Invalidity is
 * therefore judged downstream, where the number is USED — a reading that is not
 * a finite, non-negative number is not a height and cannot be evidence of paint.
 * {@link MeasuredHeightPx.isValid} names that condition,
 * {@link CellHeight.isDeadOnScreen} counts such a cell DEAD, and
 * {@link CellHeight.deadColumns} reports how many it saw. Before that, a `NaN`
 * measurement compared `false` against the threshold and passed for a LIVE
 * cell, silently — the one way this seam could still answer "the pixels are
 * there" without having seen any.
 *
 * DOM-free by construction — the two measuring call sites read
 * `getBoundingClientRect()` themselves and mint the brand from the number, so
 * this module stays headless and every predicate in it is unit-testable
 * (`cell-height.deno.test.ts`).
 */

/** What the layout DECIDED for this cell this pass (`plan.layout.cellHeightPx`). */
export type PlannedHeightPx = number & { readonly __brand: "PlannedHeightPx" };

/**
 * What the last bind WROTE (`SheetCell.height`, a JS field mirrored to
 * `--height`). Zeroed OUT OF BAND by the scrub and by `SheetColumn.onRecycle`,
 * on the contract that the next bind restores it — which is why it is a claim
 * and not an observation.
 */
export type CachedHeightPx = number & { readonly __brand: "CachedHeightPx" };

/** What the DOM SAYS now — `getBoundingClientRect().height`, i.e. the pixels. */
export type MeasuredHeightPx = number & { readonly __brand: "MeasuredHeightPx" };

/**
 * Widen a branded height back to the number it is. The ONE place a brand is
 * dropped, so a numeric comparison between two notions has to be written here,
 * deliberately, rather than anywhere a `number` is accepted.
 */
function px(height: PlannedHeightPx | CachedHeightPx | MeasuredHeightPx): number {
  return height;
}

export namespace PlannedHeightPx {
  /**
   * The only constructor. Deliberately the identity: the brand names WHICH
   * notion a number is, not which values are legal. Every notion admits `0` (a
   * scrubbed or recycled cell) and a fractional measurement, and the two
   * consumers that mint these run on the reveal path — where the standing
   * invariant is "loud, but NEVER block the reveal". A throwing constructor
   * would turn a reportable bad height into a broken navigation.
   *
   * So this stays total, and the judgement moves to the use site:
   * {@link MeasuredHeightPx.isValid} decides whether a measurement is a height
   * at all, {@link CellHeight.isDeadOnScreen} treats one that is not as DEAD,
   * and {@link CellHeight.deadColumns} carries the count out as `invalid`. The
   * badness travels as a counter, never as a throw.
   */
  export function of(height: number): PlannedHeightPx {
    return height as PlannedHeightPx;
  }

  /** `of` for a plan that may not exist this pass (no plan ⇒ no planned height). */
  export function ofOption(height: Option<number>): Option<PlannedHeightPx> {
    return height == null ? null : of(height);
  }
}

export namespace CachedHeightPx {
  /** See {@link PlannedHeightPx.of} — identity, for the same reason. */
  export function of(height: number): CachedHeightPx {
    return height as CachedHeightPx;
  }

  /** `of` for a cell that has never been bound (`SheetCell.height == null`). */
  export function ofOption(height: Option<number>): Option<CachedHeightPx> {
    return height == null ? null : of(height);
  }
}

export namespace MeasuredHeightPx {
  /** See {@link PlannedHeightPx.of} — identity, for the same reason. */
  export function of(height: number): MeasuredHeightPx {
    return height as MeasuredHeightPx;
  }

  /**
   * Is this reading a height at all? `getBoundingClientRect()` on a detached or
   * mid-teardown element — and any arithmetic over one — can hand back `NaN` or
   * `±Infinity`, and the box model never produces a negative height. None of
   * those may be compared against {@link CellHeight.DEAD_BELOW_PX}: `NaN < 1`
   * is `false`, so the comparison alone would score the cell ALIVE.
   */
  export function isValid(height: MeasuredHeightPx): boolean {
    return Number.isFinite(px(height)) && px(height) >= 0;
  }
}

/**
 * All three notions for one cell. No consumer holds a full triple — that is the
 * defect stated as a type — so this is the vocabulary the seam is written in and
 * the shape a test builds to show two consumers disagreeing about one cell.
 * `measured` is the `Option` because it is the only one that costs a layout read.
 */
export interface CellHeight {
  readonly planned: PlannedHeightPx;
  readonly cached: CachedHeightPx;
  readonly measured: Option<MeasuredHeightPx>;
}

export namespace CellHeight {
  /** Build a triple from plain numbers (tests, and any site that knows all three). */
  export function of(
    planned: number,
    cached: number,
    measured: Option<number>,
  ): CellHeight {
    return {
      planned: PlannedHeightPx.of(planned),
      cached: CachedHeightPx.of(cached),
      measured: measured == null ? null : MeasuredHeightPx.of(measured),
    };
  }

  /**
   * SKIP eligibility's height axis: does the occupant already display THIS
   * pass's planned height? Planned vs CACHED, never measured — this runs per
   * cell per bind pass and must not force layout.
   *
   * A missing plan or an unbound cell is `false` (rebind — the conservative
   * default), and a `NaN` on either side is `false` for the same reason, both
   * verbatim what the bare `===` did before the brands.
   */
  export function honorsPlan(
    planned: Option<PlannedHeightPx>,
    cached: Option<CachedHeightPx>,
  ): boolean {
    if (planned == null || cached == null) return false;
    return px(planned) === px(cached);
  }

  /**
   * Below this many pixels a cell is dead on screen. Sub-pixel heights are a
   * dead band, not a short cell; `>= 1` is what the header sweep has always
   * meant by "alive", and the reveal contract now agrees with it.
   */
  export const DEAD_BELOW_PX = 1;

  /**
   * Is this cell painting nothing RIGHT NOW? Measured only — the pixels decide.
   *
   * A reading that is not a height ({@link MeasuredHeightPx.isValid}) is DEAD,
   * not alive. It is not evidence of paint, and it cannot be argued with by a
   * threshold: `NaN < DEAD_BELOW_PX` is `false`, so the bare comparison voted
   * for "alive" on the one input it had no business judging.
   */
  export function isDeadOnScreen(measured: MeasuredHeightPx): boolean {
    if (!MeasuredHeightPx.isValid(measured)) return true;
    return px(measured) < DEAD_BELOW_PX;
  }

  /**
   * One cell as the reveal contract sees it. Hidden cells legitimately measure
   * 0 (the reflow path hides null-layout cells), so they are carried and
   * excluded here rather than filtered by the caller — the exclusion rule is
   * part of the predicate, and therefore part of what is tested.
   */
  export interface RevealSample {
    readonly hidden: boolean;
    readonly measured: MeasuredHeightPx;
  }

  /** One column's cells, tagged with the engine index the breadcrumb reports. */
  export interface RevealColumn {
    readonly index: Option<number>;
    readonly cells: readonly RevealSample[];
  }

  /**
   * The counters the `sheet/reveal-contract` breadcrumb carries. The first
   * three are what it has always carried; `invalid` is additive.
   *
   * `invalid` counts non-hidden cells whose measurement was not a height
   * ({@link MeasuredHeightPx.isValid}), across ALL columns rather than the dead
   * ones — one such sample in an otherwise-alive column is not a contract
   * breach, but it is a reading the reveal could not trust, and a check that
   * measures is worth nothing if it cannot say the measurement failed.
   */
  export interface DeadColumnReport {
    readonly deadColumns: number;
    readonly deadCells: number;
    readonly deadIndices: readonly Option<number>[];
    readonly invalid: number;
  }

  /**
   * The reveal contract, as a pure function: a column every one of whose
   * non-hidden cells measures dead is about to be revealed as a bound-looking
   * dead band. A column with no countable cells is not a violation.
   *
   * `deadCells` counts the cells of the dead columns only (a partially dead
   * column is not a contract breach — the sheet is legitimately mid-pipeline),
   * and `deadIndices` keeps one entry per dead column in encounter order, so
   * the breadcrumb can say WHICH column and the caller can compare that against
   * the visible strip. `invalid` is orthogonal to all three: it counts unusable
   * measurements wherever they were seen, dead column or not.
   */
  export function deadColumns(
    columns: readonly RevealColumn[],
  ): DeadColumnReport {
    let deadColumnCount = 0;
    let deadCells = 0;
    let invalid = 0;
    const deadIndices: Option<number>[] = [];
    for (const column of columns) {
      let countable = 0;
      let zeroed = 0;
      for (const cell of column.cells) {
        if (cell.hidden) continue;
        countable++;
        if (!MeasuredHeightPx.isValid(cell.measured)) invalid++;
        if (isDeadOnScreen(cell.measured)) zeroed++;
      }
      if (countable > 0 && zeroed === countable) {
        deadColumnCount++;
        deadCells += zeroed;
        deadIndices.push(column.index);
      }
    }
    return { deadColumns: deadColumnCount, deadCells, deadIndices, invalid };
  }

  /** The engine's visible strip, inclusive on both ends (what `visibleIndices()` returns). */
  export interface VisibleStrip {
    readonly start: number;
    readonly end: number;
  }

  /**
   * Split a dead-column list by where the columns are. A dead column INSIDE the
   * visible strip is the contract breach — the user is about to be shown a
   * bound-looking dead band — and is loud. A dead column in the rendered flank
   * outside the strip is cosmetic: the reveal is gated on the strip, the flanks
   * catch up under the sweep, and a config flip legitimately leaves flank
   * columns un-laid-out at the instant the strip is ready. A column with no
   * engine index cannot be placed, so it is judged as inside — the
   * conservative side, because "unknown" is not evidence of paint.
   */
  export interface DeadPartition {
    readonly inside: readonly Option<number>[];
    readonly flank: readonly number[];
  }

  /**
   * The reveal's second question about the strip: is the strip this reveal is
   * about to judge the strip it was PROMISED?
   *
   * `whenSettled` judges a GENERATION, never a viewport — `SettleDebt.owed` is
   * arithmetic on `lastBoundGeneration` — while the reveal's dead-column audit
   * reads the LIVE strip off the current `scrollLeft`. Between the judgement
   * and the measurement a wheel still in flight moves the strip, and the
   * columns that scrolled in were queued at the live generation: nobody
   * promised them paint by the pass this reveal waited for, yet their scrubbed
   * 0px lands INSIDE the strip the audit reads, where {@link partitionDead}
   * escalates it as the contract breach it is not.
   *
   * So the reveal snapshots the strip when it arms the wait and asks here what
   * to do with the one it finds. `sample` means nothing moved and the audit is
   * about the strip that was judged. `rearm` carries both strips, for one more
   * bounded wait and for the breadcrumb that lets a red run be attributed
   * months later without a browser (`lona-ux-storm`'s `attributeBreach`).
   *
   * Pure, and deliberately not a tolerance: "the strip moved by one column" and
   * "the strip moved to a different century" are the same fact — the judgement
   * was made about a viewport the user is no longer looking at — and a fuzzy
   * threshold here would be a second, quieter place where a promise is decided.
   */
  export type RestripDecision =
    | { readonly kind: "sample" }
    | {
      readonly kind: "rearm";
      readonly from: VisibleStrip;
      readonly to: VisibleStrip;
    };

  export function decideRestrip(
    armed: VisibleStrip,
    live: VisibleStrip,
  ): RestripDecision {
    if (armed.start === live.start && armed.end === live.end) {
      return { kind: "sample" };
    }
    return { kind: "rearm", from: armed, to: live };
  }

  export function partitionDead(
    deadIndices: readonly Option<number>[],
    strip: VisibleStrip,
  ): DeadPartition {
    const inside: Option<number>[] = [];
    const flank: number[] = [];
    for (const index of deadIndices) {
      if (index == null || (index >= strip.start && index <= strip.end)) inside.push(index);
      else flank.push(index);
    }
    return { inside, flank };
  }
}
