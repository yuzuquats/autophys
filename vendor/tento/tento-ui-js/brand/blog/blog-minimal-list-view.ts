import { Month, NaiveDate } from "@tento-chrono";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { ScrollShadows } from "../../ui/scroll-shadows";
import { BlogSearchHighlight } from "./blog-search-highlight";
import type { BlogPost } from "./blog-types";

function formatLongDate(dateStr: string): string {
  const date = NaiveDate.parse(dateStr);
  const month = Month.MONTHS_OF_YEAR[date.month0];
  return `${month} ${date.day1}, ${date.yr}`;
}

@component({ name: "std-blog-minimal-list-view" })
export class BlogMinimalListView extends LonaWebComponent {
  private $scrollContainer: HTMLElement = this.$("scroll-container");
  private $list: HTMLElement = this.$("list");
  private $emptyState: HTMLElement = this.$("empty-state");
  private $seeMoreContainer: HTMLElement = this.$("see-more-container");

  private posts: BlogPost[] = [];
  private displayCount: number = 10;
  private searchQuery: string = "";
  private onSeeMore?: () => void;
  private onCardClick?: (slug: string) => void;
  private rowBySlug: Map<string, BlogMinimalListView.RowRefs> = new Map();
  private $seeMoreLink: Option<HTMLAnchorElement> = null;
  private resizeObserver: Option<ResizeObserver> = null;

  static makeWith(props: BlogMinimalListView.Props): BlogMinimalListView {
    return (BlogMinimalListView.make() as BlogMinimalListView).bind(props);
  }

  bind(props: BlogMinimalListView.Props): this {
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

  private createRow(post: BlogPost): BlogMinimalListView.RowRefs {
    const $li = document.createElement("li");
    $li.className = "row";

    const $rowMain = document.createElement("div");
    $rowMain.className = "row-main";

    const $title = document.createElement("a");
    $title.className = "title";
    BlogSearchHighlight.applyHighlightedText(
      $title,
      post.title,
      this.searchQuery,
    );

    GESTURE_MANAGER.addPointerEvent($title, {
      onClick: () => {
        if (this.onCardClick) {
          this.onCardClick(post.slug);
        }
      },
    });

    const $tags = document.createElement("span");
    $tags.className = "tags";

    const $date = document.createElement("span");
    $date.className = "date";

    const $snippet = document.createElement("span");
    $snippet.className = "snippet";

    $rowMain.append($title, $tags, $date);
    $li.append($rowMain, $snippet);

    const row: BlogMinimalListView.RowRefs = {
      $li,
      $title,
      $tags,
      $date,
      $snippet,
    };
    this.updateRow(row, post);
    return row;
  }

  private updateRow(row: BlogMinimalListView.RowRefs, post: BlogPost): void {
    BlogSearchHighlight.applyHighlightedText(
      row.$title,
      post.title,
      this.searchQuery,
    );
    row.$date.textContent = formatLongDate(post.date);

    const matchSnippet = BlogSearchHighlight.findSnippet(
      post,
      this.searchQuery,
    );
    if (!matchSnippet) {
      row.$snippet.textContent = "";
      row.$snippet.style.display = "none";
    } else {
      row.$snippet.style.display = "block";
      BlogSearchHighlight.applyHighlightedText(
        row.$snippet,
        `${matchSnippet.label}: ${matchSnippet.text}`,
        this.searchQuery,
      );
    }

    DomUtils.clearChildren(row.$tags);
    if (!post.tags || post.tags.length === 0) return;
    for (const tag of post.tags) {
      const $tag = document.createElement("span");
      $tag.className = "tag";
      BlogSearchHighlight.applyHighlightedText($tag, tag, this.searchQuery);
      row.$tags.appendChild($tag);
    }
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

      .row {
        display: flex;
        flex-direction: column;
        padding: 10px 0;
      }

      .row-main {
        display: flex;
        align-items: baseline;
        gap: 12px;
        flex-wrap: nowrap;
      }

      .title {
        flex: 1 1 0;
        min-width: 0;
        --font-size: var(--text-10px);
        color: var(--text-pri);
        text-decoration: none;
        cursor: pointer;
        --line-height-ratio: 1.3;
      }

      .title:hover {
        text-decoration: underline;
      }

      .title mark,
      .tag mark,
      .snippet mark {
        background: color-mix(in srgb, var(--yellow) 35%, transparent);
        color: inherit;
      }

      .tag {
        --font-size: var(--text-10px);
        color: var(--text-ter);
        flex-shrink: 0;
      }

      .tags {
        display: contents;
      }

      .date {
        --font-size: var(--text-10px);
        color: var(--text-ter);
        margin-left: auto;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .snippet {
        --font-size: var(--text-10px);
        color: var(--text-sec);
        display: none;
        padding-top: 4px;
      }

      #see-more-container {
        margin-top: 32px;
      }

      .see-more-link {
        --font-size: var(--text-10px);
        color: var(--text-sec);
        text-decoration: none;
        cursor: pointer;
      }

      .see-more-link:hover {
        text-decoration: underline;
        color: var(--text-pri);
      }
    `,
  ];
}

export namespace BlogMinimalListView {
  export type RowRefs = {
    $li: HTMLElement;
    $title: HTMLElement;
    $tags: HTMLElement;
    $date: HTMLElement;
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
