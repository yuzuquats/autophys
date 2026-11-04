import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";
import type { BlogPost } from "./blog-types";

export type BlogVariant = "list" | "claude";

@component({ name: "std-blog-featured-grid" })
export class BlogFeaturedGrid extends LonaWebComponent {
  private $grid: HTMLElement = this.$("grid");

  private posts: BlogPost[] = [];
  private variant: BlogVariant = "claude";
  private onCardClick?: (slug: string) => void;
  private heroCardBySlug: Map<string, BlogFeaturedGrid.CardRefs> = new Map();
  private listCardBySlug: Map<string, BlogFeaturedGrid.CardRefs> = new Map();
  private $listContainer: Option<HTMLElement> = null;

  static makeWith(props: BlogFeaturedGrid.Props): BlogFeaturedGrid {
    return (BlogFeaturedGrid.make() as BlogFeaturedGrid).bind(props);
  }

  bind(props: BlogFeaturedGrid.Props): this {
    this.posts = props.posts;
    this.variant = props.variant;
    this.onCardClick = props.onCardClick;

    this.render();
    return this;
  }

  private render(): void {
    if (this.posts.length === 0) {
      this.heroCardBySlug.clear();
      this.listCardBySlug.clear();
      this.$listContainer = null;
      DomUtils.clearChildren(this.$grid);
      return;
    }

    const heroPost = this.posts[0];
    let heroCard = this.heroCardBySlug.get(heroPost.slug);
    if (!heroCard) {
      heroCard = this.createHeroCard(heroPost);
      this.heroCardBySlug.set(heroPost.slug, heroCard);
    } else {
      this.updateCard(heroCard, heroPost);
    }
    for (const [slug, card] of this.heroCardBySlug.entries()) {
      if (slug === heroPost.slug) continue;
      DomUtils.removeFromDom(card.$card);
      this.heroCardBySlug.delete(slug);
    }

    const remainingPosts = this.posts.slice(1);
    if (remainingPosts.length === 0) {
      for (const [, card] of this.listCardBySlug.entries()) {
        DomUtils.removeFromDom(card.$card);
      }
      this.listCardBySlug.clear();
      if (this.$listContainer) {
        DomUtils.removeFromDom(this.$listContainer);
        this.$listContainer = null;
      }
      DomUtils.reconcileChildren(this.$grid, [heroCard.$card]);
      return;
    }

    if (!this.$listContainer) {
      this.$listContainer = document.createElement("div");
      this.$listContainer.className = "list-container";
    }

    const desiredListCards: HTMLElement[] = [];
    const desiredListSlugs = new Set<string>();
    for (const post of remainingPosts) {
      desiredListSlugs.add(post.slug);
      let listCard = this.listCardBySlug.get(post.slug);
      if (!listCard) {
        listCard = this.createListCard(post);
        this.listCardBySlug.set(post.slug, listCard);
      } else {
        this.updateCard(listCard, post);
      }
      desiredListCards.push(listCard.$card);
    }
    for (const [slug, card] of this.listCardBySlug.entries()) {
      if (desiredListSlugs.has(slug)) continue;
      DomUtils.removeFromDom(card.$card);
      this.listCardBySlug.delete(slug);
    }

    DomUtils.reconcileChildren(this.$listContainer, desiredListCards);
    DomUtils.reconcileChildren(this.$grid, [
      heroCard.$card,
      this.$listContainer,
    ]);
  }

  private updateMeta(
    $meta: HTMLElement,
    post: BlogPost,
    kind: "hero" | "list",
  ): void {
    DomUtils.clearChildren($meta);

    const categoryClass = kind === "hero" ? "hero-category" : "list-category";
    const separatorClass =
      kind === "hero" ? "hero-separator" : "list-separator";
    const dateClass = kind === "hero" ? "hero-date" : "list-date";

    if (post.category) {
      const $category = document.createElement("span");
      $category.className = categoryClass;
      $category.textContent = post.category;
      $meta.appendChild($category);

      const $separator = document.createElement("span");
      $separator.textContent = " · ";
      $separator.className = separatorClass;
      $meta.appendChild($separator);
    }

    const $date = document.createElement("span");
    $date.className = dateClass;
    $date.textContent = this.formatDate(post.date);
    $meta.appendChild($date);
  }

