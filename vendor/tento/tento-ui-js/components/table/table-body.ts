import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { LonaIcons } from "../../ui/icons";
import { ReorderManager } from "../../ui/reorder-manager";
import { Table } from "./table";

@component({
  name: "std-table-body",
})
export class TableBody<Item extends Identifiable<{}>> extends LonaWebComponent {
  // @components
  private $root: HTMLElement = this.$("root");

  private reorderManager: Option<ReorderManager<TableBody.Row<Item>>>;

  // @props
  private tvm: Option<Table.ViewModel<Item>>;
  private rows: TableBody.Row<Item>[] = [];
  private rowDetails = new Map<Item["id"], HTMLElement>();

  get $layoutElements(): HTMLElement[] {
    return this.rows.map(($row) => $row.$layoutElement);
  }

  bind(
    tvm: Table.ViewModel<Item>,
    items: Item[],
    showRowDividers: Option<boolean>,
    selectedId: Option<Item["id"]>,
    expandedIds: Option<Set<Item["id"]>>,
  ): this {
    // Remove listener from previous tvm before binding new one
    this.tvm?.layoutInvalidated.removeListener(this);

    this.tvm = tvm;
    this.style.setProperty(
      "--container-margin-inline",
      tvm.style.containerMarginInline + "px",
    );

    tvm.layoutInvalidated.addListener(this, () => {
      this.updateLayout();
    });

    DomUtils.clearChildren(this.$root, false);
    this.rows = [];
    this.rowDetails.clear();

    if (tvm.delegate.onReorder) {
      this.reorderManager = new ReorderManager(
        this.$root,
        async ($draggedRow, $before, $after, $newRowOrder) => {
          const draggedItem = $draggedRow.item!;
          const beforeItem = $before?.item;
          const afterItem = $after?.item;
          const newItemOrder = $newRowOrder
            .map(($r) => $r.item)
            .filter((i): i is Item => i !== undefined);

          const result = await tvm.delegate.onReorder!(
            draggedItem,
            beforeItem,
            afterItem,
            newItemOrder,
          );
          return result;
        },
        1,
      );
    } else {
      this.reorderManager = null;
    }

    for (const item of items) {
      const $row = TableBody.Row.make() as unknown as TableBody.Row<Item>;
      $row.bind(tvm, item, selectedId, expandedIds);
      $row.toggleAttribute(
        "show-divider",
        showRowDividers ?? tvm.style.showRowDividers,
      );
      $row.assignStyles({
        "--height": tvm.style.rowHeight + "px",
      });
      this.$root.appendChild($row);
      this.rows.push($row);

      this.bindRowDetail(item, $row);

      if (this.reorderManager) {
        const canReorder = tvm.delegate.canReorder
          ? tvm.delegate.canReorder(item)
          : true;
        if (canReorder) {
          $row.toggleAttribute("reorderable", true);
          this.reorderManager.registerRow($row);
        }
      }
    }

    this.updateLayout();
    return this;
  }

  /** Update an ungrouped body without recycling rows whose id and revision
   * are unchanged. This keeps status marks and other stateful cells mounted
   * while rows are inserted, removed, or reordered around them. */
  bindKeyed(
    tvm: Table.ViewModel<Item>,
    items: Item[],
    revision: (item: Item) => string,
    showRowDividers: Option<boolean>,
    selectedId: Option<Item["id"]>,
    expandedIds: Option<Set<Item["id"]>>,
  ): this {
    if (tvm.delegate.onReorder) {
      return this.bind(tvm, items, showRowDividers, selectedId, expandedIds);
    }

    const tvmChanged = this.tvm !== tvm;
    if (tvmChanged) {
      this.tvm?.layoutInvalidated.removeListener(this);
      this.tvm = tvm;
      this.style.setProperty(
        "--container-margin-inline",
        tvm.style.containerMarginInline + "px",
      );
      tvm.layoutInvalidated.addListener(this, () => this.updateLayout());
    }
    this.reorderManager = null;

    const existing = new Map(
      this.rows.flatMap(($row) =>
        $row.item == null ? [] : [[$row.item.id, $row] as const]
      ),
    );
    const nextRows: TableBody.Row<Item>[] = [];

    for (const item of items) {
      const itemRevision = revision(item);
      let $row = existing.get(item.id);
      if (!$row) {
        $row = TableBody.Row.make() as unknown as TableBody.Row<Item>;
      }
      if (tvmChanged || $row.keyedRevision !== itemRevision) {
        $row.bind(tvm, item, selectedId, expandedIds);
        $row.keyedRevision = itemRevision;
      } else {
        $row.item = item;
        $row.updateSelectedState(selectedId);
        if (expandedIds) $row.updateExpandedState(expandedIds);
      }
      $row.toggleAttribute(
        "show-divider",
        showRowDividers ?? tvm.style.showRowDividers,
      );
      $row.assignStyles({ "--height": tvm.style.rowHeight + "px" });
      nextRows.push($row);
      existing.delete(item.id);
    }

    nextRows.forEach(($row, index) => {
      const current = this.$root.children.item(index);
      if (current !== $row) this.$root.insertBefore($row, current);
    });
    for (const $row of existing.values()) $row.remove();
    this.rows = nextRows;
    return this;
  }

