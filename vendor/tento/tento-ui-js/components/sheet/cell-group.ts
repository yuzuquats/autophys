import { Month, NaiveDate, Weekday } from "@tento-chrono";
import { html, LonaWebComponent } from "@tento-ui/component";
import { Center } from "@tento-ui/component-builtin";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { DomUtils } from "@tento-ui/dom";
import { $$ } from "@tento-ui/fastdom";
import { LazySync } from "@tento-ui/lazy";
import { Typography } from "@tento-ui/ui/typography";
import { Scrollbars } from "@tento-ui/components/scrollbars";
import { FractionLabel } from "@tento-ui/components/fraction-label";
import { SheetCell } from "./sheet-cell";

/**
 * Reusable tooltip component for cell group date labels.
 * Handles positioning relative to an anchor element and a reference container.
 */
@component({ name: "std-cell-group-tooltip" })
export class CellGroupTooltip extends LonaWebComponent {
  private $currentAnchor: Option<HTMLElement>;

  /**
   * Show tooltip positioned relative to anchor, within reference bounds.
   */
  show(
    $anchor: HTMLElement,
    tooltip: { title: string; subtitle: Option<string> },
    $reference: HTMLElement,
  ): void {
    this.$currentAnchor = $anchor;

    // Phase-split so the rect reads never force a synchronous style+layout
    // flush mid-scroll (this fires from pointerenter while a frame's worth of
    // column binds is queued). The rects are of the anchor/reference, not of
    // this tooltip, so reading before the content writes is sound; the
    // tooltip fades in over 300ms, so one frame of positioning latency is
    // invisible.
    $$.measure(() => {
      if (this.$currentAnchor !== $anchor) return;
      const ar = $anchor.getBoundingClientRect();
      const pr = $reference.getBoundingClientRect();
      $$.mutate(() => {
        if (this.$currentAnchor !== $anchor) return;
        DomUtils.clearChildren(this);
        this.appendChild(
          Typography.p(tooltip.title).assignStyles({
            "--font-size": "var(--text-8px)",
          }),
        );
        if (tooltip.subtitle) {
          this.appendChild(
            Typography.p(tooltip.subtitle).assignStyles({
              "--font-size": "var(--text-8px)",
            }),
          );
        }
        const x = ar.right - pr.left + 2;
        const y = ar.top - pr.top;
        this.style.transform = `translate(${x}px, ${y}px)`;
        this.style.opacity = "1";
        this.style.height = Math.min(36, ar.height) + "px";
      });
    });
  }

  /**
   * Hide tooltip if it was shown for this anchor.
   */
  hide($anchor: HTMLElement): void {
    if (this.$currentAnchor !== $anchor) return;
    this.$currentAnchor = null;
    this.style.opacity = "0";
  }

  static $styles = [
    css`
      :host {
        position: absolute;
        top: 0;
        left: 0;
        background: var(--bg-tooltip);
        color: var(--fg-tooltip);
        padding: 4px 12px;
        border-radius: 8px;
        pointer-events: none;
        z-index: 1;
        opacity: 0;
        transition: opacity 0.3s ease;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
      }
    `,
  ];

  static $html = html`<slot></slot>`;
}

/**
 * Container for multiple sheet cells when rendering stacked layout.
 * Used when row timescale < sheet timescale (e.g., day cells in a week column).
 *
 * Layout structure:
 * - Vertical stack (column) of SheetCell wrappers
 * - Each SheetCell contains a plugin cell
 * - Fixed height cells with optional scrolling
 * - Includes space for "see more" UI at bottom
 */
@component({
  name: "std-cell-group",
})
export class CellGroup extends LonaWebComponent {
  private cells: SheetCell[] = [];
  private config: Option<CellGroup.Config>;
  private $labelContainers: HTMLElement[] = [];

  bind(cells: SheetCell[], config: CellGroup.Config): this {
    this.cells = cells;
    this.config = config;

    const $container = this.$("container");

    // Reconcile children instead of clear+rebuild.
    // Cells are often the same SheetCell elements in the same order.
    const existing = [...$container.children];
    let needsReconcile = existing.length !== cells.length;
    if (!needsReconcile) {
      for (let i = 0; i < cells.length; i++) {
        if (existing[i] !== cells[i]) { needsReconcile = true; break; }
      }
    }
    if (needsReconcile) {
      DomUtils.clearChildren($container);
      for (let i = 0; i < cells.length; i++) {
        $container.appendChild(cells[i]);
      }
    }

    for (let i = 0; i < cells.length; i++) {
      cells[i].assignStyles({
        "--height": config.individualCellHeight + "px",
      });
    }

    this.bindSeeMore(config);
    this.bindLabels(null);
    return this;
  }

