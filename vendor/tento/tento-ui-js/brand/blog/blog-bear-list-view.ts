import { Month, NaiveDate } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { Column } from "../../component-builtin";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { ScrollShadows } from "../../ui/scroll-shadows";
import { Typography } from "../../ui/typography";
import { BlogSearchHighlight } from "./blog-search-highlight";
import type { BlogPost } from "./blog-types";

function formatBearDate(dateStr: string): string {
  const date = NaiveDate.parse(dateStr);
  const day = String(date.day1).padStart(2, "0");
  const mon = Month.MONTHS_OF_YEAR_SHORT[date.month0];
  return `${day} ${mon}, ${date.yr}`;
}

@component({ name: "std-blog-bear-list-view" })
export class BlogBearListView extends LonaWebComponent {
  private $scrollContainer: HTMLElement = this.$("scroll-container");
  private $list: HTMLElement = this.$("list");
  private $emptyState: HTMLElement = this.$("empty-state");
  private $seeMoreContainer: HTMLElement = this.$("see-more-container");

  private posts: BlogPost[] = [];
  private displayCount: number = 10;
  private searchQuery: string = "";
  private onSeeMore?: () => void;
  private onCardClick?: (slug: string) => void;
  private rowBySlug: Map<string, BlogBearListView.RowRefs> = new Map();
  private $seeMoreLink: Option<HTMLAnchorElement> = null;
  private resizeObserver: Option<ResizeObserver> = null;

  static makeWith(props: BlogBearListView.Props): BlogBearListView {
    return (BlogBearListView.make() as BlogBearListView).bind(props);
  }

  bind(props: BlogBearListView.Props): this {
    this.posts = props.posts;
    this.displayCount = props.displayCount;
    this.searchQuery = props.searchQuery ?? "";
    this.onSeeMore = props.onSeeMore;
    this.onCardClick = props.onCardClick;

    this.render();
    return this;
  }

  private render(): void {
    const isSearching = this.searchQuery.trim().length > 0;
    this.classList.toggle("search-active", isSearching);

    const postsToShow = this.posts.slice(0, this.displayCount);
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
      desiredRows.push(row.$li);
    }

    for (const [slug, row] of this.rowBySlug.entries()) {
      if (desiredSlugs.has(slug)) continue;
      DomUtils.removeFromDom(row.$li);
      this.rowBySlug.delete(slug);
    }

    DomUtils.reconcileChildren(this.$list, desiredRows);
    this.renderEmptyState(postsToShow.length === 0, isSearching);

    this.updateScrollShadows();

    const remainingCount = this.posts.length - this.displayCount;
    if (!isSearching && remainingCount > 0 && this.onSeeMore) {
      if (!this.$seeMoreLink) {
        this.$seeMoreLink = document.createElement("a");
        this.$seeMoreLink.className = "see-more-link";
        GESTURE_MANAGER.addPointerEvent(this.$seeMoreLink, {
          onClick: () => {
            if (this.onSeeMore) {
              this.onSeeMore();
            }
          },
        });
      }
      this.$seeMoreLink.textContent = `see ${remainingCount} more posts`;
      DomUtils.reconcileChildren(this.$seeMoreContainer, [this.$seeMoreLink]);
      return;
    }

    this.$seeMoreLink = null;
    DomUtils.clearChildren(this.$seeMoreContainer);
  }

  connectedCallback(): void {
    super.connectedCallback();
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

  private createRow(post: BlogPost): BlogBearListView.RowRefs {
    const $li = document.createElement("li");
    $li.className = "bear-row";

    const $date = document.createElement("span");
    $date.className = "bear-date";
    $date.textContent = formatBearDate(post.date);

    const $title = document.createElement("a");
    $title.className = "bear-title";
    BlogSearchHighlight.applyHighlightedText(
      $title,
      post.title,
      this.searchQuery,
    );

    const $snippet = Typography.p("", "small");
    $snippet.className = "bear-snippet";
    this.updateSnippet($snippet, post);

    const $content = Column.make();
    $content.className = "bear-content";
    $content.append($title, $snippet);

    GESTURE_MANAGER.addPointerEvent($title, {
      onClick: () => {
        if (this.onCardClick) {
          this.onCardClick(post.slug);
        }
      },
    });

    $li.append($date, $content);
    return { $li, $date, $title, $snippet };
  }

  private updateRow(row: BlogBearListView.RowRefs, post: BlogPost): void {
    row.$date.textContent = formatBearDate(post.date);
    BlogSearchHighlight.applyHighlightedText(
      row.$title,
      post.title,
      this.searchQuery,
    );
    this.updateSnippet(row.$snippet, post);
  }

  private updateSnippet($snippet: HTMLElement, post: BlogPost): void {
    if (this.searchQuery.trim().length === 0) {
      $snippet.textContent = "";
      $snippet.style.display = "none";
      return;
    }

    $snippet.style.display = "block";
    BlogSearchHighlight.applyHighlightedText(
      $snippet,
      post.summary,
      this.searchQuery,
    );
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

  static $html = html`
    <div id="container">
      <div id="results-shell">
        <div class="scroll-shadow-top"></div>
        <div class="scroll-shadow-bottom"></div>
        <div id="scroll-container">
          <ul id="list"></ul>
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
      }

      #container {
        max-width: 720px;
        margin: 0 auto;
      }

      #list {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      #empty-state {
        display: none;
        --font-size: var(--text-12px);
        color: var(--text-sec);
        --margin-top: 20px;
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

      .bear-row {
        display: flex;
        align-items: flex-start;
        gap: 15px;
        padding: 9px 0;
      }

      .bear-content {
        flex: 1;
        gap: 4px;
      }

      .bear-date {
        flex-shrink: 0;
        width: 130px;
        font-family: "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --font-size: var(--text-11px);
        color: #666;
      }

      .bear-title {
        --font-size: var(--text-12px);
        color: var(--blue);
        text-decoration: none;
        cursor: pointer;
      }

      .bear-title:hover {
        text-decoration: underline;
      }

      .bear-snippet {
        --font-size: var(--text-11px);
        color: #444;
        --margin-top: 8px;
        --margin-bottom: 0px;
      }

      .bear-title mark,
      .bear-snippet mark {
        background: color-mix(in srgb, var(--yellow) 35%, transparent);
        color: inherit;
      }

      #see-more-container {
        margin-top: 36px;
      }

      .see-more-link {
        --font-size: var(--text-12px);
        color: var(--blue);
        text-decoration: none;
        cursor: pointer;
      }

      .see-more-link:hover {
        text-decoration: underline;
      }

      @media (max-width: 768px) {
        .bear-row {
          flex-direction: column;
          gap: 6px;
          padding: 10px 0;
        }

        .bear-date {
          width: auto;
        }

        .bear-snippet {
          margin-top: 0;
        }
      }
    `,
  ];
}

export namespace BlogBearListView {
  export type RowRefs = {
    $li: HTMLElement;
    $date: HTMLElement;
    $title: HTMLElement;
    $snippet: HTMLElement;
  };

  export type Props = {
    posts: BlogPost[];
    displayCount: number;
    searchQuery?: string;
    onSeeMore?: () => void;
    onCardClick?: (slug: string) => void;
  };
}
