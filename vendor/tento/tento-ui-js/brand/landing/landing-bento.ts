import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { FEATURE_CARD_TEXT } from "./landing-card-text";
import { LandingCard } from "./landing-card";
import { LandingUi } from "./landing-ui";

@component({ name: "std-landing-bento" })
export class LandingBento extends LonaWebComponent {
  private $grid: HTMLElement = this.$("grid");

  static makeWith(props: LandingBento.Props): LandingBento {
    return (LandingBento.make() as LandingBento).bind(props);
  }

  bind(props: LandingBento.Props): this {
    for (const child of [...this.children]) {
      if (child.getAttribute("slot") === "title") child.remove();
    }
    {
      const $title = document.createElement("h2");
      $title.className = "section-title";
      $title.slot = "title";
      LandingUi.components.typography.bind($title, { variant: "bento-heading", text: props.title });
      this.appendChild($title);
    }

    DomUtils.clearChildren(this.$grid);
    for (const item of props.items) {
      const { span, cardClassName, ...cardProps } = item;
      const $card = LandingCard.makeWith(cardProps);
      if (span && span > 1) {
        $card.style.gridColumn = `span ${span}`;
      }
      if (cardClassName) $card.classList.add(cardClassName);
      this.$grid.appendChild($card);
    }

    return this;
  }

  static $html = html`
    <std-col id="content">
      <slot name="title"></slot>
      <div id="grid"></div>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        --landing-card-copy-font-family: var(--landing-copy-font-family, inherit);
        display: block;
      }

      ::slotted(.section-title) { font-family: var(--landing-copy-font-family, inherit); }

      #content {
        gap: 28px;
      }

      #grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 20px;
      }

      @media (max-width: 1024px) {
        #grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 768px) {
        #grid {
          grid-template-columns: 1fr;
        }

        #grid > * {
          grid-column: auto !important;
        }
      }
    `,
    FEATURE_CARD_TEXT,
  ];
}

export namespace LandingBento {
  export type Item = LandingCard.Props & {
    span?: Option<number>;
    // Extra class on the card host — e.g. "feature-card" to opt the card into
    // the shared landing feature-card text treatment (see landing-card-text.ts).
    cardClassName?: Option<string>;
  };

  export type Props = {
    title: string;
    items: Item[];
  };
}
