import "./table-header";
import "./table-body";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { TableHeader } from "./table-header";
import { TableBody } from "./table-body";
import { Round } from "../round";
import { LiveData } from "@tento-core/livedata";
import { Point } from "@tento-core/point";
import { Tracing } from "@tento-core/tracing";
import { SizeGate } from "../../ui/size-gate";
import { Scrollbars } from "../scrollbars";
import { ScrollShadows } from "../../ui/scroll-shadows";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { LonaIcons } from "../../ui/icons";
import { TableUtils } from "./table-utils";

const MIN_COLUMN_WIDTH = 20;

@component({
  name: "std-table",
})
export class Table<Item extends Identifiable<{}>> extends LonaWebComponent {
  // @components
  private $root = this.$("root");
  private $viewport = this.$("viewport");
  private $headerViewport = this.$("header-viewport");
  private $header: TableHeader<Item> = this.hydrate("header");

  /** Returns the scrollable viewport element for external scroll observation */
  get scrollContainer(): HTMLElement {
    return this.$viewport;
  }

  /** Commit mounted table geometry before a caller measures its FLIP target. */
  layoutNow(): void {
    this.$header.layoutNow();
  }

  /** Hold column geometry while a consumer crossfades complete table layouts. */
  setLayoutSuspended(suspended: boolean): void {
    this.$header.setLayoutSuspended(suspended);
  }

  /** Mounted row contents and group separators, for coordinated layout animation. */
  get $layoutElements(): readonly HTMLElement[] {
    return [
      ...this.bodies.flatMap(($body) => $body.$layoutElements),
      ...this.$bodiesContainer.querySelectorAll<HTMLElement>(
        ".group-divider, .group-header-container",
      ),
    ];
  }
  private $bodiesContainer: HTMLElement = this.$("bodies-container");
  private bodies: TableBody<Item>[] = [];
  private groupHeaderContainers: HTMLElement[] = [];
  private $bg: Round = this.hydrate<Round>("bg");

  // @props
  tvm: Option<Table.ViewModel<Item>>;
  private currentItems: Item[] = [];
  private itemsGeneration = 0;
  private currentItemRevision: Option<(item: Item) => string>;
  private expandedIds: Set<Item["id"]> = new Set();
  private selectedId: Option<Item["id"]>;

  // @state
  private sizePromise: Option<Promise<void>>;
  private sizeGate = new SizeGate();
  private isLayouting = false;

  onSizeChange: Option<(s: Size) => void> = (s) => {
    const width = s.width || this.offsetWidth;
    const height = s.height || this.offsetHeight;
    if (this.isLayouting) return;
    this.sizeGate.resolve({ width, height });
    // Inline columns use flex layout; resizing does not change their rules.
    // Re-measuring them while the sidebar animates repeats the same writes.
    if (this.tvm?.style.layout === "inline") return;
    this.$header.queueLayout();
  };

  private viewportObserver = new ResizeObserver(() => this.updateGroupHeaderWidths());

  private handleScroll = () => {
    // Only the rows are a scrollport. Translate the clipped heading for column
    // alignment without issuing a second programmatic scroll during a gesture.
    const left = Math.max(0, this.$viewport.scrollLeft);
    const translate = `${-left}px`;
    if (this.$header.style.translate !== translate) this.$header.style.translate = translate;
    ScrollShadows.updateHorizontalScrollShadows(this, this.$viewport);
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.$viewport.addEventListener("scroll", this.handleScroll);
    this.viewportObserver.observe(this.$viewport);
    this.openSizeGateWithoutAFrame();
    this.subscribeModel();
  }

