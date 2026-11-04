/**
 * The rendered strip of a scrolling column layout: the visible columns plus
 * the culled flanks the layout keeps bound on each side — the one rule the
 * DOM's scroll viewport (`tento-scroll-js/engine/scroll-viewport.ts`
 * `rendered`) and the headless CLI (`tento-lona-js/cli/dom-window.ts`) both
 * compute from, so an overscan change moves what the DOM binds and what the
 * CLI binds together.
 *
 * Pure: no DOM, no clock. `offsetRange` is the pixel form the viewport
 * reads; `indexRange` is the same rule over equal-width columns, in column
 * units. Both forms are pinned by `rendered-strip.cases.json`.
 *
 * @module
 */

/** How far the rendered strip reaches past the visible one, in visible lengths. */
export interface RenderedStripPolicy {
  /** Visible lengths of culled flank before the visible strip. */
  readonly flankBefore: number;
  /** Visible lengths of culled flank after the visible strip. */
  readonly flankAfter: number;
}

/** The rendered strip's arithmetic (module doc). */
export namespace RenderedStrip {
  /** The scroll viewport's policy: one visible length of flank on each side, `[s − w, s + 2w)`. */
  export const VIEWPORT: RenderedStripPolicy = Object.freeze({ flankBefore: 1, flankAfter: 1 });

  /** A strip in offsets (`end` exclusive). */
  export interface Offsets {
    readonly start: number;
    readonly end: number;
  }

  /**
   * The rendered offsets around a visible strip starting at `visibleStart`
   * and `visibleLength` long: `[start − before·length, start + (1 + after)·length)`.
   */
  export function offsetRange(visibleStart: number, visibleLength: number, policy: RenderedStripPolicy): Offsets {
    return {
      start: visibleStart - visibleLength * policy.flankBefore,
      end: visibleStart + visibleLength * (1 + policy.flankAfter),
    };
  }

  /** A strip of column indices, both ends inclusive. */
  export interface Indices {
    readonly first: number;
    readonly last: number;
  }

  /**
   * The rendered column indices over equal-width columns, with column
   * `anchor + step` the first visible one and `visibleCount` visible: the
   * pixel rule in column units. The last index is the column that STARTS at
   * the strip's exclusive end (the viewport resolves its end offset to the
   * column holding it), so the strip is `(1 + before + after)·N + 1`
   * columns: `[a − N + step, a + 2N + step]` under `VIEWPORT`.
   */
  export function indexRange(
    anchor: number,
    visibleCount: number,
    step: number,
    policy: RenderedStripPolicy,
  ): Indices {
    const offsets = offsetRange(anchor + step, visibleCount, policy);
    return { first: Math.ceil(offsets.start), last: Math.floor(offsets.end) };
  }
}
