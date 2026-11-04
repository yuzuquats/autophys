import "./page-card";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { PageCard } from "./page-card";

@component({ name: "std-simple-auth-card" })
export class SimpleAuthCard extends LonaWebComponent {
  private $card: PageCard = this.hydrate("card");

  bind(props: SimpleAuthCard.Props): this {
    this.$card.bind({
      title: props.title,
      message: props.description,
    });
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
      }
      #card {
        --page-card-radius: var(--simple-auth-card-radius, 16px);
        --page-card-padding: var(--simple-auth-card-padding, 40px 28px);
        --page-card-shadow: var(
          --simple-auth-card-shadow,
          0 4px 24px rgba(0, 0, 0, 0.1)
        );
        --page-card-bg: var(--simple-auth-card-bg, var(--bg));
        min-width: var(--simple-auth-card-min-width, 320px);
      }
      ::slotted([slot="action"]) {
        width: 100%;
      }
      /* spacing: --margin-top feeds typography-managed elements (p, .small);
         the raw margin-top covers plain spans/divs the typography system skips */
      ::slotted([slot="status"]) {
        --font-size: var(--small-size);
        --margin-top: 16px;
        margin-top: 16px;
        color: var(--text-ter);
        text-align: center;
      }
      ::slotted([slot="footer"]) {
        --font-size: var(--small-size);
        --margin-top: 16px;
        margin-top: 16px;
        color: var(--text-ter);
        text-align: center;
      }
    `,
  ];

  static $html = html`
    <std-page-card id="card">
      <slot name="action"></slot>
      <slot name="status"></slot>
      <slot name="footer"></slot>
    </std-page-card>
  `;
}

export namespace SimpleAuthCard {
  export type Props = {
    title?: Option<string>;
    description?: Option<string>;
  };
}