  /**
   * Open `sizeGate` from a direct layout read when no frame is coming.
   *
   * `bindItemsAsync` awaits the gate, and only `onSizeChange` — a
   * ResizeObserver delivery — opens it. An observer delivers on a RENDERING
   * OPPORTUNITY, and a hidden document has none: a table built in a background
   * tab or in an iframe the shell has not shown yet paints its column header
   * over an empty body and stays that way for as long as the document stays
   * hidden. Nothing reports it, because every other part of such a page — the
   * rail, the counts, the empty states — is built synchronously and is
   * correct; only the rows are missing, which reads as "there is no data".
   *
   * Layout is still answerable without a frame, so read it and open the gate
   * here instead. Two guards keep this off the path that already works:
   *
   * - **Visible documents return immediately.** They WILL get a rendering
   *   opportunity, and the observer's first delivery costs nothing, where this
   *   read would force a synchronous layout on every table in the fleet.
   * - **A zero width is not seeded.** That is a table with no box yet —
   *   detached, or inside a page a flow has not revealed — where waiting is
   *   the right answer and a zero would latch the gate at the wrong size. The
   *   one retry covers the common case of the reveal landing later in the same
   *   task; a timer, because rAF is exactly what is unavailable here.
   */
  private openSizeGateWithoutAFrame(): void {
    if (document.visibilityState !== "hidden") return;
    const seed = () => {
      if (!this.isConnected || this.sizeGate.currentSize != null) return;
      const { width, height } = this.getBoundingClientRect();
      if (width > 0) this.sizeGate.resolve({ width, height });
    };
    seed();
    if (this.sizeGate.currentSize == null) setTimeout(seed);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.setLayoutSuspended(false);
    this.$viewport.removeEventListener("scroll", this.handleScroll);
    this.viewportObserver.disconnect();
    this.tvm?.sortState.removeListener(this);
    this.tvm?.layoutInvalidated.removeListener(this);
  }

  onRecycle(): void {
    this.itemsGeneration++;
    this.unsubscribeModel();
    this.tvm = null;
    this.currentItems = [];
    this.currentItemRevision = null;
    this.selectedId = null;
    super.onRecycle();
    this.setLayoutSuspended(false);
  }

  private unsubscribeModel(): void {
    this.tvm?.sortState.removeListener(this);
    this.tvm?.layoutInvalidated.removeListener(this);
  }

  private subscribeModel(): void {
    const tvm = this.tvm;
    if (tvm == null) return;
    tvm.sortState.addListener(this, () => {
      if (this.tvm !== tvm || this.currentItems.length <= 0) return;
      void this.bindItemsAsync(this.currentItems, this.currentItemRevision);
    });
    tvm.layoutInvalidated.addListener(this, () => {
      if (this.tvm !== tvm) return;
      this.style.setProperty("--padding-inline", `${tvm.style.containerMarginInline}px`);
      this.bindCardStyle(tvm.style.card);
      this.bindLayoutStyle(tvm.style.layout);
      this.bindBackground(tvm.style.card, tvm.style.layout, true);
    });
  }

  bind(tvm: Table.ViewModel<Item>): this {
    // Remove listeners from previous tvm before binding new one
    this.tvm?.sortState.removeListener(this);
    this.tvm?.layoutInvalidated.removeListener(this);

    this.itemsGeneration++;
    this.tvm = tvm;

    this.subscribeModel();

    this.sizePromise = this.$header.bind(this.tvm, this.sizeGate, {
      onLayoutStart: () => {
        this.isLayouting = true;
      },
      onLayoutEnd: () => {
        this.isLayouting = false;
        this.updateGroupHeaderWidths();
        this.handleScroll();
        this.bindDebugAttributes();
      },
    });

    this.assignStyles({
      "--padding-inline": tvm.style.containerMarginInline + "px",
    });
    this.bindCardStyle(tvm.style.card);
    this.bindLayoutStyle(tvm.style.layout);
    this.bindBackground(tvm.style.card, tvm.style.layout, false);
    return this;
  }

  bindSelectedItem(id: Option<Item["id"]>): this {
    this.selectedId = id;
    for (const body of this.bodies) {
      body.updateSelectedItem(id);
    }
    return this;
  }

  /** Programmatically set which rows are expanded (by item id). */
  bindExpandedItems(ids: Iterable<Item["id"]>): this {
    this.expandedIds.clear();
    for (const id of ids) this.expandedIds.add(id);
    for (const body of this.bodies) {
      body.updateExpandedItems(this.expandedIds);
    }
    return this;
  }

  /** Toggle one row's inline detail (durable across rebuilds). No-op unless the
   *  spec provides `renderDetail`. */
  toggleExpanded(id: Item["id"]): void {
    if (this.expandedIds.has(id)) this.expandedIds.delete(id);
    else this.expandedIds.add(id);
    for (const body of this.bodies) {
      body.updateExpandedItems(this.expandedIds);
    }
  }

  /** Promise that resolves when items have finished rendering */
  itemsReadyPromise: Option<Promise<void>>;

  bindItems(items: Item[]): this {
    this.currentItemRevision = null;
    this.itemsReadyPromise = this.bindItemsAsync(items, null);
    return this;
  }

