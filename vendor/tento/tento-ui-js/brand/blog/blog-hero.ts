import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";

@component({ name: "std-blog-hero" })
export class BlogHero extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");
  private $title: HTMLElement = this.$("title");
  private $ctaContainer: HTMLElement = this.$("cta-container");

  private heroTitle: string = "";
  private heroCtas: Array<{ label: string; href: string }> = [];

  static makeWith(props: BlogHero.Props): BlogHero {
    return (BlogHero.make() as BlogHero).bind(props);
  }

  bind(props: BlogHero.Props): this {
    this.heroTitle = props.title;
    this.heroCtas = props.ctas ?? [];

    this.render();
    return this;
  }

  private render(): void {
    this.$title.textContent = this.heroTitle;

    DomUtils.clearChildren(this.$ctaContainer);

    for (const cta of this.heroCtas) {
      const $link = document.createElement("a");
      $link.href = cta.href;
      $link.textContent = cta.label;
      $link.className = "cta-link";

      this.$ctaContainer.appendChild($link);
    }
  }

  static $html = html`
    <div id="container">
      <h1 id="title"></h1>
      <div id="cta-container"></div>
    </div>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        padding: 80px 40px;
        border-bottom: 1px solid var(--divider);
      }

      #container {
        max-width: 1200px;
        margin: 0 auto;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 80px;
        align-items: start;
      }

      #title {
        --font-size: var(--text-24px);
        font-weight: 500;
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-pri);
        letter-spacing: -0.5px;
      }

      #cta-container {
        display: flex;
        flex-direction: column;
        gap: 16px;
        align-items: flex-start;
      }

      .cta-link {
        --font-size: var(--text-14px);
        color: var(--text-pri);
        text-decoration: none;
        cursor: pointer;
        transition: opacity 0.3s ease;
      }

      .cta-link:hover {
        opacity: 0.7;
      }

      @media (max-width: 768px) {
        #container {
          grid-template-columns: 1fr;
          gap: 40px;
        }
      }
    `,
  ];
}

export namespace BlogHero {
  export type Props = {
    title: string;
    ctas?: Array<{ label: string; href: string }>;
  };
}
