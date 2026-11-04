import "@tento-ui/components/prosemirror";

import { ProseMirrorEditor } from "@tento-ui/components/prosemirror";
import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";

/** A home card that edits a text row's value for a day. */
@component({ name: "std-text-card" })
export class SheetRowTextCard extends LonaWebComponent {
  private $editor: ProseMirrorEditor = this.hydrate("editor");

  static makeWith(props: SheetRowTextCard.Props): SheetRowTextCard {
    return SheetRowTextCard.make().bind(props);
  }

  bind(props: SheetRowTextCard.Props): this {
    this.$editor.bind({
      onUpdate: props.onUpdate,
      markdown: props.value,
      editable: true,
      placeholder: "Write something...",
    });
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        height: 100%;
      }
      #editor {
        --editor-padding: 16px 12px;
        height: 100%;
      }
    `,
  ];

  static $html = html`<std-prosemirror id="editor"></std-prosemirror>`;
}

export namespace SheetRowTextCard {
  export type Props = {
    value: string;
    onUpdate: (markdown: string) => void;
  };
}