  /** Reconcile an ungrouped table by item id. Rows whose revision is
   * unchanged retain their DOM and component state; this is opt-in so legacy
   * tables keep their existing full-bind behavior. */
  bindItemsKeyed(
    items: Item[],
    revision: (item: Item) => string,
  ): this {
    this.currentItemRevision = revision;
    this.itemsReadyPromise = this.bindItemsAsync(items, revision);
    return this;
  }

  findRowById(id: Item["id"]): Option<TableBody.Row<Item>> {
    for (const body of this.bodies) {
      const row = body.findRowById(id);
      if (row) return row;
    }
    return undefined;
  }

  updateRowDetail(id: Item["id"]): this {
    for (const body of this.bodies) {
      if (body.updateRowDetail(id)) break;
    }
    return this;
  }

  private async bindItemsAsync(
    items: Item[],
    itemRevision: Option<(item: Item) => string>,
  ) {
    const generation = ++this.itemsGeneration;
    const model = this.tvm;
    this.currentItems = items;
    await this.sizePromise!;
    if (generation !== this.itemsGeneration || this.tvm !== model) return;

    // Defer DOM insertions to the next fastdom mutate pass.
    // This function resumes as a microtask immediately after flush() returns,
    // still within the same RunTask. Inserting rows there triggers a full
    // subtree restyle (6108 elements, 20ms) + layout (3854 dirty, 8ms) before
    // Paint. Scheduling via $$.mutate pushes the work to the next rAF's write
    // phase, keeping those costs out of the current frame.
    await new Promise<void>((resolve) =>
      $$.mutate(() => {
        if (
          generation === this.itemsGeneration && this.tvm === model &&
          this.currentItems === items &&
          this.currentItemRevision === itemRevision
        ) {
          const groups = this.tvm!.groups;
          const canReconcile = itemRevision != null &&
            (!groups || groups.length === 0) &&
            this.tvm!.delegate.onReorder == null;
          if (canReconcile) {
            const sortedItems = this.applySorting(items);
            this.bindItemsSingleBodyKeyed(
              sortedItems,
              true,
              this.selectedId,
              itemRevision,
            );
          } else {
            DomUtils.clearChildren(this.$bodiesContainer);
            this.bodies = [];
            this.groupHeaderContainers = [];
          }

          if (!canReconcile && groups && groups.length > 0) {
            this.bindItemsGroupedBodies(items, groups);
          } else if (!canReconcile) {
            const sortedItems = this.applySorting(items);
            // Honor the view model: hardcoding `true` here silently overrode
            // Style.showRowDividers for every ungrouped table (the explicit
            // argument outranks the style in TableBody.bind). Consumers that
            // never set the style keep dividers — its default is true.
            this.bindItemsSingleBody(
              sortedItems,
              this.tvm!.style.showRowDividers,
              this.selectedId,
            );
          }
        }
        resolve();
      })
    );
  }

  private bindItemsGroupedBodies(
    items: Item[],
    groups: Table.Group<Item>[],
  ): void {
    const groupsWithItems: {
      group: Table.Group<Item>;
      items: Item[];
    }[] = groups
      .map((group) => ({
        group,
        items: items.filter(group.filter),
      }))
      .filter(({ items }) => items.length > 0);

    for (let i = 0; i < groupsWithItems.length; i++) {
      const { group, items: groupItems } = groupsWithItems[i];

      const $groupHeader = group.makeHeader?.();
      if ($groupHeader) {
        const $container = document.createElement("div");
        $container.classList.add("group-header-container");
        $groupHeader.style.width = "100%";
        $container.appendChild($groupHeader);
        this.$bodiesContainer.appendChild($container);
        this.groupHeaderContainers.push($container);
        this.updateGroupHeaderWidths();
      }

      const sortedItems = this.applySorting(groupItems);
      const showRowDividers = group.showRowDividers ?? false;
      this.bindItemsSingleBody(sortedItems, showRowDividers, this.selectedId);

      const isLastGroup = i === groupsWithItems.length - 1;
      if (isLastGroup) continue;
      this.createAndAppendDivider();
    }
  }

  private bindItemsSingleBody(
    items: Item[],
    showRowDividers: boolean,
    selectedId: Option<Item["id"]>,
  ): void {
    if (!this.tvm) return;
    const $body = TableBody.make() as unknown as TableBody<Item>;
    $body.bind(this.tvm, items, showRowDividers, selectedId, this.expandedIds);
    this.$bodiesContainer.appendChild($body);
    this.bodies.push($body);
  }

