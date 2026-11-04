import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import type { BlogPost, CardLayout } from "./blog-types";

const CATEGORY_COLORS: Record<string, string> = {
  product: "var(--blue-dimmed)",
  research: "var(--purple-dimmed)",
  engineering: "var(--green-dimmed)",
  company: "var(--orange-dimmed)",
  announcements: "var(--red-dimmed)",
};

@component({ name: "std-blog-claude-card" })
export class BlogClaudeCard extends LonaWebComponent {
  private $imageContainer: HTMLElement = this.$("image-container");
  private $img: HTMLImageElement = this.$("img") as HTMLImageElement;
  private $content: HTMLElement = this.$("content");
  private $category: HTMLElement = this.$("category");
  private $title: HTMLElement = this.$("title");
  private $metadata: HTMLElement = this.$("metadata");
  private $summary: HTMLElement = this.$("summary");

  static makeWith(props: BlogClaudeCard.Props): BlogClaudeCard {
    return (BlogClaudeCard.make() as BlogClaudeCard).bind(props);
  }

  bind(props: BlogClaudeCard.Props): this {
    this.render(props.post);
    return this;
  }

  private render(post: BlogPost): void {
    const bgColor = post.category
      ? CATEGORY_COLORS[post.category] ?? "var(--gray-dimmed)"
      : "var(--gray-dimmed)";

    this.style.setProperty("--category-color", bgColor);

    // Image
    this.$img.src = post.heroImage;
    this.$img.alt = post.title;

    // Category
    DomUtils.clearChildren(this.$category);
    if (post.category) {
      const $tag = document.createElement("span");
      $tag.className = "category-tag";
      $tag.textContent = post.category.toUpperCase();
      this.$category.appendChild($tag);
    }

    // Title
    this.$title.textContent = post.title;

    // Metadata
    DomUtils.clearChildren(this.$metadata);
    if (post.authorName) {
      const $authorName = document.createElement("span");
      $authorName.className = "meta-text";
      $authorName.textContent = post.authorName;
      this.$metadata.appendChild($authorName);
    }

    // Summary
    this.$summary.textContent = post.summary;
  }

  static $html = html`
    <div id="card">
      <div id="image-container">
        <img id="img" />
      </div>
      <div id="content">
        <div id="header">
          <div id="category"></div>
          <h3 id="title"></h3>
        </div>
        <div id="body">
          <div id="metadata"></div>
          <p id="summary"></p>
        </div>
      </div>
    </div>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        border-radius: 12px;
        overflow: hidden;
        height: 100%;
        transition: transform 0.3s ease, box-shadow 0.3s ease;
        box-shadow: var(--box-shadow-very-light);
      }

      :host(:hover) {
        transform: translateY(-8px);
        box-shadow: var(--box-shadow);
      }

      #card {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      #image-container {
        width: 100%;
        aspect-ratio: 1 / 1;
        background-color: var(--category-color, var(--gray-dimmed));
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      #content {
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        flex-grow: 1;
        background-color: var(--category-color, var(--gray-dimmed));
      }

      #header {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .category-tag {
        display: inline-block;
        padding: 6px 14px;
        border-radius: 20px;
        background-color: rgba(255, 255, 255, 0.5);
        color: var(--text-pri);
        --font-size: var(--text-11px);
        font-weight: 700;
        letter-spacing: 0.8px;
        width: fit-content;
        backdrop-filter: blur(8px);
      }

      #title {
        font-weight: 600;
        --margin-top: 0px;
        --margin-bottom: 8px;
      }

      #body {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      #metadata {
        display: flex;
        flex-direction: row;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }

      .meta-text {
        --font-size: var(--text-12px);
        color: var(--text-ter);
      }

      #summary {
        color: var(--text-sec);
        line-height: 1.5;
        --margin-top: 0px;
        --margin-bottom: 0px;
      }
    `,
  ];
}

export namespace BlogClaudeCard {
  export type Props = {
    post: BlogPost;
    layout?: Option<CardLayout>;
  };
}
