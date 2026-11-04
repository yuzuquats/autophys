import "@tento-ui/components/scroll/scroll-horizontal";

import { NaiveDate } from "@tento-chrono";
import { nonnull } from "@tento-core/assert";
import { AVLTree } from "@tento-core/avl-tree";
import { LiveData } from "@tento-core/livedata";
import { Tracing } from "@tento-core/tracing";
import { Point } from "@tento-core/point";
import { NumRangeLike } from "@tento-core/range";
import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Button } from "@tento-ui/components/button/button";
import { Divider } from "@tento-ui/components/divider";
import {
  type BindGeneration,
  type BindQueueState,
  ScrollEngine,
  SettleDebt,
  type SettleResult,
} from "@tento-scroll/engine/scroll-engine";
import { ScrollHorizontal } from "@tento-ui/components/scroll/scroll-horizontal";
import { ScrollPopover } from "@tento-ui/components/scroll/scroll-popover";
import { ScrollTooltip } from "@tento-ui/components/scroll/scroll-tooltip";
import { ColumnIndex } from "./column-index";
import { ColumnSpace } from "./column-space";
import {
  SpecRegistry as _SpecRegistry,
  ViewportCuller as _ViewportCuller,
  FixedChildSpec,
  FixedChildXPosition,
} from "./fixed-child-culling";
import { RowIdentity, rowIdentity } from "./row-identity";
import { SheetLayoutWidth } from "./sheet-layout-width";
import { SheetNavigator } from "./sheet-navigator";
import { FixedChildLayoutManager } from "./fixed-child-layout-manager";

/**
 * Inline-style and attribute writes that skip an equal value. A same-value
 * `style.setProperty` of a custom property still dirties the element's style
 * in Blink — measured on the bench calendar: rewriting 126 fixed all-day
 * children with their own `--x` cost 2.6 ms of style recalc, 0.1 ms guarded
 * (Chrome 131, project sheet-scroll-smoothness) — and the fixed-child
 * reconcile below runs for every row on every rendered-columns change, i.e.
 * on every step of a scroll, so its writes must be no-ops when nothing moved.
 */
function setPropertyIfChanged(
  $e: HTMLElement,
  name: string,
  value: string,
): void {
  if ($e.style.getPropertyValue(name) === value) return;
  $e.style.setProperty(name, value);
}
function setAttributeIfChanged(
  $e: HTMLElement,
  name: string,
  value: string,
): void {
  if ($e.getAttribute(name) === value) return;
  $e.setAttribute(name, value);
}

export namespace FixedChild {
  export class Node implements Identifiable<string>, AVLTree.HasNumRange {
    // Optional date-based positioning (source of truth when set)
    dateRange?: { start: NaiveDate; end?: NaiveDate | undefined } | undefined;

    constructor(
      public id: string,
      public range: NumRangeLike,
      public columnRange: ColumnIndex.Key.Resolved.WithSubindex.RangeOpen,
      public data: Node.Data,
      public widthBehavior: "fill" | "fill-right" | "auto" | number,
    ) {}

    updateColumnRangeFromDates(mapper: ColumnIndex.Mapper): void {
      if (!this.dateRange) return;

      const startKey = ColumnIndex.Key.fromDate(this.dateRange.start, "lower");
      const startResolved = mapper
        .resolveKeyToDefault(startKey, "lower")
        .withSubindex(mapper.indexOfKey(startKey).subindex);

      let endResolved: ColumnIndex.Key.Resolved.WithSubindex | undefined;
      if (this.dateRange.end) {
        // `dateRange.end` is INCLUSIVE: it names the last column covered, and
        // `subindex.inc()` walks to that column's far edge. So end === start
        // is one column wide — and a caller that hands us an EXCLUSIVE end
        // gets one column too many, in both the pixel width and `this.range`
        // (the cull span) below.
        const endKey = ColumnIndex.Key.fromDate(this.dateRange.end, "upper");
        endResolved = mapper
          .resolveKeyToDefault(endKey, "upper")
          .withSubindex(mapper.indexOfKey(endKey).subindex.inc());
      }

      this.columnRange = new ColumnIndex.Key.Resolved.WithSubindex.RangeOpen(
        startResolved,
        endResolved,
      );
      // range.end is exclusive — add 1 so the AVL tree includes the last column.
      // The columnRange already handles this via .inc() subindex for pixel width.
      this.range = {
        start: startResolved.key.offset,
        end: endResolved ? endResolved.key.offset + 1 : startResolved.key.offset + 1,
      };
    }

    bindWidth(navigator: SheetNavigator) {
      if (typeof this.widthBehavior === "number") {
        this.setWidthIfChanged(
          `calc(${this.widthBehavior}px + var(--additional-width, 0px))`,
        );
        return;
      }

      const crw = this.columnRange.width(navigator.scrollEngine);
      if (crw && this.columnRange.end) {
        this.setWidthIfChanged(`calc(${crw}px + var(--additional-width, 0px))`);
        return;
      }

      switch (this.widthBehavior) {
        case "fill": {
          const startIdx = this.columnRange.start.key.offset;
          const width = navigator.scrollEngine.cellWidth.get(startIdx);
          this.setWidthIfChanged(
            `calc(${width}px + var(--additional-width, 0px))`,
          );
          break;
        }
        case "fill-right": {
          const startIdx = this.columnRange.start.key.offset;
          const columnOffset =
            navigator.scrollEngine.window.getOffset(startIdx);
          if (columnOffset == null) break;
          const viewport = navigator.scrollEngine.viewport.visible;
          const viewportEnd = viewport.offsetStart + viewport.length;
          const availableWidth = Math.max(0, viewportEnd - columnOffset);
          this.setWidthIfChanged(
            `calc(${availableWidth}px + var(--additional-width, 0px))`,
          );
          break;
        }
        case "auto":
          this.setWidthIfChanged("");
          break;
      }
    }

    private setWidthIfChanged(nextWidth: string): void {
      if (this.data.$content.style.width === nextWidth) {
        return;
      }
      this.data.$content.style.width = nextWidth;
    }

    startOffsetPx(navigator: SheetNavigator): Option<number> {
      return this.columnRange.subindexOffsetPx(navigator.scrollEngine);
    }

    /**
     * Re-resolves dates to column positions and updates CSS variables.
     * Returns the subindex offset for --additional-x calculation.
     */
    rebindXPosition(
      mapper: ColumnIndex.Mapper,
      navigator: SheetNavigator,
      scroll: {
        updateFixedChildIndex: (e: HTMLElement, idx: number) => Option<number>;
      },
    ): Option<number> {
      this.updateColumnRangeFromDates(mapper);

      const newIndex = this.columnRange.start.key.offset;
      const newOffset = scroll.updateFixedChildIndex(
        this.data.$content,
        newIndex,
      );

      if (newOffset != null) {
        setPropertyIfChanged(this.data.$content, "--x", newOffset + "px");
      }

      this.bindWidth(navigator);
      return this.startOffsetPx(navigator);
    }

    static fromColumnIndicies(
      id: string,
      range: ColumnIndex.Key.Resolved.WithSubindex.RangeOpen,
      data: Node.Data,
      widthBehavior: "auto" | "fill" | "fill-right" | number,
    ) {
      return new Node(
        id,
        {
          start: range.start.key.offset,
          end: range.end ? range.end.key.offset + 1 : range.start.key.offset + 1,
        },
        range,
        data,
        widthBehavior,
      );
    }
  }
  export namespace Node {
    export type Data = {
      $content: HTMLElement;
      location: "header" | "body" | "footer";
      inset: Option<Optional<Inset>>;
      yPosition: LiveData<number>;
      rowId: Option<RowIdentity>;
      owner: Option<string>;
    };
  }

  export const LayoutManager = FixedChildLayoutManager<Node>;

  export const SpecRegistry = _SpecRegistry;
  export type SpecRegistry = _SpecRegistry;
  export const ViewportCuller = _ViewportCuller;
  export type ViewportCuller = _ViewportCuller;
}

/**
 * The one scroll surface a sheet host may call.
 *
 * `Sheet` used to reach `$$.root.$$.scroll.…` — through a hydrate handle, past
 * the component, into its `scrollEngine`, its `window`, its `viewport` — at 28
 * sites. A hydrate handle is a lookup, not a contract: nothing said which of
 * the engine's fields a sheet was entitled to read, so every rung that wanted
 * to reshape one scroll call had to reshape twenty-eight of them first.
 *
 * This port is that reach-through, named. Every member is a 1:1 delegation to
 * the method that already existed, and every raw FIELD read became a narrow
 * method or a readonly getter — so neither {@link ScrollEngine} nor
 * {@link ScrollHorizontal} crosses the boundary as a value, and a sheet cannot
 * acquire one by walking a member it was given for another purpose.
 *
 * Adding a member is a decision about what a sheet host is entitled to see.
 * Widening one back into the raw engine is not a decision anyone may make here.
 */
export interface SheetScrollPort {
  /**
   * Advance the engine's render epoch. Binds queued under an older generation
   * are dropped in the drain. Null-safe before the engine exists.
   */
  setBindGeneration(generation: BindGeneration): void;