  updateSelectedItem(selectedId: Option<Item["id"]>): void {
    for (const row of this.rows) {
      row.updateSelectedState(selectedId);
    }
  }

  updateExpandedItems(expandedIds: Set<Item["id"]>): void {
    for (const row of this.rows) {
      row.updateExpandedState(expandedIds);
    }
  }

  findRowById(id: Item["id"]): Option<TableBody.Row<Item>> {
    for (const row of this.rows) {
      if (row.item?.id === id) return row;
    }
    return undefined;
  }

  updateRowDetail(id: Item["id"]): boolean {
    const $row = this.findRowById(id);
    if (!$row?.item) return false;
    this.bindRowDetail($row.item, $row);
    this.updateLayout();
    return true;
  }

  private bindRowDetail(item: Item, $row: TableBody.Row<Item>): void {
    if (!this.tvm) return;

    const $previous = this.rowDetails.get(item.id);
    const $next = this.tvm.delegate.makeRowDetail?.(item, $row);
    $row.toggleAttribute("expanded", $next != null);
    if (this.tvm.delegate.makeRowDetail) {
      $row.setAttribute("aria-expanded", String($next != null));
    }

    if ($previous && $next) {
      $next.classList.add("row-detail");
      $previous.replaceWith($next);
      this.rowDetails.set(item.id, $next);
    } else if ($previous) {
      $previous.remove();
      this.rowDetails.delete(item.id);
    } else if ($next) {
      $next.classList.add("row-detail");
      $row.after($next);
      this.rowDetails.set(item.id, $next);
    }
  }

  private subscribe(): void {
    const tvm = this.tvm;
    if (!tvm) return;
    tvm.layoutInvalidated.addListener(this, () => {
      if (this.tvm === tvm) this.updateLayout();
    });
    this.updateLayout();
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.subscribe();
  }

  disconnectedCallback(): void {
    this.tvm?.layoutInvalidated.removeListener(this);
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.tvm?.layoutInvalidated.removeListener(this);
    this.tvm = null;
    this.reorderManager = null;
    DomUtils.clearChildren(this.$root);
    this.rows = [];
    this.rowDetails.clear();
    super.onRecycle();
  }

  private updateLayout(): void {
    if (!this.tvm) return;

    this.style.setProperty(
      "--container-margin-inline",
      `${this.tvm.style.containerMarginInline}px`,
    );

    for (const row of this.rows) {
      row.updateLayout(this.tvm);
    }

    const detailWidth = this.tvm.style.layout === "inline"
      ? "100%"
      : `${this.tvm.viewportWidth + this.tvm.style.containerMarginInline * 2}px`;
    for (const $detail of this.rowDetails.values()) {
      $detail.style.width = detailWidth;
    }
  }

  static $styles = [
    css`
      :host {
        display: block;
        position: relative;
        flex: 1;
        width: max-content;
        min-width: 100%;
      }

      #root {
        position: relative;
        gap: 1px;
      }

      .row-detail {
        box-sizing: border-box;
        min-width: 100%;
      }
    `,
  ];

  static $html = html`
    <std-col id="root"></std-col>
  `;
}

export namespace TableBody {
  @component({
    name: "std-table-body-row",
  })
  export class Row<Item extends Identifiable<{}>> extends LonaWebComponent {
    private $root: HTMLElement = this.$("root");
    private $floatingButton: HTMLElement = this.$("floating-button");
    private $detail: HTMLElement = this.$("detail");
    private $detailBody: HTMLElement = this.$("detail-body");
    // Shared-by-reference with the owning Table, so a click toggles it in place.
    // A table that passes no set gets a row-local one, so rows still expand.
    private expandedIds: Set<Item["id"]> = new Set();
    // The detail body is built on first expand, not on every bind.
    private detailBuilt = false;
    private cells: Map<string, HTMLElement> = new Map();
    private cellContents: Map<string, HTMLElement> = new Map();
    private cellObserver: Option<ResizeObserver>;
    private cellHeights = new Map<Element, number>();
    public item: Option<Item>;
    /** Revision token this row was last bound with (keyed reconciliation). */
    public keyedRevision: Option<string>;
    private tvm: Option<Table.ViewModel<Item>>;