  private bindItemsSingleBodyKeyed(
    items: Item[],
    showRowDividers: boolean,
    selectedId: Option<Item["id"]>,
    revision: (item: Item) => string,
  ): void {
    if (!this.tvm) return;
    let $body = this.bodies.length === 1 ? this.bodies[0] : undefined;
    if (!$body) {
      DomUtils.clearChildren(this.$bodiesContainer);
      this.bodies = [];
      this.groupHeaderContainers = [];
      $body = TableBody.make() as unknown as TableBody<Item>;
      this.$bodiesContainer.appendChild($body);
      this.bodies.push($body);
    }
    $body.bindKeyed(
      this.tvm,
      items,
      revision,
      showRowDividers,
      selectedId,
      this.expandedIds,
    );
  }

  private createAndAppendDivider(): void {
    const $divider = document.createElement("div");
    $divider.classList.add("group-divider");
    this.$bodiesContainer.appendChild($divider);
  }

  private updateGroupHeaderWidths(): void {
    if (!this.tvm) return;
    const scrollbarWidth = this.$viewport.offsetWidth -
      this.$viewport.clientWidth;
    // Give the heading strip the body's classic scrollbar gutter, so both
    // horizontal ranges still match when the platform reserves scrollbar space.
    const cardInset = this.tvm.style.card === "card" ? 8 : 0;
    this.$headerViewport.style.paddingInlineEnd = `${cardInset + scrollbarWidth}px`;
    const width = this.tvm.viewportWidth +
      this.tvm.style.containerMarginInline * 2;
    for (const $container of this.groupHeaderContainers) {
      $container.style.width = `${width}px`;
      $container.style.paddingInlineEnd = `${scrollbarWidth}px`;
    }
  }

  private applySorting(items: Item[]): Item[] {
    if (!this.tvm) return items;

    // Skip client-side sorting when server-side sorting is enabled
    if (this.tvm.serverSideSorting) return items;

    const sortState = this.tvm.getSortState();
    if (!sortState) return items;

    const spec = this.tvm.getSpec(sortState.columnId);
    if (!spec?.sortComparator) {
      // TODO: sort by position
      return items;
    }

    const sorted = [...items];
    sorted.sort((a, b) => {
      const result = spec.sortComparator!(a, b);
      return sortState.direction === "asc" ? result : -result;
    });

    return sorted;
  }

  private bindCardStyle(style: Table.CardStyle) {
    switch (style) {
      case "default": {
        this.style.removeProperty("--table-card-inset");
        this.$root.style.paddingBlockEnd = "";
        this.$viewport.style.paddingInline = "";
        this.$headerViewport.style.paddingInline = "";
        break;
      }
      case "card": {
        this.style.setProperty("--table-card-inset", "8px");
        this.$root.style.paddingBlockEnd = "8px";
        this.$viewport.style.paddingInline = "8px";
        this.$headerViewport.style.paddingInline = "8px";
        break;
      }
    }
  }

  private bindLayoutStyle(layoutStyle: Table.LayoutStyle): this {
    // Let the browser own input, momentum and edge elasticity. Inline histories
    // continue through the page; full tables keep boundary gestures local.
    this.$viewport.style.overscrollBehaviorY = layoutStyle === "inline" ? "auto" : "contain";
    if (layoutStyle === "inline") {
      this.style.setProperty("--table-header-space", "0px");
      this.$header.style.display = "none";
    } else {
      this.style.removeProperty("--table-header-space");
      this.$header.style.display = "";
    }
    ScrollShadows.updateHorizontalScrollShadows(this, this.$viewport);
    return this;
  }

  private bindBackground(
    cardStyle: Table.CardStyle,
    layoutStyle: Table.LayoutStyle,
    animate: boolean,
  ) {
    // Header geometry belongs to the table layout, not a second animation.
    // Round's host transition is independent of its inner squircle switch.
    this.$bg.setAnimates(animate && cardStyle === "card");
    this.$bg.style.transition = cardStyle === "default" ? "none" : "";

    const isHidden = cardStyle === "default" && layoutStyle === "inline";
    if (isHidden) {
      this.$bg.style.opacity = "0";
      return;
    }
    this.$bg.style.opacity = "1";

    if (cardStyle === "card") {
      this.$bg.style.height = "100%";
      this.$bg.style.zIndex = "0";
      this.$bg.bind({
        ...Round.Props.FLAT_CARD,
        transformTopLeft: true,
        bg: "var(--yellow-dimmed)",
        shadow: "0 1px 2px rgba(0,0,0,0.4)",
      });
    } else {
      this.$bg.style.height = "";
      this.$bg.style.zIndex = "";
      this.$bg.bind({
        ...TableHeader.SURFACE_PROPS,
        transformTopLeft: true,
        bg: "var(--bg-surface-light-opaque)",
      });
    }
  }