  /** Hold content dispatch while this incoming generation prepares its layout. */
  beginBindGeneration(generation: BindGeneration): void;
  /** Release content dispatch after the matching layout/content pass installs. */
  commitBindGeneration(generation: BindGeneration): void;

  /**
   * Toggle `pending-layout` on every currently-rendered column — the
   * per-column co-hide that keeps a column hidden until ITS bind lands.
   */
  markRenderedColumnsPendingLayout(hidden: boolean): void;

  /**
   * Resolve once the bind drain has reached quiesce with `debt` repaid — see
   * {@link SettleDebt} for which of the three release rules each kind names —
   * or once the bounded fallback gives up. The resolution VALUE is which of
   * those happened ({@link SettleResult}), so a caller that audits pixels
   * afterwards can say what its release rests on.
   */
  whenSettled(debt: SettleDebt, signal: Option<AbortSignal>): Promise<SettleResult>;

  /** Passive notification, never a readiness certificate. Returns its cleanup. */
  onBindDrain(callback: () => void): () => void;

  /** Whole-viewport co-hide (`false`) and reveal (`true`). */
  toggleContentVisibility(visible: boolean, animate: boolean): void;

  /** The scroll host's `footer-bg-visible` presentation flag. */
  toggleFooterBackground(visible: boolean): void;

  /** Restore the content viewport's vertical scroll offset. */
  setListScrollTop(top: number): void;

  /** Drop an absolutely-positioned static child by its composed id. */
  dismissStaticChild(
    location: "header" | "body" | "footer",
    staticId: string,
  ): void;

  /** Re-emit every rendered column; `widthChangeOnly` skips content binds. */
  emitAll(widthChangeOnly: boolean, context: string): void;

  /** Rendered width in px of the column at `index`. */
  cellWidthAt(index: number): number;

  /** Content-space x offset of `index`; null outside the built window. */
  offsetOf(index: number): Option<number>;

  /** First visible column index in the engine's index space. */
  visibleStartIndex(): number;

  /** Live position without reading the content extent. */
  getScrollPosition(): Option<{ left: number; top: number }>;

  /** The position the last scroll event reported, without a DOM read; null when unknown. */
  observedScrollPosition(): Option<{ left: number; top: number }>;

  /** Live scroll geometry of the content viewport. */
  getScrollInfo(): Option<SheetScrollPort.ScrollInfo>;

  /** Where the pointer is, in viewport and content space. */
  readonly pointerPosition: LiveData<Option<SheetScrollPort.PointerPosition>>;

  /** Bind-epoch facts, sampled together so a caller cannot mix two reads. */
  bindQueue(): BindQueueState;

  /** The header band's presentation. */
  readonly headerPeek: SheetScrollPort.HeaderPeek;
}

export namespace SheetScrollPort {
  /** The header band's presentation, exactly the part a sheet host drives. */
  export interface HeaderPeek {
    setHeight(heightPx: Option<number>, animate: boolean): void;
    toggleShadow(force: boolean): void;
    toggleFullScreen(force: boolean, animate: boolean): void;
  }

  /** @see {@link SheetScrollPort.getScrollInfo} */
  export interface ScrollInfo {
    left: number;
    top: number;
    scrollHeight: number;
  }

  /** @see {@link SheetScrollPort.pointerPosition} */
  export interface PointerPosition {
    viewportX: number;
    viewportY: number;
    contentX: number;
  }
}

/**
 * Column geometry in the SHEET's words.
 *
 * The layer used to take {@link ScrollEngine.LayoutProps} straight from its
 * consumer, so a sheet had to know that its legend is the scroller's
 * `startOccludedPx`, that an open sidebar is an `endOccludedPx`, and that the
 * viewport it measured is a `length`. Those are the SCROLLER's words for three
 * numbers a sheet computes from a legend measurement and a resize observer, and
 * a consumer that spells them cannot be told later that the scroller renamed
 * them. Naming them for what the sheet means moves the translation inside the
 * layer that owns the scroller — see {@link SheetLayoutPort.bindGeometry}.
 */
export type SheetGeometry = {
  /** Width one column paints at, before any per-index override. */
  readonly cellWidthPx: number;
  /** Width the row legend occludes on the LEFT of the scrolling viewport. */
  readonly legendWidthPx: number;
  /** Width occluded on the RIGHT — an open sidebar, a drawer. */
  readonly rightInsetPx: number;
  /** Width of the whole viewport, legend and right inset included. */
  readonly viewportWidthPx: number;
};

/**
 * What a sheet host may ask about, and do to, the COLUMN strip.
 *
 * Merged from the two handles that used to answer these questions —
 * `stateHandle` (the strip resolved through the layout's own mapper) and
 * `rebindHandle` (the same strip as raw indices, plus the one-column re-emit).
 * They were separate objects for no reason a reader could recover: both answer
 * "which columns are on screen right now", at three different resolutions.
 *
 * The three resolutions are deliberate and NOT interchangeable.
 * {@link visible}/{@link rendered} resolve every index through the mapper the
 * last {@link SheetLayoutPort.bindGeometry} installed, so they are calendar
 * ranges and are null before the first bind. {@link visibleColumns}/
 * {@link renderedColumns} are the same strip as unresolved column keys, for a
 * caller that will resolve them through a mapper of its own. {@link
 * visibleIndices}/{@link renderedIndices} are the raw engine numbers, for a
 * caller that only diffs or culls against them.
 */
export interface SheetColumnPort {
  /**
   * The visible strip, resolved through the installed mapper. Null before the
   * first geometry bind, and null whenever the engine's viewport has no range
   * yet — a caller MUST treat that as "ask again next frame", not as "empty".
   */
  readonly visible: Option<ColumnIndex.Key.Resolved.Default.Range>;

  /** The rendered strip — the visible one plus its culled flanks. */
  readonly rendered: Option<ColumnIndex.Key.Resolved.Default.Range>;

  /**
   * The rendered column elements at `key`, or null when that column is not
   * currently rendered. The one place a sheet reaches a live column's DOM by
   * key rather than by walking {@link renderedElements}.
   */
  column(
    key: ColumnIndex.Key,
  ): Option<{ $header: HTMLElement; $body: HTMLElement }>;

  /**
   * Re-emit ONE column's bind. The narrow alternative to
   * {@link SheetScrollPort.emitAll} for a change a caller can localise —
   * a single day's cells arriving, one custom column's data settling.
   */
  rebindColumn(key: ColumnIndex.Key): void;

  /** Every rendered column: its elements, its key, its painted width. */
  renderedElements(): {
    $header: HTMLElement;
    $body: HTMLElement;
    $footer: Option<HTMLElement>;
    column: ColumnIndex.Key;
    widthPx: number;
  }[];

  /**
   * Whether the strip accessors below can be read at all. False until the
   * first geometry bind: the engine is constructed when the element connects
   * but its viewport is not, and {@link visibleIndices}/{@link renderedIndices}
   * are typed non-Option, so an unbound read throws rather than returning
   * nothing. A caller that can run before the first sheet binds — the boot
   * `idle` reveal is the one that does — MUST gate on this.
   */
  readonly geometryBound: boolean;

  /** The visible strip as raw engine indices. */
  visibleIndices(): NumRangeLike;

  /** The rendered strip as raw engine indices. */
  renderedIndices(): NumRangeLike;

  /** The visible strip as unresolved column keys. */
  visibleColumns(): Option<ColumnIndex.Key.Range>;

  /** The rendered strip as unresolved column keys; null while it is empty. */
  renderedColumns(): Option<ColumnIndex.Key.Range>;
}

/**
 * Absolutely-positioned children that travel WITH the column strip: an event
 * span, an all-day chip, a debug overlay. Their x is a column position the
 * layer re-resolves on every scroll and every mapper swap, which is what
 * separates them from {@link SheetStaticChildrenPort}.
 *
 * The spec half of this face ({@link registerSpecs} onward) is the declarative
 * path: a plugin registers what a row WOULD render across the whole timeline,
 * the layer culls that to the rendered range, and
 * {@link setFixedChildrenForRow} diffs the survivors against what is mounted.
 */
export interface SheetFixedChildrenPort {
  /** Mount at a resolved column position. Replaces any same-id child. */
  reveal(
    identifier: string,
    $content: HTMLElement,
    position: Point<ColumnIndex.Key.Resolved.WithSubindex, LiveData<number>>,
    location: "header" | "body" | "footer",
    options: Option<
      Optional<{
        animate: boolean;
        inset: Optional<Inset>;
        end: ColumnIndex.Key.Resolved.WithSubindex;
        widthBehavior: "fill" | "fill-right" | "auto" | number;
      }>
    >,
  ): void;

  /**
   * Mount at a DATE position. The layer keeps the raw dates on the node, so a
   * mapper swap re-resolves the child instead of stranding it at the column
   * index the old space gave it.
   */
  revealDates(
    identifier: string,
    $content: HTMLElement,
    position: Point<NaiveDate, LiveData<number>>,
    location: "header" | "body" | "footer",
    options: Option<
      Optional<{
        animate: boolean;
        inset: Optional<Inset>;
        endDate: NaiveDate;
        widthBehavior: "fill" | "fill-right" | "auto" | number;
      }>
    >,
  ): void;

