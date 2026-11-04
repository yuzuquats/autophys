import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { BlogUi } from "./blog-ui";
import { setSafeHref } from "@tento-brand/src/safe-url";
import { ScrollShadows } from "../../ui/scroll-shadows";
import { BlogSearchHighlight } from "./blog-search-highlight";
import type { BlogPost } from "./blog-types";

@component({ name: "std-blog-simple-list-view" })
export class BlogSimpleListView extends LonaWebComponent {
  private $scrollContainer: HTMLElement = this.$("scroll-container");
  private $listContainer: HTMLElement = this.$("list-container");
  private $emptyState: HTMLElement = this.$("empty-state");
  private $seeMoreContainer: HTMLElement = this.$("see-more-container");

  private posts: BlogPost[] = [];
  private displayCount: number = 10;
  private searchQuery: string = "";
  private onSeeMore?: () => void;
  private onCardClick?: (slug: string) => void;
  private getPostHref?: (post: BlogPost) => string;
  private rowBySlug: Map<string, BlogSimpleListView.RowRefs> = new Map();
  private $seeMoreButton: Option<HTMLButtonElement> = null;
  private resizeObserver: Option<ResizeObserver> = null;

  static makeWith(props: BlogSimpleListView.Props): BlogSimpleListView {
    return (BlogSimpleListView.make() as BlogSimpleListView).bind(props);
  }

  bind(props: BlogSimpleListView.Props): this {
    this.posts = props.posts;
    this.displayCount = props.displayCount;
    this.searchQuery = props.searchQuery ?? "";
    this.onSeeMore = props.onSeeMore;
    this.onCardClick = props.onCardClick;
    this.getPostHref = props.getPostHref;

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
      if (row && (row.$row instanceof HTMLAnchorElement) !== !!this.getPostHref) {
        row.$row.remove(); this.rowBySlug.delete(post.slug); row = undefined;
      }
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

    DomUtils.reconcileChildren(this.$listContainer, desiredRows);
    this.renderEmptyState(postsToShow.length === 0, isSearching);

    this.updateScrollShadows();

    const remainingCount = this.posts.length - this.displayCount;
    if (!isSearching && remainingCount > 0 && this.onSeeMore) {
      if (!this.$seeMoreButton) {
        this.$seeMoreButton = document.createElement("button");
        this.$seeMoreButton.className = "see-more-button";
        this.$seeMoreButton.type = "button";
        this.$seeMoreButton.onclick = () => this.onSeeMore?.();
      }
      BlogUi.components.button.bind(this.$seeMoreButton, { variant: "see-more", text: `See ${remainingCount} more` });
      DomUtils.reconcileChildren(this.$seeMoreContainer, [this.$seeMoreButton]);
      return;
    }

    this.$seeMoreButton = null;
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

  private createRow(post: BlogPost): BlogSimpleListView.RowRefs {
    const $row = document.createElement(this.getPostHref ? "a" : "div");
    $row.className = "simple-row";

    // Date
    const $date = document.createElement("p");
    $date.className = "simple-date";
    BlogUi.components.typography.bind($date, { variant: "list-date", text: this.formatDate(post.date) });

    // Content (title)
    const $content = document.createElement("div");
    $content.className = "simple-content";

    const $title = document.createElement("p");
    $title.className = "simple-title";
    BlogUi.components.typography.bind($title, { variant: "list-title", text: post.title });
    BlogSearchHighlight.applyHighlightedText(
      $title,
      post.title,
      this.searchQuery,
    );

    const $snippet = document.createElement("p");
    $snippet.className = "simple-snippet";
    this.updateSnippet($snippet, post);

    $content.appendChild($title);
    $content.appendChild($snippet);

    $row.appendChild($date);
    $row.appendChild($content);

    this.bindRowNavigation($row, post);


    return { $row, $date, $title, $snippet };
  }

  private bindRowNavigation($row: HTMLElement, post: BlogPost): void {
    const href = this.getPostHref?.(post);
    $row.style.cursor = href || this.onCardClick ? "pointer" : "";
    $row.onclick = null;
    $row.onkeydown = null;
    $row.removeAttribute("role");
    $row.removeAttribute("tabindex");
    $row.removeAttribute("href");
    if ($row instanceof HTMLAnchorElement && href) {
      setSafeHref($row, href);
      return;
    }
    if (this.onCardClick) {
      $row.setAttribute("role", "link");
      $row.tabIndex = 0;
      $row.onclick = () => this.onCardClick?.(post.slug);
      $row.onkeydown = event => {
        if (event.key === "Enter") { event.preventDefault(); this.onCardClick?.(post.slug); }
      };
    }
  }

  private updateRow(row: BlogSimpleListView.RowRefs, post: BlogPost): void {
    this.bindRowNavigation(row.$row, post);
    BlogUi.components.typography.bind(row.$date, { variant: "list-date", text: this.formatDate(post.date) });
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

  static $html = html`
    <div id="container">
      <div id="results-shell">
        <div class="scroll-shadow-top"></div>
        <div class="scroll-shadow-bottom"></div>
        <div id="scroll-container">
          <div id="list-container"></div>
          <p id="empty-state"></p>
        </div>
      </div>
      <div id="see-more-container"></div>
    </div>
  `;

  static $styles = [
    ScrollShadows.$styles,
    css(`
      :host {
        display: block;
        padding: 40px;
        background: var(--bg);
      }

      #container {
        max-width: var(--blog-content-max, 860px);
        margin: 0 auto;
      }

      #list-container {
        display: flex;
        flex-direction: column;
      }

      #empty-state {
        display: none;
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

      .simple-row {
        /* Native navigation must retain the former div's untrimmed grid box. */
        font: inherit;
        line-height: inherit;
        margin: 0;
        min-height: 0;
        box-shadow: none;
        text-decoration: none;
        color: inherit;
        display: grid;
        grid-template-columns: var(--blog-date-col, 100px) 1fr;
        column-gap: var(--blog-rail-gap, 32px);
        padding: 20px 0;
        border-bottom: 1px solid var(--divider);
        /* Baseline-align the date rail to the title's first line (its first
           baseline) rather than top-aligning the cells — the two columns have
           very different font sizes, so a top align reads as misregistered. */
        align-items: baseline;
      }

      .simple-date {
        color: var(--text-ter);
        --font-size: var(--text-9px);
      }

      .simple-content {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .simple-title {
        color: var(--text-pri);
        line-height: 1.4;
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      .simple-snippet {
        color: var(--text-sec);
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      .simple-snippet mark,
      .simple-title mark {
        background: color-mix(in srgb, var(--yellow) 35%, transparent);
        color: inherit;
      }

      #see-more-container {
        display: flex;
        justify-content: center;
        margin-top: 40px;
      }

      .see-more-button { ${BlogUi.buttonStyle.seeMore} }

      .see-more-button:hover {
        color: var(--text-pri);
        border-color: var(--text-pri);
      }

      /* Collapse the date-rail grid to one column so the date stacks above the
         title (matching the hero, which collapses the same way). */
      @media (max-width: 768px) {
        .simple-row {
          grid-template-columns: 1fr;
          row-gap: 10px;
        }
      }
    `),
  ];
}

export namespace BlogSimpleListView {
  export type RowRefs = {
    $row: HTMLElement;
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
    getPostHref?: (post: BlogPost) => string;
  };
}
