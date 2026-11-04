import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import type { BlogPost } from "./blog-types";

@component({ name: "std-blog-list-view" })
export class BlogListView extends LonaWebComponent {
  private $listContainer: HTMLElement = this.$("list-container");
  private $seeMoreContainer: HTMLElement = this.$("see-more-container");

  private posts: BlogPost[] = [];
  private displayCount: number = 10;
  private onSeeMore?: () => void;
  private onCardClick?: (slug: string) => void;

  static makeWith(props: BlogListView.Props): BlogListView {
    return (BlogListView.make() as BlogListView).bind(props);
  }

  bind(props: BlogListView.Props): this {
    this.posts = props.posts;
    this.displayCount = props.displayCount;
    this.onSeeMore = props.onSeeMore;
    this.onCardClick = props.onCardClick;

    this.render();
    return this;
  }

  private render(): void {
    DomUtils.clearChildren(this.$listContainer);
    DomUtils.clearChildren(this.$seeMoreContainer);

    // Render posts
    const postsToShow = this.posts.slice(0, this.displayCount);
    for (const post of postsToShow) {
      const $row = this.createRow(post);
      this.$listContainer.appendChild($row);
    }

    // Render "See more" button if there are more posts
    const remainingCount = this.posts.length - this.displayCount;
    if (remainingCount > 0 && this.onSeeMore) {
      const $button = document.createElement("button");
      $button.className = "see-more-button";
      $button.textContent = `See ${remainingCount} more`;

      GESTURE_MANAGER.addPointerEvent($button, {
        onClick: () => {
          if (this.onSeeMore) {
            this.onSeeMore();
          }
        },
      });

      this.$seeMoreContainer.appendChild($button);
    }
  }

  private createRow(post: BlogPost): HTMLElement {
    const $row = document.createElement("div");
    $row.className = "list-row";

    // Date
    const dateStr = new Date(post.date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const $date = Typography.p(dateStr, "small");
    $date.className = "list-date";

    // Category
    const $category = Typography.p(post.category ?? "general", "small");
    $category.className = "list-category";

    // Title
    const $content = document.createElement("div");
    $content.className = "list-content";

    const $title = Typography.p(post.title);
    $title.className = "list-title";
    $content.appendChild($title);

    $row.appendChild($date);
    $row.appendChild($category);
    $row.appendChild($content);

    // Add click handler
    if (this.onCardClick) {
      $row.style.cursor = "pointer";
      $row.addEventListener("click", () => {
        if (this.onCardClick) {
          this.onCardClick(post.slug);
        }
      });
    }

    return $row;
  }

  static $html = html`
    <div id="container">
      <div id="list-container"></div>
      <div id="see-more-container"></div>
    </div>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        padding: 40px;
        background: var(--bg);
      }

      #container {
        max-width: 1200px;
        margin: 0 auto;
      }

      #list-container {
        display: flex;
        flex-direction: column;
        gap: 1px;
        background: var(--divider);
        border-radius: 8px;
        overflow: hidden;
      }

      .list-row {
        display: grid;
        grid-template-columns: 120px 150px 1fr;
        gap: 24px;
        padding: 24px;
        background: var(--bg-elevated);
        transition: background 0.3s ease;
        align-items: start;
      }

      .list-row:hover {
        background: var(--bg-hover);
      }

      .list-date {
        --font-size: var(--text-14px);
        color: var(--text-ter);
        font-weight: 500;
      }

      .list-category {
        --font-size: var(--text-12px);
        font-weight: 600;
        text-transform: capitalize;
        color: var(--blue);
      }

      .list-content {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .list-title {
        --font-size: var(--text-16px);
        font-weight: 600;
        color: var(--text-pri);
        line-height: 1.4;
      }

      #see-more-container {
        display: flex;
        justify-content: center;
        margin-top: 32px;
      }

      .see-more-button {
        padding: 12px 32px;
        --font-size: var(--text-14px);
        font-weight: 500;
        color: var(--blue);
        background: var(--bg-elevated);
        border: 1px solid var(--divider);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
      }

      .see-more-button:hover {
        border-color: var(--blue);
        background: var(--blue);
        color: white;
      }

      @media (max-width: 768px) {
        .list-row {
          grid-template-columns: 1fr;
          gap: 8px;
        }
      }
    `,
  ];
}

export namespace BlogListView {
  export type Props = {
    posts: BlogPost[];
    displayCount: number;
    onSeeMore?: () => void;
    onCardClick?: (slug: string) => void;
  };
}