  private createHeroCard(post: BlogPost): BlogFeaturedGrid.CardRefs {
    const $card = document.createElement("div");
    $card.className = "hero-card";

    const bgColor = "#F5E6D3";

    const $image = document.createElement("img");
    $image.className = "hero-image";
    $image.style.backgroundColor = bgColor;

    const $content = document.createElement("div");
    $content.className = "hero-content";

    const $meta = document.createElement("div");
    $meta.className = "hero-meta";
    const $title = Typography.h3(post.title);
    $title.className = "hero-title";

    const $summary = Typography.p(post.summary, "small");
    $summary.className = "hero-summary";

    $content.appendChild($meta);
    $content.appendChild($title);
    $content.appendChild($summary);

    $card.appendChild($image);
    $card.appendChild($content);
    if (this.onCardClick) {
      $card.style.cursor = "pointer";
      $card.addEventListener("click", () => {
        if (this.onCardClick) {
          this.onCardClick(post.slug);
        }
      });
    }

    const card: BlogFeaturedGrid.CardRefs = {
      kind: "hero",
      $card,
      $image,
      $meta,
      $title,
      $summary,
    };
    this.updateCard(card, post);
    return card;
  }

  private createListCard(post: BlogPost): BlogFeaturedGrid.CardRefs {
    const $card = document.createElement("div");
    $card.className = "list-card";

    const $meta = document.createElement("div");
    $meta.className = "list-meta";
    const $title = Typography.h4(post.title);
    $title.className = "list-title";

    const $summary = Typography.p(post.summary, "small");
    $summary.className = "list-summary";

    $card.appendChild($meta);
    $card.appendChild($title);
    $card.appendChild($summary);

    if (this.onCardClick) {
      $card.style.cursor = "pointer";
      $card.addEventListener("click", () => {
        if (this.onCardClick) {
          this.onCardClick(post.slug);
        }
      });
    }

    const card: BlogFeaturedGrid.CardRefs = {
      kind: "list",
      $card,
      $meta,
      $title,
      $summary,
    };
    this.updateCard(card, post);
    return card;
  }

  private updateCard(card: BlogFeaturedGrid.CardRefs, post: BlogPost): void {
    if (card.$image) {
      card.$image.src = post.heroImage;
      card.$image.alt = post.title;
    }
    card.$title.textContent = post.title;
    card.$summary.textContent = post.summary;
    this.updateMeta(card.$meta, post, card.kind);
  }

  private formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  static $html = html` <div id="grid"></div> `;

  static $styles = [
    css`
      :host {
        display: block;
        padding: 60px 40px 80px;
        border-bottom: 1px solid var(--divider);
      }

      #grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 40px;
        max-width: 1200px;
        margin: 0 auto;
      }

      .hero-card {
        display: flex;
        flex-direction: column;
        border-radius: 12px;
        overflow: hidden;
      }

      .hero-image {
        width: 100%;
        aspect-ratio: 16 / 9;
        object-fit: cover;
      }

      .hero-content {
        padding: 24px 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .hero-meta {
        --font-size: var(--text-13px);
        color: var(--text-ter);
      }

      .hero-category {
        text-transform: capitalize;
      }

      .hero-separator {
        color: var(--text-ter);
      }

      .hero-date {
        color: var(--text-ter);
      }

      .hero-title {
        --font-size: var(--text-20px);
        font-weight: 500;
        color: var(--text-pri);
        line-height: 1.2;
        letter-spacing: -0.4px;
        --margin-bottom: 12px;
      }

      .hero-summary {
        --font-size: var(--text-10px);
        color: var(--text-sec);
        line-height: 1.6;
      }

      .list-container {
        display: flex;
        flex-direction: column;
        gap: 24px;
      }

      .list-card {
        padding-bottom: 24px;
        border-bottom: 1px solid var(--divider);
      }

      .list-card:last-child {
        border-bottom: none;
        padding-bottom: 0;
      }

      .list-meta {
        --font-size: var(--text-10px);
        color: var(--text-ter);
        margin-bottom: 8px;
      }

      .list-category {
        text-transform: capitalize;
      }

      .list-separator {
        color: var(--text-ter);
      }

      .list-date {
        color: var(--text-ter);
      }

      .list-title {
        --font-size: var(--text-14px);
        font-weight: 500;
        --margin-bottom: 16px;
        color: var(--text-pri);
        line-height: 1.3;
        letter-spacing: -0.3px;
      }

      .list-summary {
        --font-size: var(--text-10px);
        color: var(--text-sec);
        line-height: 1.5;
      }

      @media (max-width: 768px) {
        #grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ];
}

export namespace BlogFeaturedGrid {
  export type CardRefs = {
    kind: "hero" | "list";
    $card: HTMLElement;
    $meta: HTMLElement;
    $title: HTMLElement;
    $summary: HTMLElement;
    $image?: Option<HTMLImageElement>;
  };

  export type Props = {
    posts: BlogPost[];
    variant: BlogVariant;
    onCardClick?: (slug: string) => void;
  };
}