  private bindDebugAttributes(): void {
    // this.setAttribute(
    //   "debug-viewport-width",
    //   String(this.tvm?.viewportWidth ?? 0),
    // );
    // this.setAttribute(
    //   "debug-available-width",
    //   String(this.tvm?.availableWidth ?? 0),
    // );
    // // Show total column widths for debugging
    // let totalColWidth = 0;
    // for (const [, w] of this.tvm?.calculatedWidths ?? []) {
    //   totalColWidth += w;
    // }
    // this.setAttribute("debug-total-col-width", String(totalColWidth));
    // this.setAttribute(
    //   "debug-resize-requests",
    //   String(this.tvm?.resizeRequests.size ?? 0),
    // );
  }

  static makeTyped<T extends Identifiable<{}>>(): Table<T> {
    return Table.make() as unknown as Table<T>;
  }

  static $styles = [
    Scrollbars.$hideScrollbars,
    ScrollShadows.$horizontalStyles,
    css`
      :host {
        position: relative;
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        /* Reserve the measured heading before laying out the row scroller.
           The 36px fallback also reserves space on the first paint. */
        padding-block-start: calc(
          var(--table-header-space, max(36px, var(--table-header-height, 36px))) +
          var(--table-card-inset, 0px)
        );
      }

      #root {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        border-radius: 8px;
        overflow: clip;
      }

      #scroll-shadows-container {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        overflow: hidden;
        pointer-events: none;
      }

      #bg {
        display: block;
        /* The chip behind the header tracks the band instead of repeating a
           literal in a second shadow tree. std-table-header measures the band
           and writes the property onto THIS host, which is the one element
           both trees inherit from; the floor is the same one the band keeps,
           so a header with nothing to write in it is unchanged. */
        height: max(36px, var(--table-header-height, 36px));
        opacity: 0;
        z-index: 1;
      }

      #header-viewport {
        min-width: 0;
        overflow: clip;
        position: absolute;
        inset-inline: 0;
        top: var(--table-card-inset, 0px);
        height: var(--table-header-space, max(36px, var(--table-header-height, 36px)));
        z-index: 2;
      }

      #header {
        flex-shrink: 0;
        position: relative;
      }

      #viewport {
        flex: 1;
        overflow: auto;
        min-height: 0;
        padding: var(--table-padding);
      }

      #bodies-container {
        padding-top: 4px;
        position: relative;
      }

      .group-divider {
        height: 1px;
        background-color: var(--divider);
        margin-block: 8px;
        margin-inline: 8px;
      }

      .group-header-container {
        box-sizing: border-box;
      }

      #scroll-shadows-container .scroll-shadow-left,
      #scroll-shadows-container .scroll-shadow-right {
        top: 20px;
        bottom: 20px;
      }

      ::slotted([slot="footer"]) {
        flex-shrink: 0;
      }
    `,
  ];
  static $html = html`
    <std-round id="bg" floating></std-round>
    <std-col id="header-viewport">
      <std-table-header id="header"></std-table-header>
    </std-col>
    <std-col id="root">
      <div id="scroll-shadows-container">
        <div class="scroll-shadow-left"></div>
        <div class="scroll-shadow-right"></div>
      </div>
      <std-col id="viewport">
        <std-col id="bodies-container"></std-col>
      </std-col>
      <slot name="footer"></slot>
    </std-col>
  `;
}

export namespace Table {
  export type CardStyle = "default" | "card";
  export type LayoutStyle = "default" | "inline";

  export interface Props<Item extends Identifiable<{}>> {
    spec: Spec<Item>;
    style?: CardStyle;
    layoutStyle?: LayoutStyle;
    minViewportWidth?: number;
  }

  export namespace WidthSpec {
    export interface Resolved {
      columnId: string;
    }
  }

  export interface ResizeRequest {
    columnId: string;
    delta: number;
    targetWidth: number;
    source: "user" | "auto";
  }

