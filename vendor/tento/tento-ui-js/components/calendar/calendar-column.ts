import "./calendar-column-layout";

import { DateFragment } from "@tento-chrono";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../../dom";
import { $$, mutate } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { CalendarColumnCell } from "./calendar-column-cell";
import { PIXELS_PER_HOUR } from "./calendar-hour";
import { CalendarColumnLayout } from "./calendar-column-layout";

/**
 * A layout group's identity in a calendar column: compared by identity as a
 * map key, and written as its string form (`layout-id`). A row id fits.
 */
export type CalendarLayoutId = { toString(): string };

/**
 * The corner radius of a column's partial edge (a day split by a zone change:
 * a flight, or a DST day). The sheet's skeleton layer rounds its span at the
 * same radius, on the edges `CalendarColumn.partialEdges` decides, so nothing
 * square shows past the round corners.
 */
export const PARTIAL_EDGE_RADIUS_PX = 12;

/** The column's partial edges, read off its positioning. */
function partialEdgesOf(
  positioning: NonNullable<ReturnType<DateFragment.Windowed["getPositioning"]>>,
): CalendarColumn.PartialEdges {
  return { top: positioning.partialTop, bottom: positioning.partialBottom };
}

/** `CalendarColumn.SHADOW_CSS`: the shadow sheet, as text so it can be read as data. */
const SHADOW_CSS = /* css */ `
      :host {
        position: relative;
        --std-calendar-column-layout-width: ${PIXELS_PER_HOUR}px;
        --std-calendar-column-layout-transition: none;
      }

      #root {
        height: 100%;
        width: calc(100% - 0px);
        background: var(--background);
        overflow: hidden;
      }

      :host([partial-top]) #root,
      :host([partial-top]) #cells {
        border-top-left-radius: ${PARTIAL_EDGE_RADIUS_PX}px;
        border-top-right-radius: ${PARTIAL_EDGE_RADIUS_PX}px;
      }

      :host([partial-bottom]) #root,
      :host([partial-bottom]) #cells {
        border-bottom-left-radius: ${PARTIAL_EDGE_RADIUS_PX}px;
        border-bottom-right-radius: ${PARTIAL_EDGE_RADIUS_PX}px;
      }

      #tzabbr-top,
      #tzabbr-bottom {
        position: absolute;
        content: "";
        left: 50%;
        transform: translateX(-50%);
        background: black;
        border-radius: 4px;
        opacity: 0;
        padding: 4px 8px;
        z-index: -1;
        cursor: pointer;
        height: min-content;
        /* Inert until toggleTzAbbrTooltipAction grants interactivity via
           inline style (inline wins over this base rule). Without this, two
           opacity-0 boxes per column sit in every hit test. */
        pointer-events: none;
      }

      /* The tooltip is the one surface past the edge: its own background,
         radius and drop shadow, cast away from the column (the side toward the
         column sits under #root). Nothing else paints around it. */
      :host([partial-top]) #tzabbr-top {
        opacity: 1;
        top: -14px;
        box-shadow: 0px -1px 2px rgba(0, 0, 0, 0.35);
        padding-bottom: 8px;
        border-bottom-left-radius: 0px;
        border-bottom-right-radius: 0px;
      }

      :host([partial-bottom]) #tzabbr-bottom {
        opacity: 1;
        bottom: -14px;
        box-shadow: 0px 1px 2px rgba(0, 0, 0, 0.35);
        padding-top: 8px;
        border-top-left-radius: 0px;
        border-top-right-radius: 0px;
      }

      #tzabbr-top-label,
      #tzabbr-bottom-label {
        --font-size: 0.375rem;
        color: white;
      }

      #background {
        position: absolute;
        inset: 0;
        left: -1px;
        right: 0px;
        /* Pure decoration (hour lines): prune it and its subtree from hit
           testing. Static on purpose — never toggle pointer-events via
           attribute-conditional rules. */
        pointer-events: none;
      }

      #cells {
        position: absolute;
        inset: 0;
        bottom: -8px;
        overflow: hidden;
        z-index: 3;
        margin-bottom: 8px;
      }

      #lines-container {
        display: inline-block;
        position: absolute;
        left: 0px;
        right: 0px;
        top: 0px;
        bottom: 0px;
        height: 100%;
      }

      :host([partial-top]) #lines-container {
        top: ${PIXELS_PER_HOUR}px;
      }

      :host([partial-bottom]) #lines-container {
        bottom: ${PIXELS_PER_HOUR}px;
      }
`;

