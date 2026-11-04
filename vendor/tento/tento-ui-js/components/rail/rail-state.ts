// The rail's remembered width and collapse, as pure functions.
//
// Two rails — the commit-review rail and ux-rail — kept the same four rules
// under different localStorage prefixes: a width key and a collapsed key; a
// stored width that is DISCARDED when it falls outside the drag's bounds; a
// drag that clamps to those bounds and rounds to the pixel; and a resolved
// width that is the collapsed lane, the remembered width, or the default, in
// that order. None of it touches the DOM, so all of it is testable from
// fixtures, and `std-rail` and the review rail both call in here rather than
// carrying a copy.

export namespace RailState {
  export type Bounds = { minPx: number; maxPx: number };

  /** Who owns the width. `frame`: a frame above the rail reserves the column
   * and runs the collapse; the rail fills what it is given. `owned`: the rail
   * stands in a flex row and keeps the width, the bounds, the storage keys
   * and the collapse itself. Declared here, DOM-free, so the fixtures can
   * name it; `Rail.Width` is this type. */
  export type Width =
    | { kind: "frame" }
    | {
        kind: "owned";
        defaultPx: number;
        minPx: number;
        maxPx: number;
        /** `RailState.keys(prefix)` — `<prefix>-width`, `<prefix>-collapsed`. */
        storagePrefix: string;
        /** 0 unless a glyph column survives the clip (the review rail's 52). */
        collapsedWidthPx: number;
      };

  export type Keys = { width: string; collapsed: string };

  /** What the rail knows about itself between binds. `widthPx` is the
   * operator's dragged or restored width, `null` when they never chose one. */
  export type State = { collapsed: boolean; widthPx: Option<number> };

  /** The two storage keys under one prefix. The review rail's existing keys
   * (`tento-stack-rail-width`, `-collapsed`) and ux-rail's (`ux-tests-rail-…`)
   * are both this function of their prefix, so nobody loses a remembered
   * width when their rail moves onto the shared state. */
  export function keys(prefix: string): Keys {
    return { width: `${prefix}-width`, collapsed: `${prefix}-collapsed` };
  }

  /** A stored width, or `null` when there is nothing worth restoring.
   *
   * Out-of-bounds values are discarded, never clamped: a stale or hand-edited
   * number is not a width the operator ever chose, and a bound that moved
   * should not pin every returning user to its new edge. Fractions round to
   * the pixel, as the drag does. */
  export function restoreWidth(
    raw: Option<string>,
    bounds: Bounds,
  ): Option<number> {
    if (raw == null || raw.trim() === "") return null;
    const stored = Number(raw);
    if (!Number.isFinite(stored)) return null;
    if (stored < bounds.minPx || stored > bounds.maxPx) return null;
    return Math.round(stored);
  }

  /** The width a drag has reached: the start width plus the pointer's travel,
   * clamped to the bounds and rounded to the pixel. */
  export function dragWidth(
    startPx: number,
    deltaPx: number,
    bounds: Bounds,
  ): number {
    return Math.round(
      Math.min(bounds.maxPx, Math.max(bounds.minPx, startPx + deltaPx)),
    );
  }

  /** The width the rail should lay out at, or `null` for a frame-hosted rail
   * — one whose width belongs to the frame, so the rail has no number of its
   * own to resolve. */
  export function resolvedWidthPx(
    state: State,
    width: Width,
  ): Option<number> {
    if (width.kind === "frame") return null;
    if (state.collapsed) return width.collapsedWidthPx;
    return state.widthPx ?? width.defaultPx;
  }
}
