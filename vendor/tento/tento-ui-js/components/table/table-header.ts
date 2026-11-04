import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Point } from "@tento-core/point";
import { Tracing } from "@tento-core/tracing";
import { Round } from "../round";
import { SizeGate } from "../../ui/size-gate";
import { Table } from "./table";

@component({
  name: "std-table-header",
})
export class TableHeader<
  Item extends Identifiable<{}>,
> extends LonaWebComponent {
  // @components
  private $columns: Map<string, TableHeader.Column<Item>> = new Map();
  private $root: HTMLElement = this.$("root");

  // @props
  private tvm: Option<Table.ViewModel<Item>>;
  private layoutCallbacks?: Optional<{
    onLayoutStart: () => void;
    onLayoutEnd: () => void;
  }>;

  // @layout
  private sizeGate: Option<SizeGate>;

  layoutPromise: Option<Promise<void>>;
  private layoutSuspended = false;
  private lifetime = 0;
  private binding = 0;

  /** FLIP commits one destination with layoutNow; resize observers wait for it. */
  setLayoutSuspended(suspended: boolean): void {
    if (this.layoutSuspended === suspended) return;
    this.layoutSuspended = suspended;
    if (!suspended && this.isConnected) this.queueLayout();
  }

  async queueLayout(): Promise<void> {
    if (this.layoutSuspended) return;
    const pending = this.layoutPromise ??= this.performLayout();
    await pending;
    if (this.layoutPromise === pending) this.layoutPromise = null;
  }

  /** Synchronous layout for a mounted table participating in a layout animation. */
  layoutNow(): void {
    const tvm = this.tvm;
    const root = this.getRootNode();
    if (!tvm || !(root instanceof ShadowRoot)) return;
    const width = root.host.getBoundingClientRect().width;
    if (width <= 0) return;
    const naturalWidths = new Map<string, number>();
    for (const [id, $column] of this.$columns) {
      naturalWidths.set(id, $column.getBoundingClientRect().width);
    }
    this.layoutCallbacks?.onLayoutStart?.();
    if (tvm.style.layout === "inline") {
      this.performLayoutInlineSync();
    } else {
      const availableWidth = width - tvm.style.containerMarginInline * 2;
      const viewportWidth = tvm.setNaturalWidths(naturalWidths, availableWidth);
      this.performLayoutDefaultSync(availableWidth, viewportWidth);
    }
    this.layoutCallbacks?.onLayoutEnd?.();
  }

  private subscribe(): void {
    const tvm = this.tvm;
    if (!tvm) return;
    tvm.layoutInvalidated.addListener(this, () => {
      if (this.tvm !== tvm) return;
      this.style.setProperty("--container-margin-inline", `${tvm.style.containerMarginInline}px`);
      void this.queueLayout();
    });
    this.style.setProperty("--container-margin-inline", `${tvm.style.containerMarginInline}px`);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.subscribe();
    void this.queueLayout();
  }

  disconnectedCallback(): void {
    this.lifetime++;
    this.layoutPromise = null;
    this.tvm?.layoutInvalidated.removeListener(this);
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.lifetime++;
    this.binding++;
    this.tvm?.layoutInvalidated.removeListener(this);
    this.tvm = null;
    this.sizeGate = null;
    this.layoutCallbacks = undefined;
    this.layoutPromise = null;
    this.layoutSuspended = false;
    DomUtils.clearChildren(this.$root);
    this.$columns.clear();
    super.onRecycle();
  }

  async bind(
    tvm: Table.ViewModel<Item>,
    sizeGate: SizeGate,
    callbacks?: {
      onLayoutStart?: () => void;
      onLayoutEnd?: () => void;
    },
  ): Promise<void> {
    // Remove listener from previous tvm before binding new one
    this.tvm?.layoutInvalidated.removeListener(this);

    this.lifetime++;
    const binding = ++this.binding;
    this.layoutPromise = null;
    this.tvm = tvm;
    this.sizeGate = sizeGate;
    this.layoutCallbacks = callbacks;
    this.subscribe();

    DomUtils.clearChildren(this.$root);
    this.$columns.clear();
    this.style.setProperty(
      "--container-margin-inline",
      tvm.style.containerMarginInline + "px",
    );

    for (const s of tvm.orderedColumns) {
      const $d =
        TableHeader.Column.make() as unknown as TableHeader.Column<Item>;
      const resolved = tvm.resolveWidthSpec(s.id);
      $d.bind(s, resolved, tvm);
      GESTURE_MANAGER.addDragGesture(
        $d.$handle,
        "table",
        this.dragGesture(tvm, $d),
      );

      if (s.sortComparator) {
        $d.setAttribute("tabindex", "0");
        GESTURE_MANAGER.addPointerEvent($d, {
          onClick: () => {
            if (binding === this.binding && this.tvm === tvm) tvm.toggleSort(s.id);
          },
        });
        $d.onkeydown = (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (binding === this.binding && this.tvm === tvm) tvm.toggleSort(s.id);
          }
        };
        $d.style.cursor = "pointer";
      }

      this.$columns.set(s.id, $d);
      this.$root.appendChild($d);
    }

    await this.queueLayout();
  }

  private dragGesture(
    tvm: Table.ViewModel<Item>,
    $d: TableHeader.Column<Item>,
  ): {
    onPointerDown?: (e: PointerEvent) => void;
    onPointerMove: (e: { progress: Point; page: Point; offset: Point }) => void;
    onPointerUp?: Option<(e: { progress: Point }) => void>;
  } {
    let currentColumnId: Option<string>;
    let initialWidth: Option<number>;

    return {
      onPointerMove: ({ progress }) => {
        if (this.tvm !== tvm || this.$columns.get($d.cid ?? "") !== $d) return;
        if (!currentColumnId || initialWidth == null) return;

        const delta = -progress.x;
        const targetWidth = initialWidth + delta;

        tvm.addResizeRequest({
          columnId: currentColumnId,
          delta,
          targetWidth,
          source: "user",
        });
      },
      onPointerDown: () => {
        if (this.tvm !== tvm || this.$columns.get($d.cid ?? "") !== $d) return;
        currentColumnId = $d.cid;
        if (!currentColumnId) return;

        initialWidth = $d.getBoundingClientRect().width;
        $d.toggleAttribute("active", true);
      },
      onPointerUp: () => {
        if (this.tvm !== tvm || this.$columns.get($d.cid ?? "") !== $d) return;
        if (currentColumnId) {
          const $column = this.$columns.get(currentColumnId)!;
          $column.toggleAttribute("active", false);
        }
        currentColumnId = null;
        initialWidth = null;
      },
    };
  }

  private async performLayout(): Promise<void> {
    const tvm = this.tvm;
    const sizeGate = this.sizeGate;
    const lifetime = this.lifetime;
    const live = () => lifetime === this.lifetime && this.tvm === tvm;
    if (tvm == null || sizeGate == null) return;
    const measure = async () => {
      if (!live()) return;
      if (this.layoutSuspended) return;
      // Get current table size directly to avoid stale sizeGate values
      // (sizeGate updates are blocked during layout by the isLayouting guard)
      const root = this.getRootNode();
      const tableHost = root instanceof ShadowRoot ? root.host : null;
      const currentWidth = tableHost?.getBoundingClientRect().width || 0;

      // Use current measured width if available, fall back to sizeGate for initial render
      const hs =
        currentWidth > 0
          ? { width: currentWidth, height: 0 }
          : (sizeGate.currentSize ?? (await sizeGate.waitForSize()));

      if (!live() || this.layoutSuspended) return;

      const naturalWidths = new Map<string, number>();
      for (const [columnId, $column] of this.$columns) {
        const width = $column.getBoundingClientRect().width;
        naturalWidths.set(columnId, width);
      }
      const band = this.measureBand();

      this.layoutCallbacks?.onLayoutStart?.();
      $$.mutate(() => {
        if (!live()) return;
        this.publishBand(band);
        if (this.layoutSuspended) {
          this.layoutCallbacks?.onLayoutEnd?.();
          return;
        }
        if (this.tvm!.style.layout === "inline") {
          this.performLayoutInlineSync();
        } else {
          const availableWidth =
            hs.width - this.tvm!.style.containerMarginInline * 2;
          const viewportWidth = this.tvm!.setNaturalWidths(
            naturalWidths,
            availableWidth,
          );
          this.performLayoutDefaultSync(availableWidth, viewportWidth);
        }

        $$.mutate(() => {
          if (live()) this.layoutCallbacks?.onLayoutEnd?.();
        });
      });
    };

    return new Promise((resolve) => {
      $$.measure(() => {
        measure().then(resolve);
      });
    });
  }

  /**
   * The band the tallest heading needs: its own content, plus the block
   * padding that surrounds it.
   *
   * Read here because this pass is ALREADY measuring every column; a separate
   * read/write pair would be a second forced layout on every table in the
   * fleet.
   *
   * It measures the heading's CONTENT and never the heading's own box. The box
   * is sized by this answer (`min-height: 100%` against the band), so reading
   * it back would be circular — the band would latch at whatever the first
   * paint happened to give it and a second line would never widen it.
   */
  private measureBand(): number {
    let content = 0;
    let padding = 0;
    for (const [, $column] of this.$columns) {
      content = Math.max(content, $column.contentHeight);
      // Read off a heading rather than assumed: the default lives in this
      // component's CSS and a host may override
      // `--table-header-padding-block`, so the number has to come from the
      // cascade rather than from a constant here.
      padding = Math.max(padding, $column.blockPadding);
    }
    return content + padding;
  }

  /**
   * Publish the band onto the TABLE's host element, not this one.
   *
   * The chip the table draws behind the header (`#bg`) is a SIBLING of this
   * element in the table's shadow tree, so a property set here would never
   * reach it — custom properties inherit down, not sideways. The host is the
   * one element both trees inherit from, which is why the write reaches up.
   * A floor is not applied here: it is `min-height` in both stylesheets, so a
   * header with no content to measure keeps the 36px every table already drew.
   */
  private publishBand(height: number): void {
    const host = ((this.getRootNode() as ShadowRoot).host ?? null) as Option<HTMLElement>;
    host?.style.setProperty("--table-header-height", `${height}px`);
  }

  private performLayoutInlineSync() {
    Tracing.dev("dbg/table/performLayoutInlineSync", this.tvm);
    if (!this.tvm) return;
    this.$root.style.width = "";
    this.$root.style.display = "flex";

    const primaryOrder = this.tvm.primaryColumnId
      ? this.tvm.getOrder(this.tvm.primaryColumnId)
      : null;

    for (const [columnId, $column] of this.$columns) {
      $column.style.position = "";
      $column.style.transform = "";

      if (columnId === this.tvm.primaryColumnId) {
        $column.style.flex = "1";
        $column.style.width = "";
        continue;
      }

      const columnOrder = this.tvm.getOrder(columnId);
      const isPrePrimary =
        primaryOrder != null &&
        columnOrder != null &&
        columnOrder < primaryOrder;
      const width = this.tvm.getWidthOpt(columnId);
      if (isPrePrimary && width) {
        $column.style.flex = "";
        $column.style.width = `${width}px`;
      } else {
        $column.style.flex = "";
        $column.style.width = "";
      }
    }
  }

  private performLayoutDefaultSync(
    availableWidth: number,
    viewportWidth: number,
  ) {
    if (availableWidth > 0) {
      const marginTotal = (this.tvm?.style.containerMarginInline ?? 0) * 2;
      this.$root.style.width = `${viewportWidth}px`;
      this.style.width = `${viewportWidth + marginTotal}px`;
      for (const [columnId, $column] of this.$columns) {
        $column.style.position = "";
        $column.style.flex = "";
        $column.style.width = `${this.tvm?.getWidthOpt(columnId) ?? 0}px`;
        $column.style.transform = `translateX(${this.tvm?.getPosition(columnId) ?? 0}px)`;
      }
    } else {
      // When availableWidth is 0, keep columns as flex to allow natural sizing
      for (const [_columnId, $column] of this.$columns) {
        $column.style.position = "";
        $column.style.flex = "";
        $column.style.width = "";
        $column.style.transform = "";
      }
    }
    this.$root.style.display = "";
  }

  static $styles = [
    css`
      :host {
        /* Both: the measured band is what a two-line heading needs, and the
           floor is what one line has always been given. A header whose columns
           carry no second line resolves to the floor and nothing moves. */
        min-height: 36px;
        height: var(--table-header-height, 36px);
      }

      #root {
        position: relative;
        height: 100%;
        margin-inline: var(--container-margin-inline);
      }
    `,
  ];
  static $html = html`
    <std-row id=root></std-row>
  `;
}

