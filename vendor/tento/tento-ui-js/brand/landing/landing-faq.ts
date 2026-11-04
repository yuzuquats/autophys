import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Accordion } from "../../components/accordion";
import { DomUtils } from "../../dom";

@component({ name: "std-landing-faq" })
export class LandingFaq extends LonaWebComponent {
  private $content: HTMLElement = this.$("content");

  static makeWith(props: LandingFaq.Props): LandingFaq {
    return (LandingFaq.make() as LandingFaq).bind(props);
  }

  bind(props: LandingFaq.Props): this {
    DomUtils.clearChildren(this.$content);
    this.$content.appendChild(Accordion.makeWith({
      items: props.items.map((item) => ({
        header: item.question,
        content: item.answer,
      })),
    }));
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        max-width: 900px;
        margin-left: auto;
        margin-right: auto;
      }

      std-accordion {
        display: block;
        width: 100%;
        --accordion-header-font-size: var(--text-12px);
        --accordion-content-font-size: var(--text-11px);
        --accordion-content-line-height-ratio: 1.58;
        --accordion-header-padding: 13px 8px;
        --accordion-content-padding: 8px 18px 26px 34px;
        --accordion-focus-outline: 2px solid var(--blue);
        overflow: visible;
        border: none;
        border-radius: 0;
        background: transparent;
        box-sizing: border-box;
      }
    `,
  ];

  static $html = html`<div id="content"></div>`;
}

export namespace LandingFaq {
  export type Item = {
    question: string;
    answer: string;
  };

  export type Props = {
    items: Item[];
  };
}
