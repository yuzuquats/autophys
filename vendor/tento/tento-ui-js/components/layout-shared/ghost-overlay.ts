/**
 * Atomic ghost-promotion overlay — the DOM-less core of drag/resize.
 *
 * Holds the in-flight gesture state for ONE span and produces the
 * "effective" span list (the dragged span moved to its current position)
 * as a pure data transform — no DOM. The layout's render path feeds
 * `apply(baseSpans)` into its span-layout + DOM reconciler (`SpanReconciler`).
 *
 * Deliberately imports nothing (no DOM, no chrono): generic over the span
 * `S`, its range type `R`, and the layout capture `C`. The layout supplies
 * the few range/capture operations. That keeps this module reusable by the
 * widget, the `lona-cli`, and deno tests with no DOM dependency.
 */

/**
 * The minimal shape the overlay needs from a span: a stable identity, a
 * range it can shift/replace, and a decorative dragging flag. Excludes the
 * DOM `render` callback that the concrete grid span carries.
 */
export interface Promotable<R> {
  key: string;
  range: R;
  isDragging?: boolean;
}

/**
 * Layout-specific PURE operations. Grid fills these with date math + a lane
 * lookup; column/row layouts supply their own (minutes, DSE, etc.).
 */
export interface GhostOps<S extends Promotable<R>, R, C> {
  /** Shift a range by `amount` in the layout's native unit (grid: days). */
  shiftRange: (range: R, amount: number) => R;
  /**
   * Snapshot the layout capture for a span (e.g. grid's lane). Taken once
   * at gesture start so a re-layout mid-gesture keeps the span on its row.
   */
  capture: (key: string, base: readonly S[]) => C;
  /**
   * Build the promoted ("being dragged") span: the same span with the new
   * `range`, the captured layout value re-applied (grid: `preferredLane`),
   * and `isDragging` set. Concrete here so the spread is type-safe — the
   * overlay never spreads the generic `S` itself.
   */
  promote: (span: S, range: R, capture: C) => S;
}

interface ShiftSlot<R, C> {
  key: string;
  amount: number;
  originalRange: R;
  capture: C;
}

interface ReplaceSlot<R, C> {
  key: string;
  newRange: R;
  capture: C;
}

export class GhostOverlay<S extends Promotable<R>, R, C> {
  /** Move state — range is `originalRange + amount`. */
  private shift: Option<ShiftSlot<R, C>> = null;
  /** Resize state — range is the absolute `newRange`. */
  private replace: Option<ReplaceSlot<R, C>> = null;

  constructor(private readonly ops: GhostOps<S, R, C>) {}

  /**
   * Begin/continue a move. On the first call for a new `key`, snapshots
   * `originalRange` (from `base`) and the layout `capture`; subsequent
   * calls for the same key only update `amount` — so a canonical update
   * arriving mid-gesture (which changes `base`) never double-applies the
   * shift. An unknown key clears the slot.
   */
  setShift(key: string, amount: number, base: readonly S[]): void {
    const cur = this.shift;
    if (cur && cur.key === key) {
      this.shift = { ...cur, amount };
      return;
    }
    const span = base.find((s) => s.key === key);
    if (!span) {
      this.shift = null;
      return;
    }
    this.shift = {
      key,
      amount,
      originalRange: span.range,
      capture: this.ops.capture(key, base),
    };
  }

  /**
   * Begin/continue a resize with an absolute `newRange`. Only the layout
   * `capture` is snapshotted (the gesture provides the absolute range, so
   * there is no original to capture). An unknown key clears the slot.
   */
  setReplace(key: string, newRange: R, base: readonly S[]): void {
    const cur = this.replace;
    if (cur && cur.key === key) {
      this.replace = { ...cur, newRange };
      return;
    }
    const span = base.find((s) => s.key === key);
    if (!span) {
      this.replace = null;
      return;
    }
    this.replace = { key, newRange, capture: this.ops.capture(key, base) };
  }

  clearShift(): void {
    this.shift = null;
  }

  clearReplace(): void {
    this.replace = null;
  }

  clear(): void {
    this.shift = null;
    this.replace = null;
  }

  /** True when a move or resize gesture is in flight. */
  get active(): boolean {
    return this.shift != null || this.replace != null;
  }

  /**
   * Produce the effective span list: every span passes through unchanged
   * except the shifted/replaced one, whose range is recomputed and which is
   * promoted (new range + captured lane + `isDragging`). Pure — `base` is
   * never mutated.
   */
  apply(base: readonly S[]): S[] {
    let spans: S[] = [...base];
    const shift = this.shift;
    if (shift) {
      const range = this.ops.shiftRange(shift.originalRange, shift.amount);
      spans = spans.map((s) =>
        s.key === shift.key ? this.ops.promote(s, range, shift.capture) : s,
      );
    }
    const replace = this.replace;
    if (replace) {
      spans = spans.map((s) =>
        s.key === replace.key
          ? this.ops.promote(s, replace.newRange, replace.capture)
          : s,
      );
    }
    return spans;
  }
}
