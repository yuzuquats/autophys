import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";

// Page numbers with a current page the reader can find. Only `table-footer`
// mentioned paging and it drew none. A `<nav aria-label>` of native buttons:
// the current one carries `aria-current=page`, the window around it is
// `siblings` wide on each side, ellipses are decorative, and prev/next carry
// their own names. Everything is rebuilt in `bind()`; nothing accumulates.
@component({ name: "std-pagination" })
export class Pagination extends LonaWebComponent {
  /** This control renders page buttons, not a virtualized page directory. */
  static readonly maxVisiblePages = 1000;
  private $nav: HTMLElement = this.$("nav");
  private props: Option<Pagination.Props>;

  constructor() {
    super();
    this.$nav.addEventListener("click", (e) => {
      const $b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-page]");
      const props = this.props;
      if ($b == null || props == null || $b.disabled) return;
      const page = Number($b.dataset.page);
      if (page !== props.page) props.onChange(page);
    });
  }

  bind(props: Pagination.Props): this {
    const items = Pagination.window(props.page, props.pageCount, props.siblings ?? 1);
    this.props = props;
    this.$nav.setAttribute("aria-label", props.labels?.nav ?? "Pagination");
    DomUtils.clearChildren(this.$nav);
    const { page, pageCount } = props;
    this.$nav.appendChild(this.$arrow(page - 1, page <= 1, props.labels?.prev ?? "Previous page", "‹"));
    for (const item of items) {
      if (item === "…") {
        const $e = Typography.small("…");
        $e.className = "ellipsis";
        $e.setAttribute("aria-hidden", "true");
        this.$nav.appendChild($e);
      } else {
        this.$nav.appendChild(this.$page(item, item === page));
      }
    }
    this.$nav.appendChild(this.$arrow(page < pageCount ? page + 1 : page, page >= pageCount, props.labels?.next ?? "Next page", "›"));
    return this;
  }

  private $page(n: number, current: boolean): HTMLButtonElement {
    const $b = document.createElement("button");
    $b.type = "button";
    $b.className = "page";
    $b.dataset.page = String(n);
    $b.textContent = String(n);
    $b.setAttribute("aria-label", `Page ${n}`);
    if (current) $b.setAttribute("aria-current", "page");
    $b.toggleAttribute("current", current);
    return $b;
  }

  private $arrow(target: number, disabled: boolean, label: string, glyph: string): HTMLButtonElement {
    const $b = document.createElement("button");
    $b.type = "button";
    $b.className = "arrow";
    $b.dataset.page = String(target);
    $b.textContent = glyph;
    $b.setAttribute("aria-label", label);
    $b.disabled = disabled;
    return $b;
  }

  /** The visible items: first, last, a window around the current page, and
   * an ellipsis for each gap — never an ellipsis standing for one page. */
  static window(page: number, pageCount: number, siblings: number): (number | "…")[] {
    if (!Number.isSafeInteger(pageCount) || pageCount < 0 ||
        !Number.isSafeInteger(page) || page < 1 || page > Math.max(1, pageCount) ||
        !Number.isSafeInteger(siblings) || siblings < 0) {
      throw new RangeError("Pagination requires safe integer page/pageCount and nonnegative siblings within the page domain");
    }
    if (pageCount === 0) return [];
    // Clamp before enumerating; even huge sibling requests are cheap for a
    // small page domain. Avoid overflowing page + siblings near MAX_SAFE_INTEGER.
    const first = page - Math.min(siblings, page - 1);
    const last = page + Math.min(siblings, pageCount - page);
    const visibleCount = last - first + 1 + (first === 3 ? 2 : first > 1 ? 1 : 0) +
      (last === pageCount - 2 ? 2 : last < pageCount ? 1 : 0);
    if (visibleCount > Pagination.maxVisiblePages) {
      throw new RangeError(`Pagination supports at most ${Pagination.maxVisiblePages} visible page buttons`);
    }
    const pages = new Set<number>([1, pageCount]);
    for (let p = first; p <= last; p++) pages.add(p);
    const sorted = [...pages].sort((a, b) => a - b);
    const out: (number | "…")[] = [];
    sorted.forEach((p, i) => {
      const prev = sorted[i - 1];
      if (prev != null && p - prev === 2) out.push(prev + 1);
      else if (prev != null && p - prev > 2) out.push("…");
      out.push(p);
    });
    return out;
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    DomUtils.clearChildren(this.$nav);
  }

  static makeWith(props: Pagination.Props): Pagination {
    return Pagination.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --pagination-gap: 4px;
        --pagination-item-size: var(--pagination-item-size-preset, 28px);
        --pagination-color: var(--text-sec);
        --pagination-current-bg: var(--text-pri);
        --pagination-current-color: var(--bg);
        --pagination-radius: 6px;

        display: inline-block;
        max-width: max-content;
      }

      nav {
        display: inline-flex;
        align-items: center;
        gap: var(--pagination-gap);
      }

      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: var(--pagination-item-size);
        height: var(--pagination-item-size);
        padding: 0 6px;
        margin: 0;
        border: 0;
        border-radius: var(--pagination-radius);
        background: transparent;
        color: var(--pagination-color);
        font-family: inherit;
        font-size: var(--small-size);
        font-variant-numeric: tabular-nums;
        cursor: pointer;
      }

      button:hover:not(:disabled) {
        background: var(--bg-surface-light);
      }

      button[current] {
        background: var(--pagination-current-bg);
        color: var(--pagination-current-color);
      }

      button:disabled {
        opacity: 0.4;
        cursor: default;
      }

      button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      .ellipsis {
        --margin-top: 0px;
        --margin-bottom: 0px;
        min-width: var(--pagination-item-size);
        text-align: center;
        color: var(--text-ter);
      }
    `,
  ];

  static $html = html`<nav id="nav"></nav>`;
}

export namespace Pagination {
  export type Props = {
    /** 1-based. */
    page: number;
    pageCount: number;
    /** Pages shown on each side of the current one; default 1. */
    siblings: Option<number>;
    onChange: (page: number) => void;
    labels: Option<{ nav: string; prev: string; next: string }>;
  };
}
