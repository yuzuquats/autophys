import "../components/accordion";

import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Typography } from "../ui/typography";
import { Accordion } from "../components/accordion";

@component({
  name: "std-marketing-faq",
})
export class MarketingFaq extends LonaWebComponent {
  private items: MarketingFaq.FaqItem[] = [];
  private $accordion: Accordion = this.hydrate("accordion");

  bind(props: MarketingFaq.Props): void {
    this.items = props.items;

    // Clear and set title if provided
    if (props.title) {
      this.clearChildren();
      if (typeof props.title === "string") {
        const $title = Typography.h2(props.title, "h4");
        $title.slot = "title";
        $title.classList.add("faq-title");
        this.appendChild($title);
      } else {
        props.title.slot = "title";
        this.appendChild(props.title);
      }
    }

    this.render();
  }

  private render(): void {
    this.$accordion.bind({
      items: this.items.map((item) => ({
        header: item.question,
        content: item.answer,
      })),
    });
  }

  static makeWith(props: MarketingFaq.Props): MarketingFaq {
    const component = MarketingFaq.make();
    component.bind(props);
    return component;
  }

  static $html = html`
    <slot name="title" id="title-slot"></slot>
    <std-accordion id="accordion"></std-accordion>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      ::slotted(.faq-title),
      .faq-title {
        font-size: var(--text-18px);
        font-weight: normal;
        margin-bottom: 16px;
        padding: 0 12px;
        display: block;
      }

      #title-slot {
        display: block;
      }

      #accordion {
        padding: 16px 0;
      }
    `,
  ];
}

export namespace MarketingFaq {
  export interface FaqItem {
    question: string;
    answer: string;
  }

  export type Props = {
    items: FaqItem[];
    title?: Option<string | HTMLElement>;
  };
}