    get $layoutElement(): HTMLElement {
      return this.$root;
    }

    connectedCallback(): void {
      super.connectedCallback();
      this.style.position = "relative";
    }

    disconnectedCallback(): void {
      super.disconnectedCallback();
      this.cellObserver?.disconnect();
    }

    private updateRowHeight(): void {
      const style = this.tvm?.style;
      let maxHeight = 0;
      for (const height of this.cellHeights.values()) {
        maxHeight = Math.max(maxHeight, height);
      }
      $$.mutate(() => {
        // A queued measurement from the old style must not restore its height
        // after an in-place row-height change.
        if (this.tvm?.style !== style) return;
        this.$root.style.minHeight = `${maxHeight}px`;
      });
    }

    bind(
      tvm: Table.ViewModel<Item>,
      item: Item,
      selectedId: Option<Item["id"]>,
      expandedIds: Option<Set<Item["id"]>>,
    ): this {
      this.tvm = tvm;
      this.item = item;
      this.keyedRevision = null;

      this.cellObserver?.disconnect();
      this.cellObserver = null;
      this.clearChildren();
      this.cells.clear();
      this.cellContents.clear();
      this.cellHeights.clear();

      for (const colSpec of tvm.orderedColumns) {
        const $cell = this.makeCell(colSpec);
        this.appendChild($cell);
        this.cells.set(colSpec.id, $cell);
        this.bindCell(colSpec, item);
      }

      this.cellObserver = new ResizeObserver((entries) => {
        let heightChanged = false;
        for (const entry of entries) {
          // Border-box measurements are already available here. A width-only
          // notification must not force layout and re-write every row height.
          const height = entry.borderBoxSize[0]?.blockSize;
          if (height == null || this.cellHeights.get(entry.target) === height) continue;
          this.cellHeights.set(entry.target, height);
          heightChanged = true;
        }
        if (heightChanged) this.updateRowHeight();
      });
      for (const $cell of this.cells.values()) {
        this.cellObserver.observe($cell, { box: "border-box" });
      }

      if (tvm.floatingCta) {
        this.$floatingButton.style.display = "";
        DomUtils.clearChildren(this.$floatingButton);
        const $icon = LonaIcons.make(tvm.floatingCta.icon, { sizePx: 12 });
        this.$floatingButton.appendChild($icon);
        GESTURE_MANAGER.addPointerEvent(this.$floatingButton, {
          onClick: (_capturedElement, offset) => {
            const rect = this.$floatingButton.getBoundingClientRect();
            const point = {
              x: rect.left + offset.x,
              y: rect.top + offset.y,
            };
            tvm.floatingCta?.onClick(item, point, this);
          },
          onContextMenu: (point) => {
            tvm.floatingCta?.onClick(item, point, this);
          },
        });
      } else {
        this.$floatingButton.style.display = "none";
      }

      if (tvm.delegate.onRowClick || tvm.delegate.onContextMenu || tvm.renderDetail) {
        this.$root.style.cursor = "pointer";
        GESTURE_MANAGER.addPointerEvent(this.$root, {
          onClick: () => {
            if (!this.item) return;
            if (tvm.renderDetail) this.toggleDetail();
            tvm.delegate.onRowClick?.(this.item);
          },
          onContextMenu: (point) => {
            if (this.item) tvm.delegate.onContextMenu?.(this.item, point, this);
          },
        });
      }

      // Inline detail (expandable rows). Open state comes from the shared
      // `expandedIds` set (durable across rebinds); the body is rebuilt lazily,
      // so a rebind with new data never shows the previous item's detail.
      this.expandedIds = expandedIds ?? new Set();
      DomUtils.clearChildren(this.$detailBody);
      this.detailBuilt = false;
      if (tvm.renderDetail) {
        this.toggleAttribute("expandable", true);
        this.applyExpanded(this.expandedIds.has(item.id), false);
      } else {
        this.toggleAttribute("expandable", false);
        this.applyExpanded(false, false);
      }

      this.updateSelectedState(selectedId);
      this.updateLayout(tvm);
      return this;
    }

