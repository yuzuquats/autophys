import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";

@component({ name: "std-table-footer" })
export class TableFooter extends LonaWebComponent {
  private $itemCount: HTMLElement = this.$("item-count");
  private $pageNumbers: HTMLElement = this.$("page-numbers");
  private $prevButton: HTMLElement = this.$("prev-button");
  private $nextButton: HTMLElement = this.$("next-button");
  private $pageSizeLabel: HTMLElement = this.$("page-size-label");
  private $pageSizeSelect: HTMLSelectElement = this.$(
    "page-size-select",
  ) as HTMLSelectElement;

  private currentPage: number = 1;
  private pageSize: number = 25;
  private totalItems: number = 0;

  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;

  private lastWidth: number = 0;

  onSizeChange: Option<(s: Size) => void> = (s: Size) => {
    if (Math.abs(s.width - this.lastWidth) >= 1) {
      this.lastWidth = s.width;
      this.render();
    }
  };

  constructor() {
    super();
    this.$pageSizeSelect.addEventListener("change", () => {
      const newSize = Number.parseInt(this.$pageSizeSelect.value, 10);
      this.pageSize = newSize;
      this.currentPage = 1;
      this.render();
      this.onPageSizeChange?.(newSize);
    });
  }

  connectedCallback(): void {
    super.connectedCallback();

    GESTURE_MANAGER.addPointerEvent(this.$prevButton, {
      onClick: () => this.goToPage(this.currentPage - 1),
    });

    GESTURE_MANAGER.addPointerEvent(this.$nextButton, {
      onClick: () => this.goToPage(this.currentPage + 1),
    });

  }

  disconnectedCallback(): void {
    GESTURE_MANAGER.unregister(this.$prevButton);
    GESTURE_MANAGER.unregister(this.$nextButton);
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.onPageChange = undefined;
    this.onPageSizeChange = undefined;
    super.onRecycle();
  }

  bind(props: TableFooter.Props): this {
    this.currentPage = props.currentPage ?? 1;
    this.pageSize = props.pageSize ?? 25;
    this.totalItems = props.totalItems ?? 0;
    this.onPageChange = props.onPageChange;
    this.onPageSizeChange = props.onPageSizeChange;

    this.$pageSizeSelect.value = String(this.pageSize);
    this.render();
    return this;
  }

  private render(): void {
    const totalPages = Math.ceil(this.totalItems / this.pageSize);
    const start =
      this.totalItems === 0 ? 0 : (this.currentPage - 1) * this.pageSize + 1;
    const end = Math.min(this.currentPage * this.pageSize, this.totalItems);

    this.$itemCount.textContent = `${start}-${end} of ${this.totalItems}`;

    this.$prevButton.toggleAttribute("disabled", this.currentPage <= 1);
    this.$nextButton.toggleAttribute(
      "disabled",
      this.currentPage >= totalPages,
    );

    // Hide "Per page:" label at narrow widths
    const hideLabel = this.lastWidth > 0 && this.lastWidth < 480;
    this.$pageSizeLabel.style.display = hideLabel ? "none" : "";

    // Compute how many page-button slots fit
    const hostWidth = this.lastWidth || this.offsetWidth;
    const itemCountWidth = this.$itemCount.offsetWidth + 16; // + gap
    const fixedControlsWidth = 96 + 70 + 48; // prev/next ~96, select ~70, gaps ~48
    const labelWidth = hideLabel ? 0 : 72;
    const available = hostWidth - itemCountWidth - fixedControlsWidth - labelWidth;
    const maxSlots = Math.max(3, Math.min(7, Math.floor(available / 32)));

    this.renderPageNumbers(totalPages, maxSlots);
  }

  private renderPageNumbers(totalPages: number, maxSlots: number = 7): void {
    DomUtils.clearChildren(this.$pageNumbers);

    if (totalPages <= 0) return;

    const pages = this.getPageRange(totalPages, maxSlots);

    for (const page of pages) {
      if (page === "...") {
        const $ellipsis = Typography.p("...");
        $ellipsis.assignStyles({
          color: "var(--text-ter)",
          padding: "4px",
        });
        this.$pageNumbers.appendChild($ellipsis);
      } else {
        const $pageButton = document.createElement("button");
        $pageButton.className = "page-button";
        $pageButton.textContent = String(page);
        $pageButton.toggleAttribute("current", page === this.currentPage);
        GESTURE_MANAGER.addPointerEvent($pageButton, {
          onClick: () => this.goToPage(page as number),
        });
        this.$pageNumbers.appendChild($pageButton);
      }
    }
  }