  /** Mount at a LIVE pixel position — a drag ghost, which no column owns. */
  revealLive(
    identifier: string,
    $content: HTMLElement,
    position: { x: LiveData<number>; y: LiveData<number> },
    location: "header" | "body" | "footer",
  ): void;

  /** Unmount one child by id. */
  dismiss(identifier: string, animate: boolean): void;

  /** Unmount every child and drop the spec registry with them. */
  dismissAll(): void;

  /** Whether a child with this id is currently mounted. */
  hasFixedChild(identifier: string): boolean;

  /** The mounted element for this id, or null. */
  getFixedChild(identifier: string): Option<HTMLElement>;

  /** Every mounted child, for a caller re-deriving geometry across all. */
  getAllFixedChildren(): HTMLElement[];

  /**
   * Re-inset an existing child. `resolvedYPx` is the scroll-relative row top
   * the CALLER already resolved — the layer does not re-derive it, so the
   * update lands on the same pixel the original reveal did.
   */
  updateFixedChildInset(
    identifier: string,
    newInset: Optional<Inset>,
    resolvedYPx: number,
  ): boolean;

  /** Move an existing child to a new column + x inset, without a re-reveal. */
  repositionFixedChild(
    identifier: string,
    column: ColumnIndex.Key.Resolved.WithSubindex,
    insetLeftPx: number,
  ): boolean;

  /** Pin an existing child to an explicit pixel width. */
  updateFixedChildWidth(identifier: string, widthPx: number): boolean;

  /**
   * Declarative reconcile for ONE row's children under ONE owner: mount what is
   * new, update what moved, dismiss what the caller no longer asks for.
   */
  setFixedChildrenForRow(
    rowId: RowIdentity,
    children: Array<{
      id: string;
      x: FixedChildXPosition;
      inset: Optional<Inset>;
      widthBehavior: "fill" | "fill-right" | "auto" | number;
      makeElement: () => HTMLElement;
      onUpdate?: ($element: HTMLElement) => void;
    }>,
    options: { owner: string },
    rowOffsetPx: number,
    location: "header" | "body" | "footer",
  ): void;

  /** Drop every child AND every registered spec belonging to one owner. */
  clearFixedChildrenByOwner(owner: string): void;

  /** Record what a row would render across the whole timeline, for culling. */
  registerSpecs(
    rowId: RowIdentity,
    owner: string,
    specs: FixedChildSpec[],
  ): void;

  /** Cull the registered specs to `visibleRange`; survivors are mounted. */
  reconcileSpecs(
    rowId: RowIdentity,
    owner: string,
    visibleRange: NumRangeLike,
  ): FixedChildSpec[];

  /** Forget one row+owner's registered specs. */
  clearSpecs(rowId: RowIdentity, owner: string): void;

  /** Suppress one spec by id — it stays registered but is never culled in. */
  suppressSpec(specId: string): void;

  /** Every `rowId::owner` key held, for a caller re-culling all of them. */
  specRegistryKeys(): IterableIterator<string>;

  /** The child a row owns at column `offset`, for cell-target resolution. */
  findByRowAndOffset(rowId: RowIdentity, offset: number): Option<HTMLElement>;
}

/**
 * Children pinned to the SCROLLER rather than to a column — a month-view panel,
 * a spanning label. They keep their x while the strip scrolls under them, which
 * is the whole difference from {@link SheetFixedChildrenPort}.
 *
 * Every member is keyed by `(id, rowId, location)`; the layer composes the
 * `${id}-${rowId}` static id so a caller never has to spell that convention.
 */
export interface SheetStaticChildrenPort {
  /** Mount for one row in one band; `fillWidth` stretches to the viewport. */
  reveal(
    id: string,
    $e: HTMLElement,
    rowId: RowIdentity,
    location: "header" | "body" | "footer",
    fillWidth: boolean,
  ): void;

  /** The mounted element for this key, or null. */
  get(
    id: string,
    rowId: RowIdentity,
    location: "header" | "body" | "footer",
  ): Option<HTMLElement>;

  /** Unmount one child. */
  dismiss(
    id: string,
    rowId: RowIdentity,
    location: "header" | "body" | "footer",
  ): void;

  /** Every mounted static child across all three bands. */
  getAll(): HTMLElement[];

  /** Unmount all of them; returns what was unmounted. */
  dismissAll(): HTMLElement[];
}

/** Both kinds of absolutely-positioned child, told apart by their anchor. */
export interface SheetChildrenPort {
  /** Children anchored to a COLUMN — they travel with the strip. */
  readonly fixed: SheetFixedChildrenPort;
  /** Children anchored to the SCROLLER — the strip travels under them. */
  readonly static: SheetStaticChildrenPort;
}

/**
 * One floating surface over the grid. Popovers and tooltips differ only in
 * their options and their dismiss timing, so they are one shape twice rather
 * than two near-identical handles — which is what they were.
 *
 * Both are singular per surface: revealing a second replaces the first, and
 * {@link currentId} is how a caller asks what is up without holding a
 * reference to it.
 */
export interface SheetOverlaySurface<Options> {
  /** Reveal `$content` anchored at a resolved column and a live y offset. */
  reveal(
    identifier: string,
    $content: HTMLElement,
    position: Point<ColumnIndex.Key.Resolved.WithSubindex, LiveData<number>>,
    location: "header" | "body" | "footer",
    options: Option<Options>,
  ): void;

  /** Dismiss by id; a stale id is a no-op, so a caller need not check first. */
  dismiss(identifier: string): void;

  /** The id currently revealed on this surface, or null. */
  currentId(): Option<string>;
}

/** Everything that floats ABOVE the grid rather than inside the strip. */
export interface SheetOverlayPort {
  /** The popover surface — persistent, dismissed explicitly. */
  readonly popover: SheetOverlaySurface<ScrollPopover.Options>;

  /** The tooltip surface — transient, dismissed on a delay. */
  readonly tooltip: SheetOverlaySurface<ScrollTooltip.Options>;

  /**
   * Mount the row-options anchor as a child of the layout host.
   *
   * The one overlay a sheet builds and owns end-to-end: it positions itself
   * against the scroller's own scroll info and removes itself on dismiss, so
   * the layer only lends it a parent. Named rather than left as an
   * `appendChild` on the element because "who may add children to the layout
   * host" is exactly the sort of question a port exists to answer.
   */
  attachRowOptionsAnchor($anchor: HTMLElement): void;
}

/**
 * The layout host's own presentation — the handful of styles and attributes a
 * sheet drives on the ELEMENT rather than through the scroller.
 *
 * These were eleven raw `assignStyles` / `setAttribute` / `style.opacity`
 * writes on `$$.root` at the call site, which is how a CSS custom property and
 * an ARIA contract became things any caller could invent. Each one is now a
 * name, and the layer owns the units, the string form, and the clearing rule.
 */
export interface SheetPresentationPort {
  /** Top margin every body column reserves for the header band. */
  setBodyMarginTop(px: number): void;

  /** Height the footer band reserves. */
  setFooterHeight(px: number): void;

  /**
   * Hide the whole layout without unmounting it — the navigation transition's
   * scrub, which must keep geometry so the incoming bind has something to
   * restore heights onto.
   */
  setRootHidden(hidden: boolean): void;

  /** `null` clears the attribute — the layer owns its own a11y contract. */
  setGridSize(rows: Option<number>, columns: Option<number>): void;
}

/**
 * The one surface a sheet host may drive `SheetLayout` through.
 *
 * {@link SheetScrollPort} (R1) named the 28 scroll reach-throughs and has been
 * the pattern ever since; the other 84 sites went through six handle objects
 * whose types were INFERRED from an object literal, plus raw DOM writes on the
 * element. An inferred handle is not a contract: nothing said which members a
 * sheet was entitled to, adding one was invisible, and the compiler had no
 * event to report when the surface grew.
 *
 * This is that surface, declared. Each face answers one question — what the
 * columns are ({@link columns}), what is mounted between them
 * ({@link children}), what floats above them ({@link overlays}), how the host
 * itself presents ({@link presentation}) — and the two binds plus
 * {@link space} are the layer's lifecycle. Every member is a 1:1 delegation to
 * the call that already existed, so this rung moved WHERE a call is declared,
 * not WHAT it does.
 *
 * Adding a member is a decision about what a sheet host is entitled to see.
 */
export interface SheetLayoutPort {
  /** The scroll surface, unchanged since R1. @see {@link SheetScrollPort} */
  readonly scroll: SheetScrollPort;

  /** The column strip. @see {@link SheetColumnPort} */
  readonly columns: SheetColumnPort;

  /** Absolutely-positioned children. @see {@link SheetChildrenPort} */
  readonly children: SheetChildrenPort;

  /** Popovers, tooltips, row options. @see {@link SheetOverlayPort} */
  readonly overlays: SheetOverlayPort;

  /** The host's own styles and ARIA. @see {@link SheetPresentationPort} */
  readonly presentation: SheetPresentationPort;

  /**
   * Wire the sheet's column factory and viewport callbacks. Runs once, before
   * any bind; a second call would re-initialize the scroller underneath a live
   * strip.
   */
  initialize(delegate: SheetLayout.Delegate): void;

