import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Avatar } from "../../components/avatar";
import { ListCellLayout } from "../../components/list/list-cell-layout";

@component({ name: "std-landing-testimonial" })
export class LandingTestimonial extends LonaWebComponent {
  private $meta: HTMLElement = this.$("meta");
  private $quote: HTMLElement = this.$("quote");

  static makeWith(props: LandingTestimonial.Props): LandingTestimonial {
    return (LandingTestimonial.make() as LandingTestimonial).bind(props);
  }

  bind(props: LandingTestimonial.Props): this {
    this.$quote.textContent = this.$quoteText(props.quote);
    DomUtils.clearChildren(this.$meta);
    this.$meta.appendChild(this.$attributionCell(props));

    return this;
  }

  private $attributionCell(
    props: LandingTestimonial.Props,
  ): ListCellLayout<HTMLElement> {
    const $cell = ListCellLayout.makeText(props.authorName, {
      caption: props.role,
      $icon: this.$avatar(props),
    });
    return $cell;
  }

  private $avatar(props: LandingTestimonial.Props): Avatar {
    if (props.avatarUrl) {
      return Avatar.makeWithImage(props.avatarUrl, undefined, "40");
    }

    const name = props.avatarName ?? props.authorName;
    const base = Avatar.Props.fromUsername(name, {
      size: "40",
      tooltip: name,
    });
    return Avatar.makeWithInitials({
      ...base,
      initials: props.initials ?? base.initials,
      backgroundColor: props.avatarBackground ?? base.backgroundColor,
    });
  }

  private $quoteText(quote: string): string {
    const trimmed = quote.trim();
    const firstCharCode = trimmed.charCodeAt(0);
    const startsWithQuote =
      trimmed.startsWith('"') ||
      firstCharCode === 0x2018 ||
      firstCharCode === 0x201c;
    if (startsWithQuote) return quote;
    return `"${quote}"`;
  }

  static $html = html`
    <std-col id="card">
      <p id="quote"></p>
      <div id="meta"></div>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        border-radius: 14px;
        padding: 32px;
        background: var(--bg);
        border: 1px solid var(--divider);
      }

      #card {
        gap: 0;
        height: 100%;
        justify-content: space-between;
      }

      #meta {
        margin-top: 28px;
      }

      std-list-cell-layout {
        --cell-align: center;
        --list-cell-background-color: transparent;
        --list-cell-layout-hover-color: transparent;
        --list-cell-padding: 0px;
        display: block;
      }

      #quote {
        --font-size: var(--text-13px);
        --line-height-ratio: 1.6;
        color: var(--text-pri);
        font-style: italic;
        font-weight: 500;
        text-align: left;
        --margin-top: 16px;
        --margin-bottom: 16px;
      }
    `,
  ];
}

export namespace LandingTestimonial {
  export type Props = {
    quote: string;
    authorName: string;
    role: string;
    avatarName?: Option<string>;
    initials?: Option<string>;
    avatarUrl?: Option<string>;
    avatarBackground?: Option<string>;
  };
}
