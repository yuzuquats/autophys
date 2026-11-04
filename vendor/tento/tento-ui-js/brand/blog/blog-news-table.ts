import { html, LonaWebComponent } from "../../component";
import { Row } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Hotkeys } from "../../hotkeys";
import { ScrollShadows } from "../../ui/scroll-shadows";
import { Typography } from "../../ui/typography";
import { BlogSearchHighlight } from "./blog-search-highlight";
import type { BlogPost } from "./blog-types";

@component({ name: "std-blog-news-table" })
export class BlogNewsTable extends LonaWebComponent {
  private $searchInput: HTMLInputElement = this.$(
    "search-input",
  ) as HTMLInputElement;
  private $scrollContainer: HTMLElement = this.$("scroll-container");
  private $tableContainer: HTMLElement = this.$("table-container");
  private $emptyState: HTMLElement = this.$("empty-state");
  private $seeMoreContainer: HTMLElement = this.$("see-more-container");

  private posts: BlogPost[] = [];
  private displayCount: number = 10;
  private searchQuery: string = "";
  private onSearch?: (query: string) => void;
  private onSeeMore?: () => void;
  private onCardClick?: (slug: string) => void;
  private rowBySlug: Map<string, BlogNewsTable.RowRefs> = new Map();
  private $seeMoreButton: Option<HTMLButtonElement> = null;
  private resizeObserver: Option<ResizeObserver> = null;

  static makeWith(props: BlogNewsTable.Props): BlogNewsTable {
    return (BlogNewsTable.make() as BlogNewsTable).bind(props);
  }

  bind(props: BlogNewsTable.Props): this {
    this.posts = props.posts;
    this.displayCount = props.displayCount;
    this.searchQuery = props.searchQuery ?? "";
    this.onSearch = props.onSearch;
    this.onSeeMore = props.onSeeMore;
    this.onCardClick = props.onCardClick;

    this.render();
    return this;
  }

  private render(): void {
    this.$searchInput.value = this.searchQuery;
    const isSearching = this.searchQuery.trim().length > 0;
    this.classList.toggle("search-active", isSearching);

    const postsToShow = this.posts.slice(0, this.displayCount);
    this.style.display = postsToShow.length === 0 && !isSearching
      ? "none"
      : "";
    const desiredRows: HTMLElement[] = [];
    const desiredSlugs = new Set<string>();

    for (const post of postsToShow) {
      desiredSlugs.add(post.slug);
      let row = this.rowBySlug.get(post.slug);
      if (!row) {
        row = this.createRow(post);
        this.rowBySlug.set(post.slug, row);
      } else {
        this.updateRow(row, post);
      }
      desiredRows.push(row.$row);
    }

    for (const [slug, row] of this.rowBySlug.entries()) {
      if (desiredSlugs.has(slug)) continue;
      DomUtils.removeFromDom(row.$row);
      this.rowBySlug.delete(slug);
    }

    DomUtils.reconcileChildren(this.$tableContainer, desiredRows);
    this.renderEmptyState(postsToShow.length === 0, isSearching);

    this.updateScrollShadows();

    const remainingCount = this.posts.length - this.displayCount;
    if (!isSearching && remainingCount > 0 && this.onSeeMore) {
      if (!this.$seeMoreButton) {
        this.$seeMoreButton = document.createElement("button");
        this.$seeMoreButton.className = "see-more-button";
        GESTURE_MANAGER.addPointerEvent(this.$seeMoreButton, {
          onClick: () => {
            if (this.onSeeMore) {
              this.onSeeMore();
            }
          },
        });
      }
      this.$seeMoreButton.textContent = "See more";
      DomUtils.reconcileChildren(this.$seeMoreContainer, [this.$seeMoreButton]);
      return;
    }

    this.$seeMoreButton = null;
    DomUtils.clearChildren(this.$seeMoreContainer);
  }