  /**
   * Bind cell heights and visibility without full rebind.
   * Called when row height changes dynamically (e.g., via resize handle).
   */
  bindConfig(config: CellGroup.Config): void {
    if (!this.config) return;
    this.config = config;

    for (const $sheetCell of this.cells) {
      $sheetCell.assignStyles({
        "--height": config.individualCellHeight + "px",
      });
    }

    this.bindSeeMore(config);

    for (const $c of this.$labelContainers) {
      $c.style.height = config.individualCellHeight - 2 + "px";
    }
  }

  private bindSeeMore(config: CellGroup.Config): void {
    const $seeMore = this.$("see-more");
    const $seeMoreText = this.$("see-more-text");
    const hiddenCount = config.totalCells - config.visibleCellCount;
    if (hiddenCount > 0 && config.seeMoreHeight > 0) {
      $seeMoreText.textContent = `+${hiddenCount} more`;
      $seeMore.style.display = "flex";
      $seeMore.style.height = config.seeMoreHeight + "px";
    } else {
      $seeMore.style.display = "none";
      $seeMore.style.height = "0px";
    }
  }

  size: Option<Size>;
  // Per-slot identity of currently-rendered label containers, parallel
  // to `$labelContainers`. Used by `bindLabels` to diff against the new
  // cell list and only swap label DOM where state actually changed —
  // avoids tearing down + recreating every FractionLabel on each bind.
  private _labelStates: CellGroup.LabelState[] = [];
  private bindLabels(size: Option<Size>): void {
    const unchanged =
      this.size != null &&
      size &&
      Math.abs(this.size.width - size.width) < Number.EPSILON &&
      Math.abs(this.size.height - size.height) < Number.EPSILON;
    if (unchanged) return;

    this.size = size;

    const $dateLabels = this.$("date-labels");
    const containerHeight = this.config!.individualCellHeight - 2 + "px";
    const nextStates: CellGroup.LabelState[] = [];
    const nextContainers: HTMLElement[] = [];

    for (let i = 0; i < this.cells.length; i++) {
      const $sheetCell = this.cells[i];
      const cellId = $sheetCell.cellId;
      const pd = cellId?.col?.pd;
      if (!pd) continue;

      const want: CellGroup.LabelState = {
        pdKey: pd.toString(),
        inThePast: $sheetCell.hasAttribute("in-the-past"),
        isCurrent: $sheetCell.hasAttribute("is-current"),
      };

      const slot = nextContainers.length;
      const existing = this.$labelContainers[slot] as Option<HTMLElement>;
      const existingState = this._labelStates[slot];
      if (
        existing &&
        existingState &&
        existingState.pdKey === want.pdKey &&
        existingState.inThePast === want.inThePast &&
        existingState.isCurrent === want.isCurrent
      ) {
        // Reuse — config height may have changed since last bind.
        existing.style.height = containerHeight;
        nextContainers.push(existing);
        nextStates.push(existingState);
        continue;
      }

      // A new week changes the dates, not the day-label presentation. Keep
      // its shadow tree and ResizeObserver instead of constructing them again.
      const $label = existing?.firstElementChild;
      if (
        existing && existingState && pd.type === "day" &&
        $label instanceof FractionLabel &&
        existingState.inThePast === want.inThePast &&
        existingState.isCurrent === want.isCurrent
      ) {
        this.$tooltip.maybeGet()?.hide(existing);
        $label.bind(String(pd.mth), String(pd.day), 12);
        this.bindLabelContainer(existing, $label, pd, want, containerHeight);
        nextContainers.push(existing);
        nextStates.push(want);
        continue;
      }

      const $c = this.makeLabelContainer(pd, want, containerHeight);
      if (existing) {
        $$.mutate(() => existing.replaceWith($c));
      } else {
        $$.mutate(() => $dateLabels.appendChild($c));
      }
      nextContainers.push($c);
      nextStates.push(want);
    }

    // Trim excess containers if the cell list shrank.
    for (let i = nextContainers.length; i < this.$labelContainers.length; i++) {
      const $stale = this.$labelContainers[i];
      $$.mutate(() => $stale.remove());
    }

    this.$labelContainers = nextContainers;
    this._labelStates = nextStates;
  }

  private makeLabelContainer(
    pd: NaiveDate.Partial,
    state: CellGroup.LabelState,
    containerHeight: string,
  ): HTMLElement {
    const $c = Center.make();
    $c.classList.add("date-label-container");
    const $label = CellGroup.$dateLabel(pd);
    this.bindLabelContainer($c, $label, pd, state, containerHeight);
    $c.appendChild($label);
    return $c;
  }

