import "../rich-text-editor/rich-text-editor";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { RichTextEditor } from "../rich-text-editor/rich-text-editor";
import { Documentation } from "../documentation/documentation";
import { Scrollbars } from "../scrollbars";

@component({ name: "std-pres-doc" })
export class PresentationDoc extends LonaWebComponent {
  private $editor: RichTextEditor = this.hydrate("editor");

  bind(props: PresentationDoc.Props): this {
    Documentation.serde.get().then(async (serde) => {
      await this.$editor.bind({
        markdown: props.markdown,
        editable: false,
        serde,
      });
    });
    return this;
  }

  static $styles = [
    Scrollbars.$hideScrollbars,
    Documentation.$docStyle,
    css`
      :host {
        display: block;
        width: 100%;
        --h1-size: var(--text-32px);
        --h2-size: var(--text-24px);
        --h3-size: var(--text-18px);
        --h4-size: var(--text-15px);
        --h5-size: var(--text-15px);
        --editor-max-width: none;
        --editor-padding: 0px;
        padding-inline: 16px;
      }

      p {
        --font-size: var(--text-15px);
        --line-height-ratio: 1.3;
        --margin-bottom: 18px;
      }

      img {
        display: block;
        max-width: 100%;
        max-height: 360px;
        width: auto;
        height: auto;
        margin-block: 24px auto;
        border-radius: 20px;
        box-shadow:
          0 12px 48px rgba(0, 0, 0, 0.2),
          0 2px 8px rgba(0, 0, 0, 0.08);
      }

      pre {
        padding: 12px;
        background: #2a3342;
        color: white;
        border-radius: 8px;
        line-height: 2;
        max-width: 840px;
      }

      code {
        white-space: break-spaces;
        font-size: 1rem;
      }
    `,
  ];

  static $html =
    html`<std-rich-text-editor id="editor"></std-rich-text-editor>`;
}

export namespace PresentationDoc {
  export type Props = {
    markdown: string;
  };
}