export namespace TableHeader {
  /** A compact header band needs local corners, not the tall-card radius. */
  export const SURFACE_PROPS: Round.Props = { ...Round.Props.FLAT_CARD, radius: 8 };

  @component({
    name: "std-table-header-column",
  })
  export class Column<Item extends Identifiable<{}>> extends LonaWebComponent {
    $bg: Round = this.hydrate<Round>("bg").bind(TableHeader.SURFACE_PROPS);
    $handle = this.$("drag-handle");
    $sortArrow = this.$("sort-arrow");
    $labels = this.$("labels");
    $inner = this.$("root");

    /** This heading's own content height — one line, or two when the column
     *  carries a `sublabel`. The sort arrow is in the max because a column with
     *  `showLabel: false` has no label stack to be taller than it. */
    get contentHeight(): number {
      return Math.max(
        this.$labels.getBoundingClientRect().height,
        this.$sortArrow.getBoundingClientRect().height,
      );
    }

    /** The block padding in effect on this heading, top plus bottom. */
    get blockPadding(): number {
      const style = getComputedStyle(this.$inner);
      return parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    }

    cid: Option<string>;
    private tvm: Option<Table.ViewModel<Item>>;
    private sortable = false;

    static observedAttributes = ["active"];

    attributeChangedCallback(
      name: string,
      _oldValue: string,
      newValue: string,
    ): void {
      if (name === "active") {
        this.$bg.setAnimates(newValue == null);
      }
    }