  private bindLabelContainer(
    $c: HTMLElement,
    $label: HTMLElement,
    pd: NaiveDate.Partial,
    state: CellGroup.LabelState,
    containerHeight: string,
  ): void {
    const { inThePast, isCurrent } = state;
    $c.assignStyles({
      height: containerHeight,
      background: isCurrent
        ? "var(--fg-icon-pri-fill)"
        : inThePast
          ? "var(--bg-hover-very-light)"
          : "var(--bg-surface-light)",
    });
    $label.style.color = isCurrent ? "white" : "";
    if (isCurrent) {
      $label.style.setProperty("--label-color", "white");
    } else {
      $label.style.removeProperty("--label-color");
    }
    const tooltipText = CellGroup.tooltipText(pd);
    $c.onpointerenter = () => this.showTooltip($c, tooltipText);
    $c.onpointerleave = () => this.hideTooltip($c);
  }

  private $tooltip = new LazySync(() => {
    const $t = CellGroupTooltip.make();
    this.$("container-root").appendChild($t);
    return $t;
  });

  private showTooltip(
    $anchor: HTMLElement,
    tooltip: { title: string; subtitle: Option<string> },
  ): void {
    this.$tooltip.get().show($anchor, tooltip, this.$("container-root"));
  }

  private hideTooltip($anchor: HTMLElement): void {
    this.$tooltip.get().hide($anchor);
  }

  rebindLabels(): void {
    this.size = null; // Reset size to force updateLabels to re-render
    this.bindLabels(null);
  }

  getCells(): HTMLElement[] {
    const pluginCells: HTMLElement[] = [];
    for (const $sheetCell of this.cells) {
      const $content = $sheetCell.$content;
      if (!$content || $content instanceof CellGroup) continue;
      pluginCells.push($content);
    }
    return pluginCells;
  }

  getSubcells(): SheetCell[] {
    return this.cells;
  }

  set onFocusCell(handler: Option<(id: SheetCell.CellId) => void>) {
    for (const $cell of this.cells) {
      $cell.onFocusCell = handler;
    }
  }

  set onBlurCell(handler: Option<(id: SheetCell.CellId) => void>) {
    for (const $cell of this.cells) {
      $cell.onBlurCell = handler;
    }
  }

  static $styles = [
    Scrollbars.$hideScrollbars,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        overflow: visible;
      }