  private createRow(post: BlogPost): BlogNewsTable.RowRefs {
    const $row = Row.make();
    $row.className = "table-row";

    const $date = Typography.p(this.formatDate(post.date), "small");
    $date.className = "table-date";

    const $category = Typography.p(post.category || "", "small");
    $category.className = "table-category";
    BlogSearchHighlight.applyHighlightedText(
      $category,
      post.category || "",
      this.searchQuery,
    );

    const $titleWrap = document.createElement("div");
    $titleWrap.className = "table-title-wrap";

    const $title = Typography.p(post.title);
    $title.className = "table-title";
    BlogSearchHighlight.applyHighlightedText(
      $title,
      post.title,
      this.searchQuery,
    );

    const $snippet = Typography.p("", "small");
    $snippet.className = "table-snippet";
    this.updateSnippet($snippet, post);

    $titleWrap.append($title, $snippet);

    $row.appendChild($date);
    $row.appendChild($category);
    $row.appendChild($titleWrap);

    if (this.onCardClick) {
      $row.style.cursor = "pointer";
      GESTURE_MANAGER.addPointerEvent($row, {
        onClick: () => {
          if (this.onCardClick) {
            this.onCardClick(post.slug);
          }
        },
      });

      $row.addEventListener("mouseenter", () => {
        $row.style.opacity = "0.7";
      });

      $row.addEventListener("mouseleave", () => {
        $row.style.opacity = "1";
      });
    }

    return { $row, $date, $category, $title, $snippet };
  }

  private updateRow(row: BlogNewsTable.RowRefs, post: BlogPost): void {
    row.$date.textContent = this.formatDate(post.date);
    BlogSearchHighlight.applyHighlightedText(
      row.$category,
      post.category || "",
      this.searchQuery,
    );
    BlogSearchHighlight.applyHighlightedText(
      row.$title,
      post.title,
      this.searchQuery,
    );
    this.updateSnippet(row.$snippet, post);
  }

  private updateSnippet($snippet: HTMLElement, post: BlogPost): void {
    const matchSnippet = BlogSearchHighlight.findSnippet(
      post,
      this.searchQuery,
    );
    if (!matchSnippet) {
      $snippet.textContent = "";
      $snippet.style.display = "none";
      return;
    }

    $snippet.style.display = "block";
    BlogSearchHighlight.applyHighlightedText(
      $snippet,
      `${matchSnippet.label}: ${matchSnippet.text}`,
      this.searchQuery,
    );
  }

  private formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  private renderEmptyState(isEmpty: boolean, isSearching: boolean): void {
    if (!isEmpty) {
      this.$emptyState.style.display = "none";
      return;
    }

    this.$emptyState.style.display = "block";
    this.$emptyState.textContent = isSearching
      ? "No matching posts. Try a different search."
      : "No posts available.";
  }