    updateSelectedState(selectedId: Option<Item["id"]>): void {
      if (!this.item) return;
      const isSelected = selectedId != null && this.item.id === selectedId;
      this.toggleAttribute("selected", isSelected);
    }

    /** Programmatic expand/collapse fan-out (animates). */
    updateExpandedState(expandedIds: Set<Item["id"]>): void {
      if (!this.item) return;
      this.expandedIds = expandedIds;
      this.applyExpanded(expandedIds.has(this.item.id), true);
    }

    /** Row-click toggle: flips the shared set in place, then animates. */
    private toggleDetail(): void {
      if (!this.item) return;
      const id = this.item.id;
      const next = !this.expandedIds.has(id);
      if (next) this.expandedIds.add(id);
      else this.expandedIds.delete(id);
      this.applyExpanded(next, true);
    }

    /** Show/hide the inline detail. `animate=false` sets height immediately
     *  (initial render / rebuild restore); `true` runs the accordion height
     *  transition, which reflows the rows below in normal flow. */
    private applyExpanded(expanded: boolean, animate: boolean): void {
      if (expanded) this.ensureDetailBuilt();
      this.toggleAttribute("expanded", expanded);
      this.$root.setAttribute("aria-expanded", String(expanded));
      const $d = this.$detail;
      if (!animate) {
        $d.style.height = expanded ? "auto" : "0";
        return;
      }
      const start = expanded ? 0 : $d.offsetHeight;
      let end = 0;
      if (expanded) {
        $d.style.height = "auto";
        end = this.$detailBody.offsetHeight;
        $d.style.height = `${start}px`;
      }
      const anim = $d.animate(
        [{ height: `${start}px` }, { height: `${end}px` }],
        { duration: 260, easing: "ease", fill: "both" },
      );
      anim.onfinish = () => {
        $d.style.height = expanded ? "auto" : "0";
      };
    }

    private ensureDetailBuilt(): void {
      if (this.detailBuilt || !this.item || !this.tvm?.renderDetail) return;
      this.$detailBody.appendChild(this.tvm.renderDetail(this.item));
      this.detailBuilt = true;
    }

    private makeCell(colSpec: Table.Column.Spec<Item>): HTMLElement {
      const $content = colSpec.make();
      this.cellContents.set(colSpec.id, $content);

      const $cell = document.createElement("div");
      $cell.classList.add("cell");
      $cell.appendChild($content);

      return $cell;
    }

    private bindCell(colSpec: Table.Column.Spec<Item>, item: Item): void {
      const $content = this.cellContents.get(colSpec.id);
      if (!$content) return;
      colSpec.bind($content, item, this);
    }

    updateLayout(tvm: Table.ViewModel<Item>): void {
      const isInline = tvm.style.layout === "inline";
      this.toggleAttribute("inline", isInline);

      const height = `${tvm.style.rowHeight}px`;
      if (this.style.getPropertyValue("--height") !== height) {
        this.$root.style.removeProperty("min-height");
        this.style.setProperty("--height", height);
      }
      this.style.setProperty("--cell-padding", `${tvm.style.cellPadding}px`);

      if (isInline) {
        // dev("dbg/table-body/inline/calculated-widths", tvm.calculatedWidths);
        const primaryOrder = tvm.primaryColumnId
          ? tvm.getOrder(tvm.primaryColumnId)
          : undefined;

        for (const [columnId, $cell] of this.cells) {
          const isPrimary = columnId === tvm.primaryColumnId;
          const columnOrder = tvm.getOrder(columnId);
          const isPrePrimary = primaryOrder != null &&
            columnOrder != null &&
            columnOrder < primaryOrder;

          $cell.classList.toggle("primary", isPrimary);
          $cell.classList.toggle("pre-primary", isPrePrimary);
          $cell.classList.toggle("post-primary", !isPrimary && !isPrePrimary);

          const width = tvm.getWidthOpt(columnId);
          $cell.style.width = isPrePrimary && width ? `${width}px` : "";
        }

        this.$root.style.width = "";
        this.style.width = "";
      } else {
        for (const [columnId, $cell] of this.cells) {
          const colSpec = tvm.getSpec(columnId);
          const width = tvm.getWidthOpt(columnId);
          const xPos = tvm.getPosition(columnId) ?? 0;

          $cell.classList.remove("primary", "pre-primary", "post-primary");
          $cell.style.width = width ? `${width}px` : "";
          $cell.style.height = colSpec?.alignSelf === "stretch" ? "100%" : "";
          $cell.style.alignSelf = colSpec?.alignSelf ?? "";
          $cell.style.setProperty(
            "--default-transform",
            `translateX(${xPos}px)`,
          );
        }

        const marginTotal = tvm.style.containerMarginInline * 2;
        this.$root.style.width = `${tvm.viewportWidth}px`;
        this.style.width = `${tvm.viewportWidth + marginTotal}px`;
      }

      for (const [columnId, _$cell] of this.cells) {
        const colSpec = tvm.getSpec(columnId);
        const $content = this.cellContents.get(columnId);
        if (!colSpec?.layout || !$content) continue;
        colSpec.layout($content, tvm.style.layout);
      }
    }