      #container-root {
        flex-grow: 1;
        overflow: visible;
        position: relative;
      }

      #date-labels {
        flex-shrink: 0;
        width: auto;
        min-width: 0;
        overflow: hidden;
      }

      .date-label {
        --font-size: var(--text-8px);
        color: var(--text-sec);
      }

      #container {
        flex-grow: 1;
        overflow: visible;
        width: 1px;
      }

      #container > std-sheet-cell {
        flex-shrink: 0;
        box-sizing: border-box;
      }

      .date-label-container {
        width: 40px;
        margin: 1px 0px 1px 3px;
        border-radius: 8px;
      }

      .see-more {
        display: none;
        flex-shrink: 0;
        color: var(--text-ter);
        background: var(--bg-surface-light);
        cursor: pointer;
        user-select: none;
        margin-top: 1px;
        margin-inline: 2px;
        border-radius: 8px;
      }

      .see-more:hover {
        background: var(--divider);
      }
    `,
  ];

  static $html = html`
    <std-row id=container-root>
      <std-col id=date-labels></std-col>
      <std-col id="container" class="cell-container"></std-col>
    </std-row>
    <std-center id="see-more" class="see-more"><p id=see-more-text class=small></p></std-center>
  `;
}

export namespace CellGroup {
  export interface Config {
    individualCellHeight: number;
    visibleCellCount: number;
    seeMoreHeight: number;
    totalCells: number;
  }

  /** Per-slot identity used by `bindLabels` to diff existing label
   *  DOM against the new cell list and only swap what changed. */
  export interface LabelState {
    pdKey: string;
    inThePast: boolean;
    isCurrent: boolean;
  }

  export function $singleTextContent(s: string): HTMLElement {
    const $label = Typography.small(s);
    $label.classList.add("date-label");
    return $label;
  }

  export function $dateLabel(pd: NaiveDate.Partial): HTMLElement {
    switch (pd.type) {
      case "year":
        return $singleTextContent(String(pd.yr));
      case "month":
        return $singleTextContent(Month.MONTHS0[pd.mth! - 1].shortName);
      case "day":
        return FractionLabel.makeWith(String(pd.mth!), String(pd.day), 12);
      case "week": {
        return $singleTextContent("W" + String(pd.wno));
      }
    }
  }

  export function $dateLabelContainer(
    pd: NaiveDate.Partial,
    heightPx: number,
    inThePast: boolean,
    isCurrent: boolean,
  ): HTMLElement {
    const $c = Center.make().assignStyles({
      height: heightPx - 2 + "px",
      // width: Math.min(48, Math.max(40, heightPx)) + "px",
      width: 40 + "px",
      background: isCurrent
        ? "var(--fg-icon-pri-fill)"
        : inThePast
          ? "var(--bg-hover-very-light)"
          : "var(--bg-surface-light)",
      margin: "1px",
      marginLeft: "3px",
      marginRight: "0px",
      borderRadius: "8px",
      flexShrink: "0",
    });
    const $label = $dateLabel(pd);
    if (isCurrent) {
      $label.style.color = "white";
      $label.style.setProperty("--label-color", "white");
    }
    $c.appendChild($label);
    return $c;
  }

  export function tooltipText(pd: NaiveDate.Partial): {
    title: string;
    subtitle: Option<string>;
  } {
    switch (pd.type) {
      case "year":
        return {
          title: String(pd.yr),
          subtitle: null,
        };
      case "month":
        return {
          title: `${Month.MONTHS0[pd.mth! - 1].name} ${pd.yr}`,
          subtitle: null,
        };
      case "day": {
        const date = pd.start;
        const dayName = Weekday.WEEKDAY_FULL[date.dayOfWeek.dow - 1];
        return {
          title: `${Month.MONTHS0[pd.mth! - 1].name} ${pd.day}, ${pd.yr}`,
          subtitle: dayName,
        };
      }
      case "week": {
        const start = pd.start;
        const end = pd.end.addDays(-1);
        const startStr = `${Month.MONTHS0[start.mth - 1].shortName} ${start.day1}`;
        const endStr = `${Month.MONTHS0[end.mth - 1].shortName} ${end.day1}`;
        return {
          title: `Week ${pd.wno}, ${pd.yr}`,
          subtitle: `${startStr} – ${endStr}`,
        };
      }
    }
  }

  @component({ name: "std-cell-group-row" })
  export class Row extends LonaWebComponent {
    private $cell: SheetCell = this.hydrate("cell");

    private $tooltip = new LazySync(() => {
      const $t = CellGroupTooltip.make();
      this.shadowRoot!.appendChild($t);
      return $t;
    });

    private showTooltip(
      $anchor: HTMLElement,
      tooltip: { title: string; subtitle: Option<string> },
    ): void {
      this.$tooltip.get().show($anchor, tooltip, this);
    }

    private hideTooltip($anchor: HTMLElement): void {
      this.$tooltip.get().hide($anchor);
    }

    bind(props: Row.Props): void {
      // Update label container
      const $labelSlot = this.$("label-slot");
      DomUtils.clearChildren($labelSlot);
      const $labelContainer = $dateLabelContainer(
        props.pd,
        props.cellHeightPx,
        props.inThePast,
        props.isCurrent,
      );

      // Wire up tooltip events
      const tooltipText = CellGroup.tooltipText(props.pd);
      $labelContainer.onpointerenter = () =>
        this.showTooltip($labelContainer, tooltipText);
      $labelContainer.onpointerleave = () => this.hideTooltip($labelContainer);

      $labelSlot.appendChild($labelContainer);

      // Bind cell content
      this.$cell.bindContent(props.rowType, props.$content);
      this.$cell.setId(props.cellId);
      this.$cell.bindLayout(props.layout, props.inThePast, props.isCurrent);
    }

    /**
     * Update heights during drag resize without full rebind.
     */
    bindHeight(cellHeightPx: number): void {
      this.$cell.bindHeight(cellHeightPx);
      const $labelContainer = this.$("label-slot").firstElementChild as Option<HTMLElement>;
      if ($labelContainer) {
        $labelContainer.style.height = cellHeightPx - 2 + "px";
      }
    }

    get cell(): SheetCell {
      return this.$cell;
    }

    set onFocusCell(handler: Option<(id: SheetCell.CellId) => void>) {
      this.$cell.onFocusCell = handler;
    }

    set onBlurCell(handler: Option<(id: SheetCell.CellId) => void>) {
      this.$cell.onBlurCell = handler;
    }

    static $styles = [
      css`
        :host {
          display: flex;
          flex-direction: row;
          align-items: center;
          position: relative;
        }

        #label-slot {
          flex-shrink: 0;
        }

        #cell {
          flex: 1;
          min-width: 0;
        }
      `,
    ];

    static $html = html`
      <div id="label-slot"></div>
      <std-sheet-cell id="cell"></std-sheet-cell>
    `;
  }

  export namespace Row {
    export interface Props {
      pd: NaiveDate.Partial;
      cellHeightPx: number;
      inThePast: boolean;
      isCurrent: boolean;
      rowType: string;
      $content: HTMLElement;
      cellId: SheetCell.CellId;
      layout: SheetCell.Layout;
    }
  }
}