  private getPageRange(
    totalPages: number,
    maxSlots: number = 7,
  ): (number | "...")[] {
    const pages: (number | "...")[] = [];
    const current = this.currentPage;

    if (totalPages <= maxSlots) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
      return pages;
    }

    if (maxSlots < 3) {
      pages.push(1);
      if (totalPages > 1) pages.push(totalPages);
      return pages;
    }

    if (maxSlots <= 4) {
      // [1] [current] [last] or [1] [...] [last]
      pages.push(1);
      if (current > 1 && current < totalPages) {
        pages.push(current);
      } else {
        pages.push("...");
      }
      if (maxSlots === 4 && current > 2 && current < totalPages) {
        pages.push("...");
      }
      pages.push(totalPages);
      return pages;
    }

    // maxSlots >= 5: [1] [...] [neighbors] [...] [last]
    pages.push(1);

    // Budget for neighbor pages: maxSlots - 2 (first + last) - up to 2 ellipses
    const neighborBudget = maxSlots - 2;

    // Determine neighbor window
    const halfWindow = Math.floor((neighborBudget - 2) / 2); // subtract 2 for potential ellipses
    const windowSize = halfWindow * 2 + 1;

    let start = Math.max(2, current - halfWindow);
    let end = Math.min(totalPages - 1, current + halfWindow);

    // Adjust window if near edges
    if (start <= 2) {
      end = Math.min(totalPages - 1, start + windowSize - 1);
      start = 2;
    }
    if (end >= totalPages - 1) {
      start = Math.max(2, end - windowSize + 1);
      end = totalPages - 1;
    }

    if (start > 2) {
      pages.push("...");
    }

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    if (end < totalPages - 1) {
      pages.push("...");
    }

    pages.push(totalPages);

    return pages;
  }

  private goToPage(page: number): void {
    const totalPages = Math.ceil(this.totalItems / this.pageSize);
    if (page < 1 || page > totalPages) return;

    this.currentPage = page;
    this.render();
    this.onPageChange?.(page);
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 8px;
        border-top: 1px solid var(--divider);
      }

      #item-count {
        color: var(--text-sec);
        flex-shrink: 0;
        white-space: nowrap;
      }

      #controls {
        align-items: center;
        gap: 16px;
        flex-shrink: 1;
        min-width: 0;
      }

      #pagination {
        align-items: center;
        gap: 4px;
      }

      #page-numbers {
        align-items: center;
        gap: 2px;
        flex-wrap: nowrap;
      }

      .nav-button {
        border: none;
        background: none;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        color: var(--text-pri);
      }

      .nav-button:hover:not([disabled]) {
        background: var(--bg-hover);
      }

      .nav-button[disabled] {
        color: var(--text-ter);
        cursor: not-allowed;
      }

      .page-button {
        border: none;
        background: none;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        color: var(--text-sec);
        min-width: 28px;
      }

      .page-button:hover {
        background: var(--bg-hover);
      }

      .page-button[current] {
        background: var(--bg-selected);
        color: var(--text-pri);
        font-weight: 500;
      }

      #page-size-container {
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }

      #page-size-label {
        color: var(--text-sec);
        white-space: nowrap;
      }

      #page-size-select {
        border: 1.5px solid var(--divider);
        background: var(--bg);
        color: var(--text-pri);
        border-radius: 4px;
        padding: 4px 8px;
        cursor: pointer;
      }

      #page-size-select:focus {
        outline: none;
        border-color: var(--blue);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <p id="item-count"></p>
    <std-row id="controls">
      <std-row id="pagination">
        <button id="prev-button" class="nav-button">Prev</button>
        <std-row id="page-numbers"></std-row>
        <button id="next-button" class="nav-button">Next</button>
      </std-row>
      <std-row id="page-size-container">
        <p id="page-size-label">Per page:</p>
        <select id="page-size-select">
          <option value="10">10</option>
          <option value="25" selected>25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </std-row>
    </std-row>
  `;
}

export namespace TableFooter {
  export type Props = {
    currentPage?: Option<number>;
    pageSize?: Option<number>;
    totalItems?: Option<number>;
    onPageChange?: (page: number) => void;
    onPageSizeChange?: (pageSize: number) => void;
  };
}
