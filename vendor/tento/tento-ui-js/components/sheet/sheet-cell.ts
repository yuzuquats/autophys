import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { DomUtils } from "@tento-ui/dom";
import { $$ } from "@tento-ui/fastdom";
import { ColumnIndex } from "@tento-ui/components/sheet/column-index";
import type { BindGeneration } from "@tento-scroll/engine/scroll-engine";
import { CachedHeightPx, MeasuredHeightPx } from "./cell-height";
import { CellGroup } from "./cell-group";
import { DebugAttributes } from "./debug-attributes";
import {
  CellLayout as CellLayoutSdk,
  CellLayoutOptions as CellLayoutOptionsSdk,
} from "./cell-layout";

export interface ColumnTimeState {
  inThePast: boolean;
  isCurrent: boolean;
}

@component({
  name: "std-sheet-cell",
})
export class SheetCell<
  ID = { row: unknown; col: ColumnIndex.Key.Resolved.Default },
> extends LonaWebComponent {
  #presentationGeneration = 0;
  #recyclePending = false;

  /** Identifies this pooled cell's current presentation lifetime. */
  get presentationGeneration(): number {
    return this.#presentationGeneration;
  }

  contentType: Option<string>;
  $content: Option<HTMLElement | CellGroup>;
  cellId: Option<ID>;
  /**
   * The CACHED height — what the last `bindHeight` WROTE, mirrored to
   * `--height`. Not an observation: the scrub and `SheetColumn.onRecycle` zero
   * it out of band, and nothing here re-reads the DOM. Read it through
   * {@link SheetCell.cachedHeight} (branded {@link CachedHeightPx}) so a
   * consumer entitled to the PIXELS cannot silently settle for this instead;
   * the raw field stays a `number` because the two out-of-band zero writers
   * live in files this seam does not own.
   */
  height: Option<number>;

  // The bind generation whose CONTENT this cell currently holds. Stamped in the
  // drain (default-binder.applyPlanFullRebind) once content is bound; compared in
  // Sheet.rebindCellHeights to skip cross-generation cells (the stretch guard).
  boundGeneration: Option<BindGeneration>;

  // Track structural fingerprint for recycling decisions
  private isStacked: boolean = false;
  private stackedCellCount: number = 0;

  onFocusCell: Option<(id: ID) => void>;
  private onFocusCellHandler = (e: FocusEvent) => {
    // Stop propagation if this cell handles the event (prevents parent cells from also handling)
    if (this.cellId && this.onFocusCell) {
      e.stopPropagation();
      this.onFocusCell(this.cellId);
    }
  };

  onBlurCell: Option<(id: ID) => void>;
  private onBlurCellHandler = (e: FocusEvent) => {
    // Stop propagation if this cell handles the event (prevents parent cells from also handling)
    if (this.cellId && this.onBlurCell) {
      e.stopPropagation();
      this.onBlurCell(this.cellId);
    }
  };

  constructor() {
    super();
    this.addEventListener("focusin", this.onFocusCellHandler);
    this.addEventListener("focusout", this.onBlurCellHandler);
  }

  recycle(): void {
    if (this.#recyclePending) return;
    this.#recyclePending = true;
    this.#presentationGeneration++;
    super.recycle();
  }

  onRecycle(): void {
    super.onRecycle();
    this.#recyclePending = false;
    this.#presentationGeneration++;
    this.height = null;
    this.boundGeneration = null;
  }

  setId(id: ID) {
    this.cellId = id;
  }

  /**
   * Bind ARIA attributes for screen reader accessibility.
   * @param colIndex 1-based column index (aria-colindex is 1-based)
   * @param rowIndex 1-based row index (aria-rowindex is 1-based)
   * @param ariaLabel Accessible label describing the cell content
   */
  bindAriaAttributes(
    colIndex: number,
    rowIndex: number,
    ariaLabel: Option<string>,
  ): void {
    // Diffed: this runs per cell per full rebind, and the values are stable
    // for a cell that kept its slot — identical-value writes still dirty.
    DomUtils.assignAttributes(this, {
      role: "gridcell",
      "aria-colindex": String(colIndex),
      "aria-rowindex": String(rowIndex),
      "aria-label": ariaLabel ?? null,
    });
  }

  /**
   * Update just the aria-colindex during virtualization rebind.
   * More efficient than full rebind when only column changes.
   */
  updateAriaColIndex(colIndex: number): void {
    this.setAttribute("aria-colindex", String(colIndex));
  }

  /**
   * Update the aria-label with new content description.
   */
  updateAriaLabel(ariaLabel: Option<string>): void {
    if (ariaLabel) {
      this.setAttribute("aria-label", ariaLabel);
    } else {
      this.removeAttribute("aria-label");
    }
  }

  bindContent(contentType: string, $content: HTMLElement | CellGroup) {
    this.contentType = contentType;
    this.$content = $content;

    // Update structural fingerprint
    this.isStacked = $content instanceof CellGroup;
    this.stackedCellCount = this.isStacked
      ? ($content as CellGroup).getCells().length
      : 0;
    this.toggleAttribute("stacked-row", this.isStacked);

    $$.mutate(() => {
      this.clearChildren();
      this.appendChild($content);
    });
  }

  /**
   * Get the list of plugin cells that need to be bound/updated.
   * Returns a single cell for normal mode, or array of cells for stacked mode.
   */
  getPluginCells(): HTMLElement[] {
    if (!this.$content) return [];

    // Check if content is a CellGroup
    if (this.$content instanceof CellGroup) {
      return this.$content.getCells();
    }

    // Normal mode: return the single content cell
    return [this.$content];
  }

  /**
   * Check if recycling this cell would require structural changes.
   * Returns true if the cell structure (stacked vs scalar, or cell count) differs.
   */
  needsStructureChange(stacked: boolean, cellCount: number): boolean {
    if (stacked !== this.isStacked) return true;
    if (stacked && cellCount !== this.stackedCellCount) return true;
    return false;
  }

  /**
   * Apply span mode declaratively via attributes and CSS custom properties.
   * CSS handles the actual styling based on these attributes.
   */
  applySpanMode(mode: SheetCell.SpanMode): void {
    switch (mode.type) {
      case "none":
        this.removeAttribute("data-span-mode");
        this.style.removeProperty("--span-width");
        this.style.removeProperty("--span-offset");
        break;

      case "hidden":
        this.setAttribute("data-span-mode", "hidden");
        this.style.removeProperty("--span-width");
        this.style.removeProperty("--span-offset");
        break;

      case "owner":
        this.setAttribute("data-span-mode", "owner");
        this.style.setProperty("--span-width", `${mode.widthPx}px`);
        this.style.setProperty("--span-offset", `-${mode.offsetPx}px`);
        break;
    }
  }

  /**
   * Reset all spanning-related styles and attributes.
   * Called when a cell transitions out of spanned mode.
   */
  resetSpanningStyles(): void {
    this.applySpanMode({ type: "none" });
    // Clear debug attributes via centralized namespace
    DebugAttributes.clearSpanDebug(this);
  }

  /**
   * Apply all styling to this cell in one call.
   * Consolidates attribute changes and CSS property updates.
   */
  applyStyles(styles: SheetCell.Styling): void {
    // Handle hidden state
    this.toggleAttribute("hidden", styles.hidden);
    this.style.setProperty("display", styles.hidden ? "none" : "block");

    if (styles.hidden) {
      return;
    }

    // Apply span mode
    this.applySpanMode(styles.spanMode);

    // Apply height
    this.bindHeight(styles.height);

    // Apply layout options with time state
    if (styles.layoutOptions) {
      this.bindLayoutOptions(
        styles.layoutOptions,
        styles.timeState.inThePast,
        styles.timeState.isCurrent,
      );
    }
  }

  bindLayout(
    layout: SheetCell.Layout,
    inThePast: boolean,
    isCurrent: boolean = false,
  ) {
    this.bindLayoutOptions(layout.options ?? {}, inThePast, isCurrent);
    this.bindHeight(layout.cellHeightPx);
  }

  bindLayoutOptions(
    layout: SheetCell.LayoutOptions,
    inThePast: boolean,
    isCurrent: boolean = false,
  ) {
    const $root = this.$("root");
    DomUtils.assignAttributes(this, {
      "has-border": (layout.canDrawCardBorder ?? false) && !inThePast,
      "draw-vertical-divider": layout.drawVerticalDivider ?? false,
      card: layout.card ?? true,
      "in-the-past": inThePast,
      "is-current": isCurrent,
      "no-contain": layout.disableContainment ?? false,
    });
    $root.assignStyles({
      "--cell-background":
        layout.background ??
        (!inThePast ? "var(--bg-surface-light)" : "var(--bg-hover-very-light)"),
      "--margin-block": layout.marginBlock ?? "",
      "--margin-inline": layout.marginInline ?? "",
    });
  }

  bindHeight(height: number) {
    if (this.height === height) return;
    this.height = height;
    this.style.setProperty("--height", height + "px");
  }

  /**
   * CACHED — what the last bind wrote, branded. `null` for a cell that has
   * never been bound, or one that a recycle reset. Free to read; says nothing
   * about the pixels.
   */
  get cachedHeight(): Option<CachedHeightPx> {
    return CachedHeightPx.ofOption(this.height);
  }

  /**
   * MEASURED — what the DOM says right now. FORCES LAYOUT: call it only where
   * layout is already being read (the reveal contract, the header sweep's
   * `$$.measure` pass), never on a per-cell bind path.
   */
  measuredHeight(): MeasuredHeightPx {
    return MeasuredHeightPx.of(this.getBoundingClientRect().height);
  }

  /**
   * Bind CellGroup configuration when stackingInfo changes.
   * Called by rebindCellHeights() when row heights change dynamically.
   */
  bindStackingConfig(stackingInfo: SheetCell.Layout["stackingInfo"]): void {
    if (!stackingInfo || !(this.$content instanceof CellGroup)) return;

    this.$content.bindConfig({
      individualCellHeight: stackingInfo.individualCellHeight,
      visibleCellCount: stackingInfo.visibleCellCount,
      seeMoreHeight: stackingInfo.seeMoreHeight,
      totalCells: stackingInfo.cellsPerColumn,
    });
  }

  /**
   * Efficiently reconcile children in a parent element to match desired order.
   * Keeps the focused retained cell connected by reordering its siblings.
   */
  static reconcileChildren($parent: HTMLElement, desiredChildren: SheetCell[]) {
    const currentChildren = Array.from($parent.children) as SheetCell[];

    // Create a map of current children for efficient lookup
    const currentChildrenSet = new Set(currentChildren);

    // Track which children should be in the parent
    const desiredChildrenSet = new Set(desiredChildren);
    const $focusedChild = currentChildren.find(($child) =>
      desiredChildrenSet.has($child) && $child.matches(":focus-within"));

    // Remove children that shouldn't be there
    for (const child of currentChildren) {
      if (!desiredChildrenSet.has(child)) {
        $parent.removeChild(child);
      }
    }

    // Insert or reorder children to match desired order
    let expectedNextSibling: ChildNode | null = $parent.firstChild;

    for (const child of desiredChildren) {
      // Moving the active cell would blur its native editor even if its view survives.
      if (child === $focusedChild && child.parentElement === $parent) {
        expectedNextSibling = child.nextSibling;
        continue;
      }
      const isNewChild = !currentChildrenSet.has(child);

      if (isNewChild) {
        // Insert new child in correct position
        if (expectedNextSibling) {
          $parent.insertBefore(child, expectedNextSibling);
        } else {
          $parent.appendChild(child);
        }
        expectedNextSibling = child.nextSibling;
      } else {
        // Only move if it's not already in the correct position
        if (child !== expectedNextSibling) {
          if (expectedNextSibling) {
            $parent.insertBefore(child, expectedNextSibling);
          } else {
            $parent.appendChild(child);
          }
        }
        // Update expected position for next iteration
        expectedNextSibling = child.nextSibling;
      }
    }
  }

  static $styles = [
    css`
      :host {
        display: block;
        height: var(--height);
        contain: layout paint;
      }

      :host([no-contain]) {
        contain: none;
      }

      /* Span mode: hidden (non-owner cells or static child mode) */
      :host([data-span-mode="hidden"]) {
        opacity: 0;
        pointer-events: none;
      }

      /* Span mode: owner (cell owns the span period) */
      :host([data-span-mode="owner"]) {
        width: var(--span-width);
        transform: translateX(var(--span-offset));
      }

      #root {
        position: relative;
        height: calc(var(--height) - calc(2 * var(--vertical-margin, 0px)));
        margin-block: var(--margin-block, 0px);
        margin-inline: var(--margin-inline, 1px);
        border-radius: 8px;
      }

      :host([has-border]) #root:after {
        pointer-events: none;
        position: absolute;
        content: "";
        inset: 0;
        border: 1px solid var(--divider);
      }

      :host([stacked-row]),
      :host([data-span-mode="owner"]) {
        --cell-loading-shimmer-inset-x: 2px;
      }

      :host([card]) #root::before {
        position: absolute;
        content: "";
        inset: 1px 2px;
        background: var(--cell-background);
        border-radius: 8px;
        pointer-events: none;
      }

     :host([draw-vertical-divider]) #root::after {
        content: "";
        position: absolute;
        inset: 0px;
        right: -0.5px;
        z-index: 1;
        pointer-events: none;
        border-right: 1px solid #ddd;
      }

      slot[name="decoration"]::slotted(*) {
        position: absolute;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <slot name="decoration"></slot>
      <slot></slot>
    </std-col>
  `;
}

export namespace SheetCell {
  export type CellId = {
    row: unknown;
    col: ColumnIndex.Key.Resolved.Default;
  };

  /**
   * Declarative span mode for CSS-based styling.
   * - none: Normal rendering, no spanning
   * - hidden: Cell is hidden (non-owner or static child mode)
   * - owner: Cell owns the span period, positioned with width/offset
   */
  export type SpanMode =
    | { type: "none" }
    | { type: "hidden" }
    | { type: "owner"; widthPx: number; offsetPx: number };

  export type LayoutOptions = CellLayoutOptionsSdk;
  export const LayoutOptions = CellLayoutOptionsSdk;

  export type Layout = CellLayoutSdk;
  export const Layout = CellLayoutSdk;

  /**
   * Unified styling interface for declarative cell styling.
   * Groups all styling concerns in one place for clearer code and easier debugging.
   */
  export interface Styling {
    /** Whether the cell should be hidden (no layout) */
    hidden: boolean;
    /** CSS span mode for positioning */
    spanMode: SpanMode;
    /** Temporal state relative to current time */
    timeState: ColumnTimeState;
    /** Cell height in pixels */
    height: number;
    /** Layout options for card styling */
    layoutOptions: Option<LayoutOptions>;
  }
}