  export namespace Column {
    export interface Spec<
      Item extends Identifiable<{}>,
      TElement extends HTMLElement = HTMLElement,
    > {
      id: string;
      label: string;
      /** A second line under `label`, in the tertiary tone. For a fact ABOUT
       *  the column rather than a name for it — which build an environment is
       *  serving, which currency a total is in. Absent ⇒ a one-line header,
       *  which is what every column drew before this existed.
       *
       *  Nothing else has to be set: the band measures the tallest heading and
       *  surrounds it with its block padding, so a column that gains a second
       *  line grows the band and one that loses it shrinks it back. */
      sublabel?: Option<string>;
      /** The whole sentence, on hover. A `sublabel` is clamped to the column's
       *  width and a `label` often is too; this is where the facts neither can
       *  hold go. */
      tooltip?: Option<string>;

      width?: number;
      minWidth?: number;

      flexGrow?: number;
      primary?: boolean;
      showLabel?: boolean;
      alignSelf?: string;

      sortComparator?: (a: Item, b: Item) => number;
      make: () => TElement;
      bind: (element: TElement, item: Item, $row: TableBody.Row<Item>) => void;
      layout?: (element: TElement, layoutStyle: Table.LayoutStyle) => void;
    }
  }

  export interface Group<Item extends Identifiable<{}>> {
    id: string;
    filter: (item: Item) => boolean;
    makeHeader?: () => HTMLElement;
    showRowDividers?: boolean;
  }

  export type Style = {
    rowHeight: number;
    showRowDividers: boolean;
    minViewportWidth: number;
    card: CardStyle;

    containerMarginInline: number;
    cellPadding: number;

    layout: LayoutStyle;
  };
  export type StyleOpt = Optional<Style>;

  export namespace Style {
    export function withDefaults(styleOpt?: Option<StyleOpt>): Style {
      const layout = styleOpt?.layout ?? "default";
      const card = styleOpt?.card ?? "default";
      return {
        rowHeight: styleOpt?.rowHeight ?? 40,
        showRowDividers: styleOpt?.showRowDividers ?? true,
        minViewportWidth: styleOpt?.minViewportWidth ?? 0,
        layout,
        card,
        containerMarginInline: styleOpt?.containerMarginInline ??
          (layout === "default" ? 8 : 0),
        cellPadding: styleOpt?.cellPadding ?? 0,
      };
    }
  }

  export interface Delegate<Item extends Identifiable<{}>> {
    onRowClick?: (item: Item) => void;
    makeRowDetail?: (
      item: Item,
      $row: TableBody.Row<Item>,
    ) => Option<HTMLElement>;
    onContextMenu?: (
      item: Item,
      point: Point,
      $row: TableBody.Row<Item>,
    ) => void;
    onRowDoubleClick?: (item: Item) => void;
    canReorder?: (item: Item) => boolean;
    onReorder?: (
      draggedItem: Item,
      beforeItem: Option<Item>,
      afterItem: Option<Item>,
      newItemOrder: Item[],
    ) => Promise<boolean> | boolean;
  }

  export interface Spec<Item extends Identifiable<{}>> {
    columns: Column.Spec<Item>[];
    /** Optional inline detail mounted below a row on first expansion. The
     * subtree is retained across close/open toggles so stateful controls and
     * async work are not destroyed just because the disclosure was closed. */
    renderDetail?: Option<(item: Item) => HTMLElement>;
    floatingCta?: Option<FloatingCta<Item>>;
    groups?: Group<Item>[];
    style?: Option<StyleOpt>;
    delegate?: Option<Delegate<Item>>;
    serverSideSorting?: boolean;
  }

  export interface FloatingCta<Item extends Identifiable<{}>> {
    icon: LonaIcons.RawSvg;
    onClick: (item: Item, point: Point, $row: TableBody.Row<Item>) => void;
  }

  export interface ColumnState<Item extends Identifiable<{}>> {
    spec: Table.Column.Spec<Item>;
    order: number;
    width: Option<number>;
    position: number;
  }

  export class ViewModel<Item extends Identifiable<{}>> {
    // @state[container]
    private _viewportWidth: number = 0;
    private availableWidth: number = 0;

    get viewportWidth(): number {
      return this._viewportWidth;
    }

    // @state[column]
    private columns: Map<string, ColumnState<Item>> = new Map();
    private resizeRequests: Map<string, Table.ResizeRequest> = new Map();

    // @state[table]
    private _sortState: LiveData<
      Option<{ columnId: string; direction: "asc" | "desc" }>
    > = new LiveData<Option<{ columnId: string; direction: "asc" | "desc" }>>(
      null,
    );
    get sortState(): LiveData.Readable<
      Option<{ columnId: string; direction: "asc" | "desc" }>
    > {
      return this._sortState;
    }

