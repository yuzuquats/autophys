import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";

// Quoted content with its source: `<figure><blockquote cite><figcaption>`,
// which is the markup that already means "a quotation, attributed". Nothing in
// the tree rendered one.
@component({ name: "std-blockquote" })
export class Blockquote extends LonaWebComponent {
  private $quote: HTMLQuoteElement = this.$("quote");
  private $text: HTMLElement = this.$("text");
  private $caption: HTMLElement = this.$("caption");

  bind(props: Blockquote.Props): this {
    this.$text.textContent = props.quote;
    if (props.cite == null) this.$quote.removeAttribute("cite");
    else this.$quote.setAttribute("cite", props.cite);
    const attribution = props.attribution;
    this.$caption.textContent = attribution == null ? "" : `— ${attribution}`;
    this.$caption.toggleAttribute("hidden", attribution == null);
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.$text.textContent = "";
    this.$quote.removeAttribute("cite");
    this.$caption.textContent = "";
    this.$caption.toggleAttribute("hidden", true);
  }

  static makeWith(props: Blockquote.Props): Blockquote {
    return Blockquote.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --blockquote-rule: var(--blockquote-rule-preset, var(--divider));
        --blockquote-color: var(--blockquote-color-preset, var(--text-sec));
        --blockquote-inset: 12px;

        display: block;
        width: 100%;
      }

      figure {
        margin: 0;
        padding-inline-start: var(--blockquote-inset);
        border-inline-start: 3px solid var(--blockquote-rule);
      }

      blockquote {
        margin: 0;
      }

      #text {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--blockquote-color);
        font-style: italic;
      }

      figcaption {
        --font-size: var(--small-size);
        margin-top: 6px;
        color: var(--text-ter);
      }

      figcaption[hidden] {
        display: none;
      }
    `,
  ];

  static $html = html`
    <figure>
      <blockquote id="quote"><p id="text"></p></blockquote>
      <figcaption id="caption" hidden></figcaption>
    </figure>
  `;
}

export namespace Blockquote {
  export type Props = {
    quote: string;
    attribution: Option<string>;
    /** A URL for the `cite` attribute — the source, machine-readable. */
    cite: Option<string>;
  };
}
