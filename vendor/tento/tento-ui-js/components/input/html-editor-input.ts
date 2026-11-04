import "./html-editor-modal";
import "../html-editor";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { HtmlEditor } from "../html-editor";
import { HtmlEditorModal } from "./html-editor-modal";

@component({
  name: "std-html-editor-input",
})
export class HtmlEditorInput extends LonaWebComponent {
  private $editor: HtmlEditor = this.hydrate("editor");

  private occupant = 0;

  private htmlContent: Option<string> = undefined;
  private onChange?: (html: Option<string>) => void;
  private modalTitle: string = "Edit HTML";
  private placeholder: string = "Click to edit HTML";

  bind(options?: {
    html?: Option<string>;
    onChange?: (html: Option<string>) => void;
    modalTitle?: string;
    placeholder?: string;
  }) {
    this.occupant++;
    this.htmlContent = options?.html;
    this.onChange = options?.onChange;
    this.modalTitle = options?.modalTitle ?? "Edit HTML";
    this.placeholder = options?.placeholder ?? "Click to edit HTML";

    this.updateEditor();
  }

  static makeWith(options: {
    html?: Option<string>;
    onChange?: (html: Option<string>) => void;
    modalTitle?: string;
    placeholder?: string;
  }): HtmlEditorInput {
    const input = HtmlEditorInput.make();
    input.bind(options);
    return input;
  }

  openHtmlEditor(context: string) {
    const occupant = this.occupant;
    HtmlEditorModal.show(
      this.modalTitle,
      this.htmlContent,
      (html) => {
        if (occupant !== this.occupant) return;
        this.htmlContent = html;
        this.updateEditor();
        this.onChange?.(html);
      },
      context,
    );
  }

  private updateEditor() {
    if (this.htmlContent) {
      this.$editor.bind({
        html: this.htmlContent,
        editable: false,
      });
    } else {
      this.$editor.bind({
        html: `<p style="color: var(--text-ter)">${this.placeholder}</p>`,
        editable: false,
      });
    }
  }

  onRecycle(): void {
    this.occupant++;
    // Hydrated shadow children belong to this parent, not the light-child pool.
    this.$editor.onRecycle();
    this.onChange = undefined;
    this.htmlContent = undefined;
    this.modalTitle = "Edit HTML";
    this.placeholder = "Click to edit HTML";
    super.onRecycle();
  }

  get html(): Option<string> {
    return this.htmlContent;
  }

  set html(value: Option<string>) {
    this.htmlContent = value;
    this.updateEditor();
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #root {
        width: 100%;
        height: 100%;
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <std-html-editor id="editor"></std-html-editor>
    </div>
  `;
}

export namespace HtmlEditorInput {
  export type Props = {
    html?: Option<string>;
    onChange?: (html: Option<string>) => void;
    modalTitle?: string;
    placeholder?: string;
  };
}