    private subscribe(): void {
      const tvm = this.tvm;
      if (!tvm) return;
      const spacing = () => {
        if (this.tvm === tvm) this.style.setProperty("--cell-padding", `${tvm.style.cellPadding}px`);
      };
      tvm.layoutInvalidated.addListener(this, spacing);
      spacing();
      if (this.sortable) tvm.sortState.addListener(this, () => this.bindSortArrow());
      this.bindSortArrow();
    }

    connectedCallback(): void {
      super.connectedCallback();
      this.subscribe();
    }

    disconnectedCallback(): void {
      this.tvm?.sortState.removeListener(this);
      this.tvm?.layoutInvalidated.removeListener(this);
      super.disconnectedCallback();
    }

    onRecycle(): void {
      this.tvm?.sortState.removeListener(this);
      this.tvm?.layoutInvalidated.removeListener(this);
      this.tvm = null;
      this.cid = null;
      this.sortable = false;
      this.onkeydown = null;
      this.removeAttribute("aria-sort");
      this.$sortArrow.style.display = "none";
      super.onRecycle();
    }

    bind(
      spec: Table.Column.Spec<Item>,
      resolved: Table.WidthSpec.Resolved,
      tvm: Table.ViewModel<Item>,
    ): this {
      // Remove listener from previous tvm before binding new one
      this.tvm?.sortState.removeListener(this);
      this.tvm?.layoutInvalidated.removeListener(this);

      this.cid = resolved.columnId;
      this.tvm = tvm;

      // Set ARIA attributes for column header
      this.setAttribute("role", "columnheader");

      this.style.setProperty("--cell-padding", `${tvm.style.cellPadding}px`);

      const showLabel = spec.showLabel ?? true;
      const $labels = this.$("labels");
      const $sublabel = this.$("sublabel");
      if (showLabel) {
        this.$("label").textContent = spec.label;
        $labels.style.display = "";
      } else {
        $labels.style.display = "none";
      }
      // ABSENT, not blank: an empty second line would still take its half of
      // the band, and every column in the row would be pushed off centre by a
      // line that says nothing.
      const sublabel = spec.sublabel ?? null;
      $sublabel.textContent = sublabel ?? "";
      $sublabel.style.display = sublabel == null ? "none" : "";

      if (spec.tooltip != null && spec.tooltip !== "") this.title = spec.tooltip;
      else this.removeAttribute("title");

      this.sortable = spec.sortComparator != null;
      this.subscribe();

      return this;
    }

