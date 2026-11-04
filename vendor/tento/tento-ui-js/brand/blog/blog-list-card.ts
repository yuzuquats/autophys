import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import type { BlogPost, CardLayout } from "./blog-types";

@component({ name: "std-blog-list-card" })
export class BlogListCard extends LonaWebComponent {
  private $category: HTMLElement = this.$("category");
  private $titleContainer: HTMLElement = this.$("title-container");
  private $metadata: HTMLElement = this.$("metadata");
  private $summary: HTMLElement = this.$("summary");

  static makeWith(props: BlogListCard.Props): BlogListCard {
    return (BlogListCard.make() as BlogListCard).bind(props);
  }

  bind(props: BlogListCard.Props): this {
    this.render(props.post);
    return this;
  }

  private render(post: BlogPost): void {
    // Category
    DomUtils.clearChildren(this.$category);
    if (post.category) {
      const $tag = document.createElement("span");
      $tag.className = "category-tag";
      $tag.textContent = post.category;
      this.$category.appendChild($tag);
    }

    // Title
    DomUtils.clearChildren(this.$titleContainer);
    const $title = document.createElement("h3");
    $title.className = "title";
    $title.textContent = post.title;
    this.$titleContainer.appendChild($title);

    // Metadata
    DomUtils.clearChildren(this.$metadata);
    const $date = document.createElement("span");
    $date.className = "meta-text";
    $date.textContent = post.date;
    this.$metadata.appendChild($date);

    // Summary
    this.$summary.textContent = post.summary;
  }

  static $html = html`
    <div id="card">
      <div id="header">
        <div id="category"></div>
        <div id="title-container"></div>
      </div>
      <div id="body">
        <div id="metadata"></div>
        <p id="summary"></p>
      </div>
    </div>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        padding: 32px 0;
        border-bottom: 1px solid var(--divider);
        transition: background 0.3s ease;
      }

      :host(:hover) {
        background: var(--bg-hover);
      }

      #card {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      #header {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .category-tag {
        display: inline-block;
        padding: 4px 12px;
        border-radius: 12px;
        background-color: var(--blue-dimmed);
        --font-size: var(--text-12px);
        font-weight: 600;
        text-transform: uppercase;
        width: fit-content;
      }

      #title-container {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .title {
        font-weight: 700;
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

export namespace BlogListCard {
  export type Props = {
    post: BlogPost;
    layout?: Option<CardLayout>;
  };
}