    private _primaryColumnId: Option<string>;
    get primaryColumnId(): Option<string> {
      return this._primaryColumnId;
    }

    // @delegate
    layoutInvalidated: LiveData<null> = new LiveData<null>(null);

    constructor(
      public readonly orderedColumns: Table.Column.Spec<Item>[],
      // TODO: callers should use updateStyle
      public style: Table.Style,
      public readonly floatingCta: Option<Table.FloatingCta<Item>>,
      public readonly delegate: Table.Delegate<Item>,
      public readonly renderDetail: Option<(item: Item) => HTMLElement>,
      public readonly groups: Group<Item>[] = [],
      public readonly serverSideSorting: boolean = false,
    ) {
      for (const [idx, c] of orderedColumns.entries()) {
        this.columns.set(c.id, {
          spec: c,
          order: idx,
          width: null,
          position: 0,
        });
        if (!c.primary) continue;
        this._primaryColumnId = c.id;
      }
    }

    static makeDefault<Item extends Identifiable<{}>>(
      spec: Spec<Item>,
    ): Table.ViewModel<Item> {
      return new Table.ViewModel(
        spec.columns,
        Style.withDefaults(spec.style),
        spec.floatingCta,
        spec.delegate ?? {},
        spec.renderDetail,
        spec.groups,
        spec.serverSideSorting ?? false,
      );
    }

    updateStyle(style: Table.StyleOpt) {
      this.style = Style.withDefaults(style);
      this.layoutInvalidated.update(null);
    }

    updateLayoutStyle(style: Table.LayoutStyle) {
      this.style.layout = style;
      this.layoutInvalidated.update(null);
    }

    updateCardStyle(style: Table.CardStyle) {
      this.style.card = style;
      this.layoutInvalidated.update(null);
    }

    /*
     * Column Apis
     */
    getSpec(cid: string): Option<Table.Column.Spec<Item>> {
      return this.columns.get(cid)?.spec;
    }

    getOrder(cid: string): Option<number> {
      return this.columns.get(cid)?.order;
    }

    getWidthOpt(cid: string): Option<number> {
      const c = this.columns.get(cid);
      if (c?.width) return c.width;
      if (c?.spec.minWidth) {
        return c?.spec.minWidth + this.style.cellPadding * 2;
      }
      return null;
    }

    // getWidth(cid: string): number {
    //   const c = this.columns.get(cid);
    //   return c?.width ?? c?.spec.minWidth;
    // }

    getPosition(cid: string): Option<number> {
      return this.columns.get(cid)?.position;
    }

    isLastColumn(cid: string): boolean {
      const order = this.getOrder(cid);
      if (order == null) return false;
      return order === this.orderedColumns.length - 1;
    }

    /*
     * Sort
     */
    toggleSort(columnId: string): void {
      const spec = this.getSpec(columnId);
      if (!spec?.sortComparator) return;

      const current = this._sortState.get();

      if (!current || current.columnId !== columnId) {
        this._sortState.update({ columnId, direction: "asc" });
      } else if (current.direction === "asc") {
        this._sortState.update({ columnId, direction: "desc" });
      } else {
        this._sortState.update(undefined);
      }
    }

    getSortState(): Option<{ columnId: string; direction: "asc" | "desc" }> {
      return this._sortState.get();
    }