    static $styles: Style.Compat[] = [
      Typography.$maxLines,
      css`
        :host {
          display: block;
          position: relative;
          width: max-content;
          min-width: 100%;
          min-height: var(--height);
        }

        :host([reorderable]) {
          user-select: none;
        }

        :host(:hover) #root,
        :host([context-menu-open]) #root {
          background: var(--bg-hover);
          border-radius: 8px;
        }

        :host([selected]) #root {
          background: var(--bg-surface-light);
          border-radius: 8px;
        }

        :host([show-divider]) {
          margin-bottom: 3px;
        }

        :host([show-divider]:not([inline]):not(:last-child)) #root::after {
          content: "";
          position: absolute;
          bottom: -2.5px;
          left: 0px;
          right: 0px;
          height: 1px;
          background-color: var(--divider);
        }

        #root {
          position: relative;
          min-height: var(--height);
          margin-inline: var(--container-margin-inline);
        }

        :host([inline]) #root {
          display: flex;
        }

        ::slotted(.cell) {
          position: absolute;
          top: 0;
          left: 0;
          min-height: var(--height);
          box-sizing: border-box;
          padding-inline: var(--cell-padding);
          display: flex;
          align-items: center;
          overflow: hidden;
          transform: var(--default-transform, none);
        }

        ::slotted(.cell)::before {
          position: absolute;
          inset: 0;
          content: "";
          background: red;
          border-radius: 8px;
          background: var(--bg-hover);
          opacity: var(--debug-table-bg-opacity, 0);
          pointer-events: none;
        }

        :host([inline]) ::slotted(.cell) {
          position: relative;
          top: auto;
          left: auto;
          transform: none;
        }

        :host([inline]) ::slotted(.cell.primary) {
          flex: 1;
        }

        :host([inline]) ::slotted(.cell.pre-primary) {
          flex: none;
        }

        :host([inline]) ::slotted(.cell.post-primary) {
          flex: none;
        }

        #floating-button-anchor {
          --resolved-size: calc(max(min(var(--height) - 12px, 28px), 20px));
          position: sticky;
          right: calc(var(--container-margin-inline, 0px) + 8px);
          width: 0px;
          height: var(--resolved-size);
          z-index: 10;
          pointer-events: auto;
          margin-left: auto;
          transform: translateY(calc((var(--height) - var(--resolved-size)) / 2));
          opacity: 0;
          cursor: pointer;
        }

        #floating-button {
          position: absolute;
          top: 0px;
          right: 0px;
          height: var(--resolved-size);
          width: var(--resolved-size);
          background: var(--bg);
          box-shadow: var(--box-shadow-light);
          z-index: 99;
          border-radius: 4px;
        }

        :host(:hover) #floating-button-anchor,
        :host([context-menu-open]) #floating-button-anchor {
          opacity: 1;
        }

        #floating-button:hover {
          background: var(--bg-hover-opaque);
        }

        /* Inline expandable detail (a shadow sibling of #root, so it stacks
           below the cell band and grows the row without touching the row-host
           sibling structure the dividers key off). */
        .detail {
          height: 0;
          overflow: hidden;
          box-sizing: border-box;
          width: calc(100% - 2 * var(--container-margin-inline));
          max-width: calc(100% - 2 * var(--container-margin-inline));
          margin-inline: var(--container-margin-inline);
        }

        :host([expanded]) #root {
          background: var(--bg-hover);
          border-radius: 8px 8px 0 0;
        }

        :host([expanded]) #root::after {
          display: none;
        }
      `,
    ];

    static $html: Option<HTMLTemplateElement> = html`
      <div id="root">
        <slot></slot>
        <div id="floating-button-anchor">
          <std-center id="floating-button"></std-center>
        </div>
      </div>
      <div id="detail" class="detail"><div id="detail-body" class="detail-body"></div></div>
    `;
  }
}