  /**
   * Commit new column geometry in the space `space` names.
   *
   * MUST run before {@link bindContent} in the same pass: the engine re-anchors
   * and emits `layout-changed` SYNCHRONOUSLY from inside this call, and every
   * index in that emit is resolved through the mapper this installs (R19).
   */
  bindGeometry(geometry: SheetGeometry, space: ColumnIndex.Mapper): void;

  /** Commit geometry and content together when the destination is already
   * known, avoiding an intermediate render at the outgoing anchor. */
  bindFrame(
    geometry: SheetGeometry,
    content: SheetLayoutPort.Content,
    space: ColumnIndex.Mapper,
  ): void;

  /**
   * Commit the sheet identity + where the horizontal window should land, in the
   * space `space` names. Runs after {@link bindGeometry} in the same pass.
   */
  bindContent(
    content: SheetLayoutPort.Content,
    space: ColumnIndex.Mapper,
  ): void;

  /** Commit the vertical bands (header / body / footer heights). */
  bindScrollProps(props: ScrollHorizontal.Props): void;

  /** Commit ONLY the scrollable body height — the drag-resize fast path. */
  bindScrollHeightOnly(scrollContentHeight: number): void;

  /**
   * Re-resolve every date-anchored fixed child's x against the current mapper
   * and window. Callers pair this with their own y pass after any geometry
   * change.
   */
  rebindFixedChildPositions(): void;

  /**
   * The mapper the last bind installed — what an index emitted RIGHT NOW means.
   *
   * Null before the first bind, and legitimately BEHIND a caller's own mapper
   * mid-pass: a sheet swaps its view model early and only reaches
   * {@link bindGeometry} later in the same pass. A caller that wants THE
   * SHEET's mapper must read it off the sheet; this answers "what does the
   * LAYER currently think", which is the only honest answer to give about the
   * indices the layer emits.
   */
  readonly space: Option<ColumnIndex.Mapper>;
}

export namespace SheetLayoutPort {
  /** @see {@link SheetLayoutPort.bindContent} */
  export type Content = {
    /** Where the index bind lands. @see {@link SheetLayout.IndexAnchor} */
    indexAnchor: SheetLayout.IndexAnchor;
    animate: boolean;
    sheetId: string;
    contextDirtied: boolean;
    /**
     * Suppress the vertical scroll restore. Required, not optional: "the caller
     * did not say" and "the caller wants the position kept" are different
     * answers, and a data refresh that must keep the user's scroll is the
     * common case rather than the exception.
     */
    skipScroll: boolean;
  };
}

@component({
  name: "std-sheet-layout",
})
export class SheetLayout extends LonaWebComponent {
  // @init
  _delegate: Option<SheetLayout.Delegate>;
  navigator: Option<SheetNavigator>;
  #sheetId: Option<string>;
  /**
   * What an index emitted RIGHT NOW means. Assigned by `bindGeometry` — not by
   * `bindContent` — because the engine reconciles and emits `layout-changed`
   * synchronously inside it, and the delegate callbacks below resolve every
   * index in that emit through this field (R19; see {@link bindGeometry}).
   * The two companion fields this used to sit beside are gone: the space the
   * engine's window was built in is the engine's own, and the reflow the last
   * bind's mapper used to decide is the engine's too (see {@link ColumnSpace}).
   *
   * Read out through {@link SheetLayoutPort.space} as an `Option`. The getter
   * this replaces returned `this.#mapper!` — a definite assertion the repo
   * forbids, and one that turned "no bind has run yet" into a TypeError a frame
   * later at whichever member happened to dereference it first.
   */
  #mapper: Option<ColumnIndex.Mapper> = null;