  connectedCallback(): void {
    super.connectedCallback();

    // Setup search input listener
    this.$searchInput.addEventListener("input", () => {
      if (this.onSearch) {
        this.onSearch(this.$searchInput.value);
      }
    });
    this.$searchInput.onkeydown = this.$searchInput.onkeyup = (
      e: KeyboardEvent,
    ) => {
      const hotkey = DomUtils.hotkeyIdentifier(e);
      if (!hotkey) return;
      if (Hotkeys.allowedHotkeyInEditor(hotkey)) return;
      if (Hotkeys.shouldPreventDefault(hotkey)) e.preventDefault();
      e.stopPropagation();
    };

    this.$scrollContainer.addEventListener("scroll", this.updateScrollShadows);
    this.resizeObserver = new ResizeObserver(() => {
      this.updateScrollShadows();
    });
    this.resizeObserver.observe(this.$scrollContainer);
    this.updateScrollShadows();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.$scrollContainer.removeEventListener(
      "scroll",
      this.updateScrollShadows,
    );
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private updateScrollShadows = (): void => {
    ScrollShadows.updateScrollShadows(this, this.$scrollContainer);
  };

  static $html = html`
    <div id="container">
      <h2 id="title">News</h2>
      <div id="search-container">
        <input
          type="text"
          id="search-input"
          placeholder="Search"
        />
      </div>
      <div id="results-shell">
        <div class="scroll-shadow-top"></div>
        <div class="scroll-shadow-bottom"></div>
        <div id="scroll-container">
          <div id="table-container"></div>
          <p id="empty-state"></p>
        </div>
      </div>
      <div id="see-more-container"></div>
    </div>
  `;

  static $styles = [
    ScrollShadows.$styles,
    css`
      :host {
        display: block;
        padding: 80px 40px;
        border-top: 1px solid var(--divider);
      }

      #container {
        max-width: 1200px;
        margin: 0 auto;
      }

      #title {
        --font-size: var(--text-24px);
        font-weight: 500;
        --margin-top: 0px;
        --margin-bottom: 32px;
        color: var(--text-pri);
        letter-spacing: -0.5px;
      }

      #search-container {
        margin-bottom: 32px;
      }

      #search-input {
        width: 100%;
        max-width: 400px;
        padding: 12px 16px;
        --font-size: var(--text-15px);
        border: 1px solid var(--divider);
        border-radius: 6px;
        outline: none;
        transition: border-color 0.2s ease;
      }

      #search-input:focus {
        border-color: var(--text-pri);
      }

      #table-container {
        display: flex;
        flex-direction: column;
      }

      #empty-state {
        display: none;
        --font-size: var(--text-12px);
        color: var(--text-sec);
        --margin-top: 24px;
        --margin-bottom: 0px;
      }

      #results-shell {
        position: relative;
        overflow: hidden;
      }

      #scroll-container {
        overflow-y: visible;
      }

      :host(.search-active) #results-shell {
        height: 520px;
      }

      :host(.search-active) #scroll-container {
        height: 100%;
        overflow-y: auto;
      }

      .table-row {
        gap: 40px;
        padding: 24px 0;
        border-bottom: 1px solid var(--divider);
        transition: opacity 0.2s ease;
        align-items: center;
      }

      .table-date {
        flex-shrink: 0;
        min-width: 100px;
        --font-size: var(--text-11px);
        color: var(--text-ter);
      }

      .table-category {
        flex-shrink: 0;
        min-width: 120px;
        --font-size: var(--text-11px);
        color: var(--text-ter);
        text-transform: capitalize;
      }

      .table-title {
        flex: 1;
        --font-size: var(--text-11px);
        font-weight: 500;
        color: var(--text-pri);
        line-height: 1.4;
      }

      .table-title-wrap {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .table-snippet {
        --font-size: var(--text-11px);
        color: var(--text-sec);
        --margin-top: 8px;
        --margin-bottom: 0px;
      }

      .table-title mark,
      .table-category mark,
      .table-snippet mark {
        background: color-mix(in srgb, var(--yellow) 35%, transparent);
        color: inherit;
      }

      #see-more-container {
        display: flex;
        justify-content: center;
        margin-top: 40px;
      }

      .see-more-button {
        padding: 12px 32px;
        --font-size: var(--text-14px);
        font-weight: 500;
        color: var(--text-pri);
        background: transparent;
        border: 1px solid var(--divider);
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .see-more-button:hover {
        border-color: var(--text-pri);
      }

      @media (max-width: 768px) {
        .table-row {
          flex-direction: column;
          gap: 8px;
        }

        .table-date,
        .table-category {
          min-width: 0;
        }
      }
    `,
  ];
}

export namespace BlogNewsTable {
  export type RowRefs = {
    $row: HTMLElement;
    $date: HTMLElement;
    $category: HTMLElement;
    $title: HTMLElement;
    $snippet: HTMLElement;
  };

  export type Props = {
    posts: BlogPost[];
    displayCount: number;
    searchQuery?: string;
    onSearch?: (query: string) => void;
    onSeeMore?: () => void;
    onCardClick?: (slug: string) => void;
  };
}