/** `CalendarColumn.SHADOW_HTML`: the shadow template, as text so it can be read as data. */
const SHADOW_HTML = /* html */ `
    <div id="root">
      <div id="background">
        <div id=lines-container>
          <div class=calendar-lines></div>
        </div>
      </div>
      <div id=cells>
        <slot></slot>
        <std-row style=container-type:inline-size;height:100%;>
          <slot name=subcolumns></slot>
        </std-row>
      </div>
    </div>
    <div id="tzabbr-top"><p id="tzabbr-top-label"></p></div>
    <div id="tzabbr-bottom"><p id="tzabbr-bottom-label"></p></div>
    <slot name=unclipped></slot>
`;

@component({
  name: "std-calendar-column",
})
export class CalendarColumn<
  NamedChildren extends Record<string, HTMLElement> = {},
> extends LonaWebComponent {
  #namedChildren: Optional<NamedChildren> = {};

  #layoutGroupById: Map<CalendarLayoutId, HTMLElement> = new Map();

  windowed: Option<DateFragment.Windowed>;

  renderedLayouts(): CalendarLayoutId[] {
    return [...this.#layoutGroupById.keys()];
  }

  @mutate
  sortLayouts($layouts: HTMLElement[]) {
    // $layouts are guaranteed to be children of the column
    // Only reorder if necessary to minimize DOM operations
    let $prev: Option<HTMLElement>;
    for (let i = 0; i < $layouts.length; i++) {
      const $layout = $layouts[i];
      // Check if this element is already in the correct position
      if ($prev) {
        // If the current element is not the next sibling of the previous element,
        // we need to move it
        if ($prev.nextElementSibling !== $layout) {
          // Insert after the previous element
          $prev.insertAdjacentElement("afterend", $layout);
        }
      } else {
        // This is the first element - check if it's already first among layouts
        const $first = this.firstElementChild;
        if ($first && $first.slot === "subcolumns" && $first !== $layout) {
          // Move to the beginning of elements with slot="subcolumns"
          this.insertBefore($layout, $first);
        } else if (!$first || $first.slot !== "subcolumns") {
          // No subcolumn elements yet, just append
          this.appendChild($layout);
        }
      }
      $prev = $layout;
    }
  }

  removeLayout(id: CalendarLayoutId) {
    const $custom = this.#layoutGroupById.get(id);
    if ($custom) {
      DomUtils.removeFromDom($custom);
      this.#layoutGroupById.delete(id);
    }
  }

  getLayoutUntyped<T extends HTMLElement>(id: CalendarLayoutId, factory: () => T): T {
    const $layout = this.#layoutGroupById.get(id) ?? factory();
    // Every write below is diffed: this runs per layout group per bind, and
    // re-appending an already-connected child is a detach+reattach — Blink
    // rebuilds the group's shadow-scope style resolver on every reinsert
    // (the trace's whole-subtree "Style rule change" recalcs). Order is the
    // caller's job: bindSync always follows with sortLayouts().
    const idStr = id.toString();
    if ($layout.getAttribute("layout-id") !== idStr) {
      $layout.setAttribute("layout-id", idStr);
    }
    if ($layout.slot !== "subcolumns") $layout.slot = "subcolumns";
    this.#layoutGroupById.set(id, $layout);
    if ($layout.parentElement !== this) this.appendChild($layout);
    return $layout as T;
  }

  appendNamedChild<Name extends keyof NamedChildren>(
    name: Name,
    value: NamedChildren[Name],
  ) {
    this.#namedChildren[name] = value;
    if (value.getAttribute("child-name") !== String(name)) {
      value.setAttribute("child-name", String(name));
    }
    $$.mutate(() => {
      if (value.parentElement !== this) this.appendChild(value);
    });
  }

  $namedChild<Name extends keyof NamedChildren>(
    name: Name,
  ): Option<NamedChildren[Name]> {
    return this.#namedChildren[name];
  }

  removeNamedChild<Name extends keyof NamedChildren>(
    name: Name,
  ): Option<NamedChildren[Name]> {
    const $child = this.#namedChildren[name];
    if (!$child) return;
    this.#namedChildren[name] = null;
    DomUtils.removeFromDom($child);
    return $child;
  }

  $namedChildOrElse<Name extends keyof NamedChildren>(
    name: Name,
    fn: () => NamedChildren[Name],
    slot: Option<"unclipped"> = null,
  ): NamedChildren[Name] {
    let $maybeChild = this.#namedChildren[name];
    if ($maybeChild) return $maybeChild;
    const $child = fn();
    if (slot) {
      $child.slot = "unclipped";
    }
    this.appendNamedChild(name, $child);
    return $child;
  }

  onRecycle(): void {
    this.#namedChildren = {};
    this.#layoutGroupById.clear();
  }

  private pointerEventsAllowed: Option<boolean>;
  toggleTzAbbrTooltipAction(force?: boolean) {
    if (
      this.pointerEventsAllowed !== null &&
      this.pointerEventsAllowed === force
    )
      return;
    const pe = force ? "all" : "none";
    this.$("tzabbr-top").style.setProperty("pointer-events", pe);
    this.$("tzabbr-bottom").style.setProperty("pointer-events", pe);
    this.pointerEventsAllowed = force;
  }

  bind(windowed: DateFragment.Windowed): boolean {
    this.windowed = windowed;
    const df = windowed.fragment;

    const positioning = windowed.getPositioning(PIXELS_PER_HOUR);
    if (!positioning) {
      this.park();
      return false;
    }

    this.$("tzabbr-top-label").textContent = df.tzabbr;
    this.$("tzabbr-bottom-label").textContent = df.tzabbr;
    this.assignStyles({
      "--std-calendar-cell-y-offset": String(-windowed.windowedStartHrs),
      "--lines-offset": -positioning.linesOffsetPx + "px",
      "--lines-height": `calc(100% - ${positioning.linesOffsetPx}px)`,
      display: "",
      transform: `translateY(${positioning.transformY}px)`,
      height: `${positioning.height}px`,
    });
    const edges = partialEdgesOf(positioning);
    this.toggleAttribute("partial-top", edges.top);
    this.toggleAttribute("partial-bottom", edges.bottom);
    return true;
  }

  /** Hides the column (a pooled column with no fragment to show) and drops
   *  the partial edges of the fragment it showed last, so nothing that reads
   *  `partial-top` / `partial-bottom` without checking display (test
   *  selectors, the days strip's occlusion) sees a hidden column as split. */
  park(): void {
    this.toggleAttribute("partial-top", false);
    this.toggleAttribute("partial-bottom", false);
    this.assignStyles({ display: "none" });
  }

  setOnTooltip(onClick: EmptyFunction) {
    GESTURE_MANAGER.addPointerEvent(this.$("tzabbr-top"), { onClick });
    GESTURE_MANAGER.addPointerEvent(this.$("tzabbr-bottom"), { onClick });
  }

  /** Pointer x as a fraction (0..1) across the column's width. Null
   *  before layout (zero width). */
  private xFractionAt(x: number): Option<number> {
    const width = this.clientWidth;
    return width > 0 ? Math.max(0, Math.min(1, x / width)) : null;
  }

  setCallbacks(callbacks: CalendarColumn.Callbacks) {
    GESTURE_MANAGER.addPointerEvent(this, {
      onPointerDown: (offset) => {
        callbacks.onPointerDown({
          position: new CalendarColumnCell.PointerPosition(
            { x: offset.x, y: offset.y },
            null,
            this.xFractionAt(offset.x),
          ),
        });
      },
      onClick: (_, offset) => {
        callbacks.onPointerUpColumn({
          position: new CalendarColumnCell.PointerPosition(
            { x: offset.x, y: offset.y },
            null,
            this.xFractionAt(offset.x),
          ),
        });
      },
      onContextMenu: (_, offset) => {
        callbacks.onContextMenu({
          position: new CalendarColumnCell.PointerPosition(
            { x: offset.x, y: offset.y },
            null,
            this.xFractionAt(offset.x),
          ),
          offset: offset,
        });
      },
    });
    this.onpointerenter = () => callbacks.onPointerEnter();
    this.onpointerleave = () => callbacks.onPointerLeave();
    this.onpointermove = (e) => {
      e.stopPropagation();
      const { shouldCapturePointer } = callbacks.onPointerMove({
        position: new CalendarColumnCell.PointerPosition(
          { x: e.offsetX, y: e.offsetY },
          null,
          this.xFractionAt(e.offsetX),
        ),
      });
      if (shouldCapturePointer) {
        this.setPointerCapture(e.pointerId);
      } else {
        this.releasePointerCapture(e.pointerId);
      }
    };
  }

  /** The shadow sheet's own rules as text (after `CalendarColumnLayout.$lines`), read as data by its tests. */
  static readonly SHADOW_CSS: string = SHADOW_CSS;
  static $styles = [CalendarColumnLayout.$lines, css(SHADOW_CSS)];

  /** The shadow template's markup as text (`$html`), read as data by its tests. */
  static readonly SHADOW_HTML: string = SHADOW_HTML;
  static $html: Option<HTMLTemplateElement> = html(SHADOW_HTML);
}

export namespace CalendarColumn {
  /** Which edges of a column are partial: rounded at `PARTIAL_EDGE_RADIUS_PX`, with the zone tab on them. */
  export type PartialEdges = { readonly top: boolean; readonly bottom: boolean };

  /**
   * The one decision of which edges of a column are partial: an edge the
   * column key's partial window sets (a flight), or a zone fragment edge
   * inside the hours window (a DST split). `bind` writes `partial-top` /
   * `partial-bottom` from it, and the sheet's skeleton rounds its span's
   * corners from it, so the two cannot disagree. Null when the windowed
   * fragment has no hours (the column hides).
   */
  export function partialEdges(windowed: DateFragment.Windowed): Option<PartialEdges> {
    const placed = windowed.getPositioning(PIXELS_PER_HOUR);
    return placed && partialEdgesOf(placed);
  }

  export type Callbacks = {
    onPointerDown: (event: {
      position: CalendarColumnCell.PointerPosition;
    }) => void;
    onPointerUpColumn: (event: {
      position: CalendarColumnCell.PointerPosition;
    }) => void;
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onPointerMove: (event: {
      position: CalendarColumnCell.PointerPosition;
    }) => {
      shouldCapturePointer: boolean;
    };
    onContextMenu: (event: {
      position: CalendarColumnCell.PointerPosition;
      offset: { x: number; y: number };
    }) => void;
  };

  export namespace Callbacks {
    export const DEFAULT: Callbacks = {
      onPointerDown: Constants.EMPTY_FUNCTION,
      onPointerUpColumn: Constants.EMPTY_FUNCTION,
      onPointerEnter: Constants.EMPTY_FUNCTION,
      onPointerLeave: Constants.EMPTY_FUNCTION,
      onPointerMove: () => ({ shouldCapturePointer: false }),
      onContextMenu: Constants.EMPTY_FUNCTION,
    };
  }
}
