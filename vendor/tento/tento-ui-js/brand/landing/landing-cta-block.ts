import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LandingUi } from "./landing-ui";

@component({ name: "std-landing-cta-block" })
export class LandingCtaBlock extends LonaWebComponent {
  private $heading: HTMLElement = this.$("heading");
  private $subtext: HTMLElement = this.$("subtext");
  private $actions: HTMLElement = this.$("actions");

  static makeWith(props: LandingCtaBlock.Props): LandingCtaBlock {
    return (LandingCtaBlock.make() as LandingCtaBlock).bind(props);
  }

  bind(props: LandingCtaBlock.Props): this {
    LandingUi.components.typography.bind(this.$heading, { variant: "cta-heading", text: props.heading });
    LandingUi.components.typography.bind(this.$subtext, { variant: "cta-subtext", text: props.subtext ?? "" });
    DomUtils.clearChildren(this.$actions);

    this.$actions.appendChild(this.$link(props.primaryCta, true));
    if (props.secondaryCta) {
      this.$actions.appendChild(this.$link(props.secondaryCta, false));
    }

    return this;
  }

  private $link(cta: LandingCtaBlock.Cta, primary: boolean): HTMLElement {
    return LandingUi.components.link.make({
      treatment: "cta", variant: primary ? "primary" : "secondary",
      label: cta.label, href: cta.href,
    });
  }

  static $styles = [
    css(`
      :host {
        display: grid;
        gap: 24px;
        max-width: 820px;
        margin: 0 auto;
        padding: 34px;
        text-align: center;
        box-sizing: border-box;
        background: var(--bg);
      }

      #heading,
      #subtext {
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-family: var(--landing-copy-font-family, inherit);
      }

      #heading {
        --font-size: var(--text-24px);
        --line-height-ratio: 1.06;
        color: var(--text-pri);
      }

      #subtext {
        --font-size: var(--text-14px);
        --line-height-ratio: 1.52;
        color: var(--text-sec);
      }

      #subtext:empty {
        display: none;
      }

      #actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px;
      }

      .link-button {
        ${LandingUi.actionBase}
        color: var(--text-pri);
        font-weight: 550;
      }

      .link-button:hover {
        ${LandingUi.actionHover}
      }

      .link-button:focus-visible {
        ${LandingUi.actionFocus}
      }

      .link-button.primary {
        ${LandingUi.primaryAction}
      }

      @media (max-width: 768px) {
        :host {
          text-align: left;
          padding: 24px;
        }

        #heading {
          --font-size: var(--text-22px);
        }

        #actions {
          justify-content: flex-start;
        }
      }
    `),
  ];

  static $html = html`
    <h2 id="heading"></h2>
    <p id="subtext"></p>
    <div id="actions"></div>
  `;
}

export namespace LandingCtaBlock {
  export type Cta = {
    label: string;
    href: string;
  };

  export type Props = {
    heading: string;
    subtext: Option<string>;
    primaryCta: Cta;
    secondaryCta: Option<Cta>;
  };
}