  /**
   * The installed mapper, required. Every member that resolves an index needs
   * one, and there is no answer before the first {@link bindGeometry} — so say
   * so HERE, where the caller can see which call it skipped, rather than
   * downstream inside a range resolution.
   */
  #requireSpace(): ColumnIndex.Mapper {
    return nonnull(
      this.#mapper,
      "SheetLayout: bindGeometry must run before columns can be resolved",
    );
  }
  // #cellWidthConstraints = new LiveData<SheetLayoutWidth.Constraints>({
  //   weak: true,
  //   preferredWidthPx: 120,
  //   minWidthPx: 60,
  // });

  // @state
  #fixedChildLayoutManager = new FixedChild.LayoutManager();
  #specRegistry = new FixedChild.SpecRegistry();
  #viewportCuller: Option<FixedChild.ViewportCuller> = null;

  // @components
  readonly $$ = {
    scroll:
      this.hydrate<ScrollHorizontal<HTMLElement, HTMLElement, HTMLElement>>(
        "scroll",
      ),
  };

  readonly #scrollPort: SheetScrollPort = ((self) => {
    return {
      bindQueue(): BindQueueState {
        return self.$$.scroll.scrollEngine.bindQueue();
      },
      get headerPeek(): SheetScrollPort.HeaderPeek {
        return self.$$.scroll.headerPeek;
      },
      get pointerPosition(): LiveData<
        Option<SheetScrollPort.PointerPosition>
      > {
        return self.$$.scroll.pointerPosition;
      },
      setBindGeneration(generation: BindGeneration): void {
        self.$$.scroll.setBindGeneration(generation);
      },
      beginBindGeneration(generation: BindGeneration): void {
        self.$$.scroll.beginBindGeneration(generation);
      },
      commitBindGeneration(generation: BindGeneration): void {
        self.$$.scroll.commitBindGeneration(generation);
      },
      markRenderedColumnsPendingLayout(hidden: boolean): void {
        self.$$.scroll.markRenderedColumnsPendingLayout(hidden);
      },
      whenSettled(debt: SettleDebt, signal: Option<AbortSignal>): Promise<SettleResult> {
        return self.$$.scroll.whenSettled(debt, signal);
      },
      onBindDrain(callback: () => void): () => void {
        return self.$$.scroll.onBindDrain(callback);
      },
      toggleContentVisibility(visible: boolean, animate: boolean): void {
        self.$$.scroll.toggleContentVisibility(visible, animate);
      },
      toggleFooterBackground(visible: boolean): void {
        self.$$.scroll.toggleAttribute("footer-bg-visible", visible);
      },
      setListScrollTop(top: number): void {
        self.$$.scroll.listScrollTop = top;
      },
      dismissStaticChild(
        location: "header" | "body" | "footer",
        staticId: string,
      ): void {
        self.$$.scroll.staticChildrenHandle.dismiss(location, staticId);
      },
      emitAll(widthChangeOnly: boolean, context: string): void {
        self.$$.scroll.scrollEngine.emit.all(widthChangeOnly, context);
      },
      cellWidthAt(index: number): number {
        return self.$$.scroll.scrollEngine.cellWidth.get(index);
      },
      offsetOf(index: number): Option<number> {
        return self.$$.scroll.scrollEngine.window.getOffset(index);
      },
      visibleStartIndex(): number {
        return self.$$.scroll.scrollEngine.viewport.visible.indexRange.start;
      },
      getScrollPosition(): Option<{ left: number; top: number }> {
        return self.$$.scroll.getScrollPosition();
      },
      observedScrollPosition(): Option<{ left: number; top: number }> {
        return self.$$.scroll.observedScrollPosition();
      },
      getScrollInfo(): Option<SheetScrollPort.ScrollInfo> {
        return self.$$.scroll.getScrollInfo();
      },
    };
  })(this);

  /**
   * The one scroll surface a sheet host may call — see {@link SheetScrollPort}.
   * Built once and stable, so a caller may hold it across ticks exactly as it
   * used to hold `$$.scroll`.
   *
   * Identical to `port.scroll`; kept because R1's 28 call sites already spell
   * it and moving them is not what this rung is about.
   */
  get scrollPort(): SheetScrollPort {
    return this.#scrollPort;
  }

  /**
   * The whole port, built once. Each face is a GETTER rather than a captured
   * value so this field may be declared before the faces it names — a `#`
   * private read during field initialization would throw, and the declaration
   * order of five large objects is not something a later edit should have to
   * remember.
   */
  readonly #port: SheetLayoutPort = ((self) => ({
    get scroll(): SheetScrollPort {
      return self.#scrollPort;
    },
    get columns(): SheetColumnPort {
      return self.#columns;
    },
    get children(): SheetChildrenPort {
      return self.#children;
    },
    get overlays(): SheetOverlayPort {
      return self.#overlays;
    },
    get presentation(): SheetPresentationPort {
      return self.#presentation;
    },
    get space(): Option<ColumnIndex.Mapper> {
      return self.#mapper;
    },
    initialize(delegate: SheetLayout.Delegate): void {
      self.#initialize(delegate);
    },
    bindGeometry(geometry: SheetGeometry, space: ColumnIndex.Mapper): void {
      self.#bindGeometry(geometry, space);
    },
    bindFrame(geometry: SheetGeometry, content: SheetLayoutPort.Content, space: ColumnIndex.Mapper): void {
      self.#bindFrame(geometry, content, space);
    },
    bindContent(
      content: SheetLayoutPort.Content,
      space: ColumnIndex.Mapper,
    ): void {
      self.#bindContent(content, space);
    },
    bindScrollProps(props: ScrollHorizontal.Props): void {
      self.#bindScrollProps(props);
    },
    bindScrollHeightOnly(scrollContentHeight: number): void {
      self.#bindScrollHeightOnly(scrollContentHeight);
    },
    rebindFixedChildPositions(): void {
      self.#rebindFixedChildPositions();
    },
  }))(this);

  /**
   * The one surface a sheet host may drive this component through — see
   * {@link SheetLayoutPort}. Stable for the element's lifetime, so a consumer
   * holds this instead of the element.
   */
  get port(): SheetLayoutPort {
    return this.#port;
  }

  #initialize(delegate: SheetLayout.Delegate) {
    this._delegate = delegate;
    this.$$.scroll.initialize({
      onCreate: () => ({
        $header: delegate.createColumn(),
        $body: delegate.createColumn(),
        $footer: delegate.createColumn(),
      }),
      onBind: (
        { $header, $body, $footer },
        index: number,
        width,
        resizeOnly,
        isOffscreen,
      ) => {
        delegate.onBind(
          index,
          { $header, $body, $footer: $footer ?? null },
          width,
          resizeOnly,
          isOffscreen,
        );
      },
      onRecycle: ({ $header, $body, $footer }) => {
        delegate.recycleColumn($header);
        delegate.recycleColumn($body);
        if ($footer) delegate.recycleColumn($footer);
      },
      options: {
        onPlace: (item, index, _offset, width) => {
          delegate.onPlace?.(index, { ...item, $footer: item.$footer ?? null }, width);
        },
        onVisibleIndiciesChanged: (r, viewportChangeSource) => {
          const space = this.#mapper;
          if (!space) return;
          delegate.onViewportColumnsChanged(
            ColumnIndex.Key.Resolved.Default.Range.fromIndexSinceAnchorRange(
              r,
              space,
            ),
            viewportChangeSource,
          );
        },
        onRenderedIndiciesWillChange: (r) => {
          const space = this.#mapper;
          if (!space) return;
          delegate.onRenderedColumnsWillChange(
            ColumnIndex.Key.Resolved.Default.Range.fromIndexSinceAnchorRange(
              r,
              space,
            ),
          );
        },
        onRenderedIndiciesChanged: (r) => {
          const space = this.#mapper;
          if (!space) return;
          // Still optionally-called, and that is not laziness: `?.` does not
          // evaluate its ARGUMENT when the callee is absent, so handing this
          // slot a no-op would start resolving a range on every rendered
          // change for a listener nobody registered.
          delegate.onRenderedColumnsChanged?.(
            ColumnIndex.Key.Resolved.Default.Range.fromIndexSinceAnchorRange(
              r,
              space,
            ),
          );
        },
        cellWidthForIndex: delegate.cellWidthForIndex,
      },
      onScroll: delegate.onScroll,
      onScrollPosition: delegate.onScrollPosition,
    });
    this.navigator = new SheetNavigator(this.$$.scroll.scrollEngine);
  }

  #bindGeometry(geometry: SheetGeometry, space: ColumnIndex.Mapper) {
    // The sheet's four numbers, in the scroller's words. The translation lives
    // here so a consumer never has to know that its legend is an occlusion —
    // see {@link SheetGeometry}.
    const layoutProps: ScrollEngine.LayoutProps = {
      cellWidthPx: geometry.cellWidthPx,
      startOccludedPx: geometry.legendWidthPx,
      endOccludedPx: geometry.rightInsetPx,
      length: geometry.viewportWidthPx,
    };
    Tracing.info("ui")("core/sheet-layout/layout-props", layoutProps);
    // The assignment comes FIRST, and that order is the point:
    // `ScrollEngine.bindLayout` below re-anchors the window into the incoming
    // space and then reconciles + `emit.all("layout-changed")` SYNCHRONOUSLY,
    // and the delegate callbacks wired in `initialize` resolve every index in
    // that emit through `this.#mapper`. Installing the mapper in `bindContent`
    // — which the caller runs only after this returns — resolved incoming-space
    // indices through the outgoing anchor, and a rendered end of −2422 under a
    // year mapper became the year −396, i.e. a cell GET for `end=-395-01-29`
    // the client could not even re-parse (R19).
    this.#mapper = space;
    // Everything else about crossing spaces is the engine's: it remembers the
    // space its own window was built in, decides whether this one differs, and
    // carries the anchor across through the date the outgoing column renders.
    // This layer only says WHICH space the incoming layout is in.
    // The clock is read HERE, not inside the adapter: `ColumnSpace` derives the
    // reach — how far the date axis runs — from today, and the same discipline
    // `ViewportRange.onAxis` uses applies (the call site owns the clock, so a
    // test owns the calendar). Every geometry or space change comes back
    // through this bind, so the band never goes stale by more than a rebind.
    this.$$.scroll.bindLayout(layoutProps, ColumnSpace.of(space, NaiveDate.today()));
  }

  #bindScrollProps(props: ScrollHorizontal.Props) {
    Tracing.info("ui")("core/sheet-layout/scroll-props", props);
    this.$$.scroll.bindScroll(props);
  }

  #bindScrollHeightOnly(scrollContentHeight: number) {
    this.$$.scroll.bindScrollHeightOnly(scrollContentHeight);
  }

  #bindFrame(geometry: SheetGeometry, content: SheetLayoutPort.Content, mapper: ColumnIndex.Mapper): void {
    const anchor = content.indexAnchor;
    if (anchor.kind !== "at" || content.skipScroll || !content.contextDirtied) {
      this.#bindGeometry(geometry, mapper);
      this.#bindContent(content, mapper);
      return;
    }
    if (!ScrollEngine.isAddressableAnchor(anchor.index)) {
      throw new Error(`Unaddressable sheet anchor: ${anchor.index}`);
    }
    this.#prepareContent(content, mapper);
    this.$$.scroll.bindLayoutAt({
      cellWidthPx: geometry.cellWidthPx,
      startOccludedPx: geometry.legendWidthPx,
      endOccludedPx: geometry.rightInsetPx,
      length: geometry.viewportWidthPx,
    }, ColumnSpace.of(mapper, NaiveDate.today()), anchor.index, content.sheetId, content.animate);
  }

  #prepareContent(props: SheetLayoutPort.Content, mapper: ColumnIndex.Mapper): void {
    Tracing.info("ui")("core/sheet-layout/bind");
    // `bindGeometry` has already installed this mapper in the pass production
    // runs (`Sheet.applyResolvedLayout` calls it first); restating it costs
    // nothing and stops a caller that only ever calls this from resolving
    // indices through a stale space. The width reflow a same-sheet mapper swap
    // used to need is no longer decided here — the engine reflows on its own
    // when a rebind changes the space at unchanged geometry.
    this.#mapper = mapper;
    this.#viewportCuller = new FixedChild.ViewportCuller(
      this.#specRegistry,
      mapper,
    );

    if (props.sheetId != this.#sheetId) {
      this.#specRegistry.clearAll();
      this.#fixedChildren.dismissAll();
      this.#staticChildren.dismissAll();
    }
    this.#sheetId = props.sheetId;

    this.navigator?.setMapper(mapper);
  }

  #bindContent(props: SheetLayoutPort.Content, mapper: ColumnIndex.Mapper) {
    this.#prepareContent(props, mapper);
    // `keep` reads the current index HERE, and that timing is the whole point:
    // `bindGeometry` has already run in this same pass and re-anchored the
    // window, translating the anchor across mappers when the flip changed what
    // an index MEANS. Read any earlier — as the caller's pre-flip capture did —
    // and the number is in the OUTGOING space, so re-anchoring to it lands
    // exactly the arbitrary distance away that the translation exists to
    // prevent.
    // `keep` also suppresses the offset reset and the scroll: the window is
    // already where it belongs, and re-origining the map under a scrollable that
    // is not moving is the coordinate-space split `bindGeometry` just closed.
    const anchor = props.indexAnchor;
    const keepIndex = anchor.kind === "keep";
    const index = anchor.kind === "keep"
      ? this.navigator?.currentIndex() ?? 0
      : anchor.index;
    this.$$.scroll.bindIndex(
      index,
      props.sheetId,
      props.animate,
      props.contextDirtied,
      keepIndex || props.skipScroll,
    );
  }

  #rebindFixedChildPositions() {
    if (!this.navigator) return;

    for (const node of this.#fixedChildLayoutManager.findAll()) {
      if (!node.dateRange) continue;

      const subindexOffset = node.rebindXPosition(
        this.#requireSpace(),
        this.navigator,
        this.$$.scroll,
      );

      if (subindexOffset != null) {
        const xOff = node.data.inset?.left ?? 0;
        node.data.$content.style.setProperty(
          "--additional-x",
          subindexOffset + xOff + "px",
        );
      }
    }
  }

  /*
   Port faces
   =============================================================================
  */

  /** @see {@link SheetColumnPort} */
  readonly #columns: SheetColumnPort = ((self) => ({
    get geometryBound(): boolean {
      return self.$$.scroll.hasViewport;
    },
    get visible(): Option<ColumnIndex.Key.Resolved.Default.Range> {
      if (!self.$$.scroll.hasViewport) return null;
      const r = self.$$.scroll.scrollEngine.viewport.visible.indexRange;
      if (r.start == null || r.end == null) return null;
      return ColumnIndex.Key.Resolved.Default.Range.fromIndexSinceAnchorRange(
        r as NumRangeLike,
        self.#requireSpace(),
      );
    },
    get rendered(): Option<ColumnIndex.Key.Resolved.Default.Range> {
      if (!self.$$.scroll.hasViewport) return null;
      const r = self.$$.scroll.scrollEngine.viewport.rendered.indexRange;
      if (r.start == null || r.end == null) return null;
      return ColumnIndex.Key.Resolved.Default.Range.fromIndexSinceAnchorRange(
        r as NumRangeLike,
        self.#requireSpace(),
      );
    },
    column(
      key: ColumnIndex.Key,
    ): Option<{ $header: HTMLElement; $body: HTMLElement }> {
      return self.$$.scroll.scrollEngine.entries.get(
        self.#requireSpace().indexOfKey(key).index,
      )?.t;
    },
    rebindColumn(key: ColumnIndex.Key) {
      self.$$.scroll.scrollEngine.emit.index(
        self.#requireSpace().indexOfKey(key).index,
      );
    },
    renderedElements(): {
      $header: HTMLElement;
      $body: HTMLElement;
      $footer: Option<HTMLElement>;
      column: ColumnIndex.Key;
      widthPx: number;
    }[] {
      return self.$$.scroll.scrollEngine.entries.all.map(
        ({ t: { $header, $body, $footer }, index }) => ({
          $header,
          $body,
          $footer: $footer ?? null,
          column: ColumnIndex.Key.fromIndex(index),
          widthPx: self.$$.scroll.scrollEngine.cellWidth.get(index),
        }),
      );
    },
    visibleIndices(): NumRangeLike {
      return self.$$.scroll.scrollEngine.viewport.visible.indexRange;
    },
    renderedIndices(): NumRangeLike {
      return self.$$.scroll.scrollEngine.viewport.rendered.indexRange;
    },
    visibleColumns(): Option<ColumnIndex.Key.Range> {
      const { start, end } =
        self.$$.scroll.scrollEngine.viewport.visible.indexRange;
      return new ColumnIndex.Key.Range(
        ColumnIndex.Key.fromIndex(start),
        ColumnIndex.Key.fromIndex(end),
      );
    },
    renderedColumns(): Option<ColumnIndex.Key.Range> {
      const { start, end } =
        self.$$.scroll.scrollEngine.viewport.rendered.indexRange;
      if (start == null || end == null) return null;
      return new ColumnIndex.Key.Range(
        ColumnIndex.Key.fromIndex(start),
        ColumnIndex.Key.fromIndex(end),
      );
    },
  }))(this);

  /** @see {@link SheetOverlayPort} */
  readonly #overlays: SheetOverlayPort = ((self) => ({
    popover: {
      reveal: (
        identifier: string,
        $content: HTMLElement,
        position: Point<
          ColumnIndex.Key.Resolved.WithSubindex,
          LiveData<number>
        >,
        location: "header" | "body" | "footer",
        options: Option<ScrollPopover.Options>,
      ) => {
        self.$$.scroll.popoverController.revealPopover(
          new ScrollPopover(
            identifier,
            $content,
            { x: position.x.key.offset, y: position.y },
            position.x.subindex,
            location,
            // The controller's own slot is `options?: …`, and every read of it
            // is a `?.` — so a null and an absent option are the same thing to
            // it, and this is a spelling change rather than a behaviour one.
            options ?? undefined,
          ),
        );
      },
      dismiss: (identifier: string) => {
        self.$$.scroll.popoverController.dismissPopover(identifier);
      },
      currentId: (): Option<string> => {
        return self.$$.scroll.popoverController.currentPopover?.identifier;
      },
    },
    tooltip: {
      reveal: (
        identifier: string,
        $content: HTMLElement,
        position: Point<
          ColumnIndex.Key.Resolved.WithSubindex,
          LiveData<number>
        >,
        location: "header" | "body" | "footer",
        options: Option<ScrollTooltip.Options>,
      ) => {
        self.$$.scroll.tooltipController.revealTooltip(
          new ScrollTooltip(
            identifier,
            $content,
            { x: position.x.key.offset, y: position.y },
            position.x.subindex,
            location,
            options ?? undefined,
          ),
        );
      },
      dismiss: (identifier: string) => {
        self.$$.scroll.tooltipController.queueDismissTooltip(identifier);
      },
      currentId: (): Option<string> => {
        return self.$$.scroll.tooltipController.currentTooltip?.identifier;
      },
    },
    attachRowOptionsAnchor($anchor: HTMLElement): void {
      self.appendChild($anchor);
    },
  }))(this);

  /**
   * The layout host's own presentation.
   * @see {@link SheetPresentationPort}
   */
  readonly #presentation: SheetPresentationPort = ((self) => ({
    setBodyMarginTop(px: number): void {
      self.assignStyles({ "--body-margin-top": px + "px" });
    },
    setFooterHeight(px: number): void {
      self.assignStyles({ "--footer-height": px + "px" });
    },
    setRootHidden(hidden: boolean): void {
      self.style.opacity = hidden ? "0" : "";
    },
    setGridSize(rows: Option<number>, columns: Option<number>): void {
      if (rows == null) {
        self.removeAttribute("aria-rowcount");
      } else {
        self.setAttribute("aria-rowcount", String(rows));
      }
      if (columns == null) {
        self.removeAttribute("aria-colcount");
      } else {
        self.setAttribute("aria-colcount", String(columns));
      }
    },
  }))(this);

  /** @see {@link SheetFixedChildrenPort} */
  readonly #fixedChildren: SheetFixedChildrenPort = ((self) => ({
    reveal(
      identifier: string,
      $content: HTMLElement,
      position: Point<ColumnIndex.Key.Resolved.WithSubindex, LiveData<number>>,
      location: "header" | "body" | "footer",
      options: Option<
        Optional<{
          animate: boolean;
          inset: Optional<Inset>;
          end: ColumnIndex.Key.Resolved.WithSubindex;
          widthBehavior: "fill" | "fill-right" | "auto" | number;
        }>
      >,
    ) {
      // Dismiss existing fixed child with same ID to prevent duplicates
      if (self.$$.scroll.findFixedChild(identifier)) {
        self.$$.scroll.dismissFixedChild(identifier, false, false);
      }

      $content.id = identifier;
      const data: FixedChild.Node.Data = {
        $content,
        location,
        inset: options?.inset,
        yPosition: position.y,
        rowId: null,
        owner: null,
      };
      const animate = options?.animate ?? true;

      const node = FixedChild.Node.fromColumnIndicies(
        identifier,
        new ColumnIndex.Key.Resolved.WithSubindex.RangeOpen(
          position.x,
          options?.end,
        ),
        data,
        options?.widthBehavior ?? "auto",
      );
      self.#fixedChildLayoutManager.add(node);
      self.$$.scroll.appendFixedChild(
        node.data.$content,
        {
          ...{
            x: node.columnRange.start.key.offset,
            y: node.data.yPosition,
          },
        },
        node.data.location,
        {
          offsetPx: {
            x: node.data.inset?.left ?? 0,
            y: node.data.inset?.top ?? 0,
          },
          animate: animate,
          xPosition: () => {
            node.bindWidth(self.navigator!);
            return node.startOffsetPx(self.navigator!);
          },
        },
      );
    },
    revealDates(
      identifier: string,
      $content: HTMLElement,
      position: Point<NaiveDate, LiveData<number>>,
      location: "header" | "body" | "footer",
      options: Option<
        Optional<{
          animate: boolean;
          inset: Optional<Inset>;
          endDate: NaiveDate;
          widthBehavior: "fill" | "fill-right" | "auto" | number;
        }>
      >,
    ) {
      // Dismiss existing fixed child with same ID to prevent duplicates
      if (self.$$.scroll.findFixedChild(identifier)) {
        self.$$.scroll.dismissFixedChild(identifier, false, false);
      }

      $content.id = identifier;
      const data: FixedChild.Node.Data = {
        $content,
        location,
        inset: options?.inset,
        yPosition: position.y,
        rowId: null,
        owner: null,
      };
      const animate = options?.animate ?? true;

      // Resolve dates to column positions using current mapper
      const space = self.#requireSpace();
      const startKey = ColumnIndex.Key.fromDate(position.x, "lower");
      const startResolved = space
        .resolveKeyToDefault(startKey, "lower")
        .withSubindex(space.indexOfKey(startKey).subindex);

      let endResolved: ColumnIndex.Key.Resolved.WithSubindex | undefined;
      if (options?.endDate) {
        const endKey = ColumnIndex.Key.fromDate(options.endDate, "upper");
        endResolved = space
          .resolveKeyToDefault(endKey, "upper")
          .withSubindex(space.indexOfKey(endKey).subindex.inc());
      }

      const node = FixedChild.Node.fromColumnIndicies(
        identifier,
        new ColumnIndex.Key.Resolved.WithSubindex.RangeOpen(
          startResolved,
          endResolved,
        ),
        data,
        options?.widthBehavior ?? "auto",
      );

      // Store raw dates for re-resolution when mapper changes
      node.dateRange = {
        start: position.x,
        end: options?.endDate ?? undefined,
      };

      self.#fixedChildLayoutManager.add(node);
      self.$$.scroll.appendFixedChild(
        node.data.$content,
        {
          ...{
            x: node.columnRange.start.key.offset,
            y: node.data.yPosition,
          },
        },
        node.data.location,
        {
          offsetPx: {
            x: node.data.inset?.left ?? 0,
            y: node.data.inset?.top ?? 0,
          },
          animate: animate,
          xPosition: () => {
            return node.rebindXPosition(
              self.#requireSpace(),
              self.navigator!,
              self.$$.scroll,
            );
          },
        },
      );
    },
    revealLive(
      identifier: string,
      $content: HTMLElement,
      position: { x: LiveData<number>; y: LiveData<number> },
      location: "header" | "body" | "footer",
    ) {
      if (self.$$.scroll.findFixedChild(identifier)) {
        self.$$.scroll.dismissFixedChild(identifier, false, false);
      }
      $content.id = identifier;
      self.$$.scroll.appendLiveFixedChild($content, position, location);
    },
    dismiss(identifier: string, animate: boolean) {
      const node = self.#fixedChildLayoutManager.get(identifier);
      if (node != null) {
        self.$$.scroll.dismissFixedChildElement(node.data.$content, animate, false);
      } else {
        self.$$.scroll.dismissFixedChild(identifier, animate, false);
      }
      self.#fixedChildLayoutManager.remove(identifier);
    },
    dismissAll() {
      self.$$.scroll.removeAllFixedBodySync();
      self.#fixedChildLayoutManager.clear();
      self.#specRegistry.clearAll();
    },
    hasFixedChild(identifier: string) {
      return self.$$.scroll.findFixedChild(identifier) != null;
    },
    getFixedChild(identifier: string) {
      return self.$$.scroll.findFixedChild(identifier);
    },
    getAllFixedChildren(): HTMLElement[] {
      return self.#fixedChildLayoutManager
        .findAll()
        .map((node) => node.data.$content);
    },
    updateFixedChildInset(
      identifier: string,
      newInset: Optional<Inset>,
      resolvedYPx: number,
    ): boolean {
      const node = self.#fixedChildLayoutManager.updateInset(
        identifier,
        newInset,
      );
      if (!node) return false;

      const $content = node.data.$content;
      const insetTop = newInset?.top ?? 0;

      // Update attribute (for rebindFixedChildYPositions compatibility)
      $content.setAttribute("data-inset-top", String(insetTop));

      // Update CSS variable directly (bypasses stale listener). `resolvedYPx`
      // is the scroll-relative row top the caller already resolved (via
      // Sheet.Layout.bodyFixedChildTop) — the same value reveal() positions
      // against — so the inset update agrees with the initial reveal to the
      // pixel instead of re-deriving a stale hardcoded offset.
      $content.style.setProperty(
        "--additional-y",
        resolvedYPx + insetTop + "px",
      );

      return true;
    },
    /**
     * Reposition an existing fixed child to a new column and X offset.
     * Cheap position update without full dismiss/re-reveal.
     */
    repositionFixedChild(
      identifier: string,
      column: ColumnIndex.Key.Resolved.WithSubindex,
      insetLeftPx: number,
    ): boolean {
      const node = self.#fixedChildLayoutManager.get(identifier);
      if (!node) return false;

      const newIndex = column.key.offset;
      const oldIndex = node.columnRange.start.key.offset;

      // Update column range on the node
      node.columnRange = new ColumnIndex.Key.Resolved.WithSubindex.RangeOpen(
        column,
        undefined,
      );
      node.range = { start: newIndex, end: newIndex + 1 };

      // If column index changed, update scroll position
      if (newIndex !== oldIndex) {
        const newOffset = self.$$.scroll.updateFixedChildIndex(
          node.data.$content,
          newIndex,
        );
        if (newOffset != null) {
          node.data.$content.style.setProperty("--x", newOffset + "px");
        }
      }

      const subindexOffset = self.navigator
        ? node.startOffsetPx(self.navigator) ?? 0
        : 0;

      // Match reveal(): callers pass the inset within the resolved column;
      // this layer owns adding the resolved subindex offset.
      node.data.$content.style.setProperty(
        "--additional-x",
        subindexOffset + insetLeftPx + "px",
      );

      return true;
    },
    updateFixedChildWidth(identifier: string, widthPx: number): boolean {
      const node = self.#fixedChildLayoutManager.get(identifier);
      if (!node) return false;
      node.widthBehavior = widthPx;
      if (self.navigator) {
        node.bindWidth(self.navigator);
      }
      return true;
    },
    /**
     * Declarative API for managing fixed children for a row.
     * Diffs current vs desired state and only updates what changed.
     */
    setFixedChildrenForRow(
      rowId: RowIdentity,
      children: Array<{
        id: string;
        x: FixedChildXPosition;
        inset: Optional<Inset>;
        widthBehavior: "fill" | "fill-right" | "auto" | number;
        makeElement: () => HTMLElement;
        onUpdate?: ($element: HTMLElement) => void;
      }>,
      options: {
        owner: string;
      },
      rowOffsetPx: number,
      location: "header" | "body" | "footer",
    ): void {
      const currentIds = self.#fixedChildLayoutManager.getIdsForRowOwner(
        rowId,
        options.owner,
      );
      const desiredIds = new Set(children.map((c) => c.id));

      // 1. Dismiss removed children
      for (const id of currentIds) {
        if (!desiredIds.has(id)) {
          this.dismiss(id, false);
        }
      }

      // 2. Add or update children
      for (const spec of children) {
        let existingNode = self.#fixedChildLayoutManager.get(spec.id);

        if (
          existingNode &&
          (existingNode.data.rowId?.toString() !== rowId.toString() ||
            existingNode.data.owner !== options.owner)
        ) {
          this.dismiss(spec.id, false);
          existingNode = null;
        }

        if (existingNode) {
          // Update existing: just update inset position
          const newInset = spec.inset;
          const insetTop = newInset?.top ?? 0;
          existingNode.data.inset = newInset;
          existingNode.widthBehavior = spec.widthBehavior;

          // Update byRowOwner secondary index if rowId or owner changed
          const oldRowId = existingNode.data.rowId;
          const oldOwner = existingNode.data.owner;
          if (oldRowId !== rowId || oldOwner !== options.owner) {
            self.#fixedChildLayoutManager.updateRowOwner(
              spec.id,
              oldRowId,
              oldOwner,
              rowId,
              options.owner,
            );
          }
          existingNode.data.rowId = rowId;
          existingNode.data.owner = options.owner;
          setAttributeIfChanged(
            existingNode.data.$content,
            "data-inset-top",
            String(insetTop),
          );
          setAttributeIfChanged(
            existingNode.data.$content,
            "data-fixed-owner",
            options.owner,
          );

          const yPx = rowOffsetPx + (location === "body" ? 10 : 0);
          setPropertyIfChanged(
            existingNode.data.$content,
            "--additional-y",
            yPx + insetTop + "px",
          );

          if (self.navigator) {
            existingNode.bindWidth(self.navigator);
          }

          let xChanged = false;
          if (spec.x.type === "date-range") {
            xChanged =
              existingNode.dateRange?.start?.dse !== spec.x.startDate.dse ||
              existingNode.dateRange?.end?.dse !== spec.x.endDate.dse;
            if (xChanged) {
              existingNode.dateRange = {
                start: spec.x.startDate,
                end: spec.x.endDate,
              };
            }
          } else {
            const currentStart = existingNode.columnRange.start;
            const currentEnd = existingNode.columnRange.end;
            const nextStart = spec.x.start;
            const nextEnd = spec.x.end;
            xChanged =
              existingNode.dateRange != null ||
              currentStart.key.offset !== nextStart.key.offset ||
              currentStart.subindex.toString() !==
                nextStart.subindex.toString() ||
              currentEnd?.key.offset !== nextEnd?.key.offset ||
              currentEnd?.subindex.toString() !== nextEnd?.subindex.toString();

            if (xChanged) {
              existingNode.dateRange = undefined;
              existingNode.columnRange =
                new ColumnIndex.Key.Resolved.WithSubindex.RangeOpen(
                  spec.x.start,
                  spec.x.end,
                );
              existingNode.range = {
                start: spec.x.start.key.offset,
                end: (spec.x.end?.key.offset ?? spec.x.start.key.offset) + 1,
              };
            }
          }

          if (self.navigator) {
            const subindexOffset =
              xChanged || existingNode.dateRange
                ? existingNode.rebindXPosition(
                    self.#requireSpace(),
                    self.navigator,
                    self.$$.scroll,
                  )
                : existingNode.startOffsetPx(self.navigator);

            if (subindexOffset != null) {
              const xOff = newInset?.left ?? 0;
              setPropertyIfChanged(
                existingNode.data.$content,
                "--additional-x",
                subindexOffset + xOff + "px",
              );
            }
          }

          // Call update callback if provided
          spec.onUpdate?.(existingNode.data.$content);
        } else {
          // Create new element
          const $element = spec.makeElement();
          // Set attributes BEFORE reveal so the row-owner index is populated
          // and rebindFixedChildYPositions works correctly
          $element.setAttribute("row-id", rowId.toString());
          $element.setAttribute("data-fixed-owner", options.owner);
          const insetTop = spec.inset?.top ?? 0;
          $element.setAttribute("data-inset-top", String(insetTop));

          if (spec.x.type === "date-range") {
            this.revealDates(
              spec.id,
              $element,
              {
                x: spec.x.startDate,
                y: new LiveData(rowOffsetPx + (location === "body" ? 10 : 0)),
              },
              location,
              {
                animate: false,
                inset: spec.inset,
                endDate: spec.x.endDate,
                widthBehavior: spec.widthBehavior,
              },
            );
          } else {
            this.reveal(
              spec.id,
              $element,
              {
                x: spec.x.start,
                y: new LiveData(rowOffsetPx + (location === "body" ? 10 : 0)),
              },
              location,
              {
                animate: false,
                inset: spec.inset,
                end: spec.x.end,
                widthBehavior: spec.widthBehavior,
              },
            );
          }
        }
      }
    },
    clearFixedChildrenByOwner(owner: string): void {
      // Clear spec registry entries for this owner
      for (const key of [...self.#specRegistry.keys()]) {
        if (key.endsWith(`::${owner}`)) {
          const [rowIdStr] = key.split("::");
          self.#specRegistry.clear(rowIdentity(rowIdStr), owner);
        }
      }
      const ids = self.#fixedChildLayoutManager.getIdsForOwner(owner);
      for (const id of ids) {
        this.dismiss(id, false);
      }
    },
    registerSpecs(
      rowId: RowIdentity,
      owner: string,
      specs: FixedChildSpec[],
    ): void {
      self.#specRegistry.register(rowId, owner, specs);
    },
    reconcileSpecs(
      rowId: RowIdentity,
      owner: string,
      visibleRange: NumRangeLike,
    ): FixedChildSpec[] {
      if (!self.#viewportCuller) return self.#specRegistry.get(rowId, owner);
      return self.#viewportCuller.reconcile(rowId, owner, visibleRange);
    },
    clearSpecs(rowId: RowIdentity, owner: string): void {
      self.#specRegistry.clear(rowId, owner);
    },
    suppressSpec(specId: string): void {
      self.#specRegistry.suppress(specId);
    },
    specRegistryKeys(): IterableIterator<string> {
      return self.#specRegistry.keys();
    },
    findByRowAndOffset(
      rowId: RowIdentity,
      offset: number,
    ): Option<HTMLElement> {
      const nodes = self.#fixedChildLayoutManager.findInRange({
        start: offset,
        end: offset + 1,
      });
      const node = nodes.find((n) => n.data.rowId === rowId);
      return node?.data.$content ?? null;
    },
  }))(this);

  /** @see {@link SheetStaticChildrenPort} */
  readonly #staticChildren: SheetStaticChildrenPort = ((self) => ({
    reveal(
      id: string,
      $e: HTMLElement,
      rowId: RowIdentity,
      location: "header" | "body" | "footer",
      fillWidth: boolean,
    ) {
      const staticId = `${id}-${rowId}`;
      $e.setAttribute("data-row-id", rowId.toString());
      self.$$.scroll.staticChildrenHandle.reveal(
        staticId,
        $e,
        location,
        fillWidth,
      );
    },
    get(
      id: string,
      rowId: RowIdentity,
      location: "header" | "body" | "footer",
    ): Option<HTMLElement> {
      const staticId = `${id}-${rowId}`;
      return self.$$.scroll.staticChildrenHandle.get(location, staticId);
    },
    dismiss(
      id: string,
      rowId: RowIdentity,
      location: "header" | "body" | "footer",
    ) {
      const staticId = `${id}-${rowId}`;
      return self.$$.scroll.staticChildrenHandle.dismiss(location, staticId);
    },
    getAll(): HTMLElement[] {
      return self.$$.scroll.staticChildrenHandle.getAll();
    },
    dismissAll(): HTMLElement[] {
      return self.$$.scroll.staticChildrenHandle.dismissAll();
    },
  }))(this);

  /**
   * The two kinds of child, told apart by what anchors them.
   * @see {@link SheetChildrenPort}
   */
  readonly #children: SheetChildrenPort = ((self) => ({
    get fixed(): SheetFixedChildrenPort {
      return self.#fixedChildren;
    },
    get static(): SheetStaticChildrenPort {
      return self.#staticChildren;
    },
  }))(this);

  static $styles = [
    Button.$style,
    Divider.$vr,
    css`
      #scroll {
        overflow: visible;
        --header-bg: var(--list-header-background-color, var(--bg-elevated));
      }

      [use-body-margin] {
        margin-top: var(--body-margin-top, 0px);
      }
    `,
  ];

  static $html = html`
    <std-scroll-horizontal id="scroll" style="--padding-bottom:40px;">
      <slot slot="header-sidebar" name="header-legend"></slot>
      <slot slot="sidebar" name="legend"></slot>
      <slot slot="footer-sidebar" name="footer-legend"></slot>
      <slot slot="sidebar-sticky" name="sidebar-sticky"></slot>
    </std-scroll-horizontal>
  `;
}

