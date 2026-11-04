import { css, Style } from "../../component-styles";
import { PIXELS_PER_HOUR } from "./calendar-hour";

/**
 * The calendar cell's rules: it has no shadow root (the shadow
 * cell and its `calendar-light-dom-cells` lever were removed with the
 * operator's flip of 2026-10-12).
 *
 * A shadow root is a scope the style engine visits on every style update, so
 * a page's per-update style cost follows its scope count. The
 * cell keeps its tag (`std-calendar-column-cell`) and its children (the chip
 * is its first element child) but has no scope of its own: its rules live in
 * one shared sheet that each cell installs, once per root, into the root it
 * connects into (`adoptLightCellStyles`).
 *
 * - **The rules:** `LIGHT_CELL_CSS` states the cell's rules for the host, the
 *   surface (the host's `::before`), the chip (its first element child, which
 *   takes the surface's clip: `overflow`, `border-radius`) and the resize
 *   handles.
 * - **Weight:** every selector sits in `:where()`, so any rule of the root
 *   that names the cell still wins, as a document rule wins over `:host`; the
 *   sheet goes first in the root's list for the same reason.
 * - **No leakage:** every selector names the cell's tag (the cell has one
 *   mode, so no mark qualifies it), and the parts are its children.
 */

const CELL = "std-calendar-column-cell";

/** A selector at zero weight for the cell with `rest` appended (a state, or a combinator and a part). */
function cell(rest = ""): string {
  return `:where(${CELL}${rest})`;
}

/** The cell's rules (the one sheet every root shares). */
export const LIGHT_CELL_CSS = `
  ${cell()} {
    --std-calendar-cell-x-offset: 0px;
    --std-calendar-cell-additional-height: 0px;
    --std-calendar-cell-background: var(--bg-surface-light);

    position: absolute;
    top: calc(var(--additional-top-fold-px, 0px));
    left: var(--std-calendar-cell-x-offset);
    height: calc(
      ${PIXELS_PER_HOUR}px * var(--p-duration-mins) / 60 +
        var(--std-calendar-cell-additional-height)
    );
    width: calc(
      100% - var(--std-calendar-cell-x-offset) -
        var(--std-calendar-cell-end-inset, 0px)
    );
    transform: translateY(
      calc(
        ${PIXELS_PER_HOUR}px *
        (var(--p-start-time-hrs) + var(--std-calendar-cell-y-offset, 0))
      )
    );

    background: transparent;
    border-radius: 12px;
    overflow: visible;
    color: black;
    user-select: none;
    transition: box-shadow 0.15s ease;
  }

  ${cell("[active]")},
  ${cell("[drag-ghost]")} {
    box-shadow: rgba(0, 0, 0, 0.6) 0px 1px 3px 0.5px;
    z-index: 3;
  }

  /* The surface: the cell's background, under the chip. */
  ${cell()}::before {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--std-calendar-cell-background);
    border-radius: inherit;
    transition: background-color 0.15s ease;
    pointer-events: none;
  }

  /* The chip: it fills the cell and takes the surface's clip. Span content is
     inert by contract: every pointer affordance lives on the cell host. */
  ${cell(' > [slot="content"]')} {
    display: block;
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    overflow: hidden;
    pointer-events: none;
  }

  ${cell("[pending-layout]")} {
    visibility: hidden;
  }

  ${cell("[drag-source]")} {
    opacity: 0.4;
    outline: 1px dashed var(--text-ter);
    outline-offset: -2px;
  }

  ${cell("[loading]")}::before {
    background: var(--bg-hover-opaque);
  }

  ${cell(" > .resize-handle")} {
    position: absolute;
    left: 0px;
    width: 100%;
    height: 4px;
    cursor: ns-resize;
    z-index: 1;
    pointer-events: auto;
  }

  ${cell(" > .resize-handle[top]")} {
    top: 0px;
  }

  ${cell(" > .resize-handle[bottom]")} {
    bottom: 0px;
  }
`;

/** Where a connected light element's rules go: its root's sheet list, and where a `<style>` copy would go. */
type Scope = {
  readonly sheets: DocumentOrShadowRoot;
  readonly prepend: (node: Node) => void;
  /** Whether the root belongs to another document (a picture-in-picture window). */
  readonly foreign: boolean;
};

/** `root` as a scope: a shadow root or a document (each guarded, so a DOM without one of them still loads). */
function scopeOf(root: Node): Option<Scope> {
  const here = typeof document === "undefined" ? null : document;
  if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
    const owner = root.ownerDocument;
    return { sheets: root, prepend: (node) => root.prepend(node), foreign: owner != null && owner !== here };
  }
  if (typeof Document !== "undefined" && root instanceof Document) {
    return { sheets: root, prepend: (node) => root.head?.prepend(node), foreign: root !== here };
  }
  return null;
}

/**
 * One light class's rules, shared: one sheet built on first use (a page
 * without the class builds none), put into each root the class connects
 * into, once and first in its list. A root of another document (a
 * picture-in-picture window) cannot adopt this document's sheet and takes
 * one `<style>` copy of the rules instead.
 */
export class LightSheet {
  private shared: Option<Style.Compat> = null;
  /** The roots that hold a `<style>` copy. */
  private readonly copied = new WeakSet<Node>();

  constructor(readonly cssText: string) {}

  /** The one sheet every root shares. */
  sheet(): Style.Compat {
    this.shared ??= css(this.cssText);
    return this.shared;
  }

  /** Put the rules into the connected element's `root`, unless they are there already. */
  adoptInto(root: Node): void {
    const scope = scopeOf(root);
    if (scope == null) return;
    const sheet = this.sheet();
    if (!scope.foreign && sheet instanceof CSSStyleSheet) {
      const adopted = scope.sheets.adoptedStyleSheets;
      if (adopted.includes(sheet)) return;
      try {
        scope.sheets.adoptedStyleSheets = [sheet, ...adopted];
        return;
      } catch (_error) {
        // A root this document's sheet cannot join: fall through to a copy.
      }
    }
    if (this.copied.has(root)) return;
    this.copied.add(root);
    scope.prepend(Style.make(this.cssText));
  }
}

const LIGHT_CELL_SHEET = new LightSheet(LIGHT_CELL_CSS);

/** The one light-cell sheet every root shares (built on first use, so a page without light cells builds none). */
export function lightCellStyles(): Style.Compat {
  return LIGHT_CELL_SHEET.sheet();
}

/**
 * Put the shared light-cell sheet into the light cell's `root`, first in its
 * list, unless it is there already (`LightSheet.adoptInto`).
 */
export function adoptLightCellStyles(root: Node): void {
  LIGHT_CELL_SHEET.adoptInto(root);
}
