import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";

@component({ name: "std-landing-content-frame" })
export class LandingContentFrame extends LonaWebComponent {
  private $frame: HTMLElement = this.$("frame");

  static makeWith(props: LandingContentFrame.Props): LandingContentFrame {
    return (LandingContentFrame.make() as LandingContentFrame).bind(props);
  }

  bind(props: LandingContentFrame.Props): this {
    DomUtils.clearChildren(this.$frame);
    this.setAttribute("variant", props.variant);
    this.$frame.appendChild(props.content);
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        margin-left: auto;
        margin-right: auto;
      }

      :host([variant="pricing"]) {
        max-width: 940px;
        min-height: 520px;
      }

      :host([variant="pricing"]) #frame,
      :host([variant="pricing"]) #frame > * {
        width: 100%;
        min-height: 520px;
      }

      @media (max-width: 768px) {
        :host([variant="pricing"]),
        :host([variant="pricing"]) #frame,
        :host([variant="pricing"]) #frame > * {
          min-height: 0;
        }
      }
    `,
  ];

  static $html = html`<div id="frame"></div>`;
}

export namespace LandingContentFrame {
  export type Variant = "pricing";

  export type Props = {
    variant: Variant;
    content: HTMLElement;
  };
}