export namespace SheetLayout {
  /**
   * Where {@link SheetLayoutPort.bindContent}'s index bind leaves the window.
   *
   * `at(index)` re-anchors to `index` in the INCOMING mapper's space — a sheet
   * switch (index 0 of the sheet being opened), or a caller that captured the
   * index under the mapper still in force and knows it has not changed since
   * (the sidebar-drag index lock). `keep()` leaves the window where the layout
   * rebind put it, which is the only correct answer once a rebind may have
   * crossed index spaces: an index captured before a view-config flip names a
   * different date after it.
   *
   * As with {@link ScrollEngine.IndexSpace}, there is no nullable form and
   * no default. The previous shape — `index: Option<number>`, null silently
   * meaning "anchor at 0" — read the same whether the caller wanted the origin
   * or had simply not decided, and a view-config flip took that branch for the
   * second reason: it discarded the user's position on every flip.
   */
  export type IndexAnchor =
    | { readonly kind: "at"; readonly index: number }
    | { readonly kind: "keep" };

  export namespace IndexAnchor {
    const KEEP: IndexAnchor = { kind: "keep" };

    /** Re-anchor to this index, expressed in the incoming mapper's space. */
    export function at(index: number): IndexAnchor {
      return { kind: "at", index };
    }

    /** Leave the window where the layout rebind put it. */
    export function keep(): IndexAnchor {
      return KEEP;
    }
  }

