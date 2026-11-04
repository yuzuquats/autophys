import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { LandingUi } from "./landing-ui";

@component({ name: "std-landing-section-intro" })
export class LandingSectionIntro extends LonaWebComponent {
  private $heading: HTMLElement = this.$("heading");
  private $subtext: HTMLElement = this.$("subtext");

  static makeWith(props: LandingSectionIntro.Props): LandingSectionIntro {
    return (LandingSectionIntro.make() as LandingSectionIntro).bind(props);
  }

  bind(props: LandingSectionIntro.Props): this {
    LandingUi.components.typography.bind(this.$heading, { variant: "section-heading", text: props.heading });
    LandingUi.components.typography.bind(this.$subtext, { variant: "section-subtext", text: props.subtext ?? "" });
    return this;
  }

  static $styles = [
    css`
      :host {
        display: grid;
        gap: 24px;
        width: 100%;
        max-width: 820px;
        margin: 0 auto 56px;
        text-align: center;
      }

      #heading,
      #subtext {
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-family: var(--landing-copy-font-family, inherit);
      }

      #heading {
        --font-size: var(--text-22px);
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

      @media (max-width: 768px) {
        :host {
          text-align: left;
          gap: 20px;
          margin-bottom: 38px;
        }

        #heading {
          --font-size: var(--text-22px);
        }
      }
    `,
  ];

  static $html = html`
    <h2 id="heading"></h2>
    <p id="subtext"></p>
  `;
}

export namespace LandingSectionIntro {
  export type Props = {
    heading: string;
    subtext: Option<string>;
  };
}