    private bindSortArrow(): void {
      if (!this.tvm || !this.cid) return;

      const sortState = this.tvm.getSortState();
      if (this.sortable && sortState && sortState.columnId === this.cid) {
        this.$sortArrow.style.display = "";
        this.$sortArrow.textContent = "↑";
        this.$sortArrow.style.transform =
          sortState.direction === "asc" ? "rotate(0deg)" : "rotate(180deg)";
        this.setAttribute(
          "aria-sort",
          sortState.direction === "asc" ? "ascending" : "descending",
        );
      } else {
        this.$sortArrow.style.display = "none";
        this.removeAttribute("aria-sort");
      }
    }

    static $styles: Style.Compat[] = [
      css`
        :host {
          position: absolute;
          top: 0;
          left: 0;
          height: 100%;
          width: max-content;
          border-radius: 8px;
          cursor: pointer;
          box-sizing: border-box;
        }

        #bg {
          opacity: 0;
          transition: opacity 0.3s ease;
          opacity: var(--debug-table-bg-opacity, 0);
        }

        :host(:hover) #bg {
          opacity: 1;
        }

        :host([active]) #bg {
          opacity: 1;
        }

        #root {
          /* The band comes FROM this padding: measureBand adds it to the
             tallest heading's content. A height here would put the number in
             two places and let them disagree. 11px is what the old 36px band
             left around one line of small, so a one-line header is
             unchanged. */
          padding-block: var(--table-header-padding-block, 11px);
          padding-inline: var(--cell-padding);
          min-height: 100%;
          box-sizing: border-box;
          align-items: center;
          position: relative;
        }

        #labels {
          min-width: 0;
          margin-right: 4px;
        }

        #label,
        #sublabel {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          /* The type ramp trims optical margins off a paragraph, which is
             right for stacked prose and wrong for two lines inside one cell:
             untrimmed they overlap. --margin-top does not undo it (its
             fallback is already 0px); the real property does. */
          margin-top: 0px;
          margin-bottom: 0px;
        }

        #sublabel {
          color: var(--text-ter);
          --font-size: var(--text-7px);
        }

        #sort-arrow {
          color: var(--text-sec);
          margin-left: 4px;
          font-size: 12px;
          line-height: 1;
          flex-shrink: 0;
          transition: transform 0.3s ease;
        }

        #drag-handle {
          position: absolute;
          top: 6px;
          bottom: 6px;
          width: 4px;
          right: 0px;
          background: var(--divider-pri);
          z-index: 1;
          border-radius: 2px;
          opacity: 0;
          transition: opacity 0.3s ease;
          cursor: ew-resize;
        }


        :host([active]) #drag-handle,
        #drag-handle:hover {
          opacity: 1;
        }

        :host:focus-visible {
          outline: 2px solid var(--blue);
          outline-offset: 2px;
        }
      `,
    ];
    static $html: Option<HTMLTemplateElement> = html`
      <std-row id=root>
        <std-round id=bg floating></std-round>

        <std-col id=labels>
          <p id=label class=small></p>
          <p id=sublabel class=small></p>
        </std-col>
        <div id=sort-arrow></div>
        <div id=drag-handle></div>
      </std-row>
    `;
  }
}