  /**
   * What the layer calls back into its host with.
   *
   * Every field is REQUIRED. Six of them used to be doubly optional —
   * `onScroll?: Option<…>`, three levels of absent for `cellWidthForIndex` —
   * and there has only ever been one construction site (`Sheet.init`), so
   * nothing was paying for that optionality: it bought a shape where "the host
   * did not wire this" and "the host wired null" and "the host wired undefined"
   * were three states no reader could tell apart and no caller ever produced.
   *
   * {@link onRenderedColumnsChanged} keeps `Option` because it is the one
   * genuinely absent at runtime — the sheet registers no listener for it, and
   * the layer's `?.` short-circuit means a no-op would COST something (see
   * `initialize`), not merely read differently.
   */
  export type Delegate = {
    /** Mint one column's three band elements. */
    createColumn: () => HTMLElement;
    /** Return one band element to the host's pool. */
    recycleColumn: (column: HTMLElement) => void;
    /** Decorative preview while this column's content bind is still queued. */
    onPlace: Option<(
      index: number,
      item: { $header: HTMLElement; $body: HTMLElement; $footer: Option<HTMLElement> },
      widthPx: Option<number>,
    ) => void>;
    /** Paint one column at `index`, at `widthPx`. */
    onBind: (
      index: number,
      item: {
        $header: HTMLElement;
        $body: HTMLElement;
        $footer: Option<HTMLElement>;
      },
      widthPx: number,
      resizeOnly: boolean,
      isOffscreen: boolean,
    ) => void;
    /** Position-only notification at the same synchronous scroll boundary. */
    onScrollPosition?: Option<(position: { left: number; top: number }) => void>;
    /** The content viewport scrolled; null when only position is consumed. */
    onScroll: Option<(config: {
      left: number;
      top: number;
      scrollHeight: number;
    }) => void>;
    /** The VISIBLE strip changed, resolved through the installed mapper. */
    onViewportColumnsChanged: (
      columns: ColumnIndex.Key.Resolved.Default.Range,
      viewportChangeSource: ScrollEngine.ViewportChangeSource,
    ) => void;
    /** The RENDERED strip is about to change — the prefetch hook. */
    onRenderedColumnsWillChange: (
      columns: ColumnIndex.Key.Resolved.Default.Range,
    ) => void;
    /** The RENDERED strip changed. Null: no host listens. */
    onRenderedColumnsChanged: Option<
      (columns: ColumnIndex.Key.Resolved.Default.Range) => void
    >;
    /** Per-index width override; null falls back to the uniform cell width. */
    cellWidthForIndex: (index: number) => Option<number>;
  };

  export type Width = SheetLayoutWidth;
  export const Width = SheetLayoutWidth;

  export function resolveCellWidth(
    visibleWidth: number,
    semantic: SheetLayoutWidth,
    constraints: SheetLayoutWidth.Constraints,
  ): Option<{
    semantic: SheetLayoutWidth;
    real: number;
  }> {
    return SheetLayoutWidth.resolveCellWidth(
      visibleWidth,
      semantic,
      constraints,
    );
  }
}