    setNaturalWidths(
      naturals: Map<string, number>,
      parentWidth: number,
    ): number {
      Tracing.dev("dbg/table/---------------------------------------------vvv");
      const delta = parentWidth - this.availableWidth;
      Tracing.dev(
        "dbg/table/setNaturalWidths/start",
        naturals,
        parentWidth,
        this.style.layout,
        this.availableWidth,
        delta,
      );
      const parentWidthChanged = parentWidth !== this.availableWidth;

      // When parent width changes, adjust resize requests:
      // - Shrinking: create auto-resize requests to constrain columns proportionally
      // - Expanding: scale user resize requests (auto-resize handled separately below)
      const columnIds = this.orderedColumns.map((c) => c.id);
      if (this.availableWidth > 0 && parentWidthChanged) {
        if (delta < 0) {
          const currentWidths = this.getWidthsMap();
          if (currentWidths) {
            const shrinkRequests = TableUtils.buildResizeRequestsToShrink(
              columnIds,
              currentWidths,
              delta,
            );
            for (const req of shrinkRequests) {
              this.resizeRequests.set(req.columnId, req);
            }
          }
        } else if (delta > 0) {
          const scale = parentWidth / this.availableWidth;
          const userRequests = Array.from(this.resizeRequests.values()).filter(
            (r) => r.source === "user",
          );
          TableUtils.scaleResizeRequests(userRequests, scale);
        }
      }

      // Clear auto-resize requests if natural widths fit within parent
      if (this.hasAutoResizeRequests()) {
        let naturalViewportWidth = 0;
        for (const col of this.orderedColumns) {
          naturalViewportWidth += naturals.get(col.id) ?? 0;
        }

        if (naturalViewportWidth <= parentWidth) {
          this.clearAutoResizeRequests();
        }
      }

      const { widths, positions, viewportWidth } =
        this.style.layout === "inline"
          ? TableUtils.calculateWidthDistributionInline(
            this.orderedColumns,
            this.resizeRequests,
            this.style.minViewportWidth,
            parentWidth,
            naturals,
          )
          : TableUtils.calculateWidthDistributionDefault(
            this.orderedColumns,
            this.resizeRequests,
            this.style.minViewportWidth,
            parentWidth,
            naturals,
            this.style.cellPadding,
          );

      this.availableWidth = parentWidth;
      this.applyLayoutResults(widths, positions);
      this._viewportWidth = viewportWidth;

      this.layoutInvalidated.update(null);
      Tracing.dev(
        "dbg/table/setNaturalWidths/finish",
        widths,
        this.availableWidth,
        this.viewportWidth,
      );
      return viewportWidth;
    }

    private getWidthsMap(): Option<Map<string, number>> {
      const widths = new Map<string, number>();
      for (const [id, col] of this.columns) {
        if (col.width == null) return null;
        widths.set(id, col.width);
      }
      return widths;
    }

    private applyLayoutResults(
      widths: Map<string, number>,
      positions: Map<string, number>,
    ): void {
      for (const [id, col] of this.columns) {
        col.width = widths.get(id) ?? 0;
        col.position = positions.get(id) ?? 0;
      }
    }

    addResizeRequest(request: Table.ResizeRequest): void {
      const currentOrder = this.getOrder(request.columnId);
      if (currentOrder == null) return;

      const currentWidth = this.getWidthOpt(request.columnId);
      if (currentWidth == null) return;

      const clampedTargetWidth = Math.max(
        MIN_COLUMN_WIDTH,
        request.targetWidth,
      );
      const delta = clampedTargetWidth - currentWidth;
      if (delta === 0) return;

      let totalWidth = 0;
      for (const col of this.orderedColumns) {
        const width = this.getWidthOpt(col.id) ?? 0;
        totalWidth += width;
      }

      const isLocked = totalWidth <= this.availableWidth;
      const nextColumnIndex = currentOrder + 1;
      const isLastColumn = nextColumnIndex >= this.orderedColumns.length;

      if (isLocked && !isLastColumn) {
        const nextColumn = this.orderedColumns[nextColumnIndex];
        const nextWidth = this.getWidthOpt(nextColumn.id) ?? 0;
        const nextTargetWidth = nextWidth - delta;

        if (clampedTargetWidth > this.availableWidth) {
          return;
        }
        if (nextTargetWidth < MIN_COLUMN_WIDTH) {
          return;
        }

        this.resizeRequests.set(request.columnId, {
          columnId: request.columnId,
          delta,
          targetWidth: clampedTargetWidth,
          source: "user",
        });
        this.resizeRequests.set(nextColumn.id, {
          columnId: nextColumn.id,
          delta: -delta,
          targetWidth: nextTargetWidth,
          source: "user",
        });
      } else {
        this.resizeRequests.set(request.columnId, {
          columnId: request.columnId,
          delta,
          targetWidth: clampedTargetWidth,
          source: "user",
        });
      }

      this.layoutInvalidated.update(null);
    }

    private clearAutoResizeRequests(): void {
      const userRequests = new Map<string, Table.ResizeRequest>();
      for (const [id, req] of this.resizeRequests) {
        if (req.source === "user") {
          userRequests.set(id, req);
        }
      }
      this.resizeRequests = userRequests;
    }

    private hasAutoResizeRequests(): boolean {
      for (const req of this.resizeRequests.values()) {
        if (req.source === "auto") return true;
      }
      return false;
    }

    resolveWidthSpec(columnId: string): Table.WidthSpec.Resolved {
      return { columnId };
    }
  }
}
