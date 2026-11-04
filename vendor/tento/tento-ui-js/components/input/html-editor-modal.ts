import "../round";

import { html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { LonaModalWebComponent } from "../../ui/modal-component";
import { Button } from "../button/button";
import { HtmlEditor } from "../html-editor";
import { Overlay } from "../overlay";
import { Round } from "../round";

@component({
  name: "std-html-editor-modal",
})
export class HtmlEditorModal extends LonaModalWebComponent {
  private $bg: Round = this.hydrate<Round>("bg").bind(Round.Props.MODAL);

  private $htmlEditor: HtmlEditor = this.hydrate("html-editor");
  private $cancelButton: HTMLButtonElement = this.hydrate("cancel-button");
  private $saveButton: HTMLButtonElement = this.hydrate("save-button");
  private $title: HTMLElement = this.hydrate("title");

  private occupant = 0;
  private onHtmlSaved?: (html: Option<string>) => void;
  private currentHtml: Option<string>;

  static async show(
    title: string,
    currentHtml: Option<string>,
    onHtmlSaved: (html: Option<string>) => void,
    context: string,
  ): Promise<void> {
    const $m = HtmlEditorModal.make();
    $m.setAttribute("context", context);
    $m.bind(title, currentHtml, onHtmlSaved);
    $m.reveal(Overlay.instance.get(), context);
  }

  bind(
    title: string,
    currentHtml: Option<string>,
    onHtmlSaved: (html: Option<string>) => void,
  ) {
    const occupant = ++this.occupant;
    this.$title.textContent = title;
    this.onHtmlSaved = onHtmlSaved;
    this.currentHtml = currentHtml;

    this.$htmlEditor.bind({
      html: currentHtml,
      editable: true,
      onChange: (html) => {
        if (occupant !== this.occupant) return;
        this.currentHtml = html;
      },
    });

    // Handle cancel button
    this.$cancelButton.onclick = () => {
      if (occupant !== this.occupant) return;
      this.onModalDismiss();
      Overlay.dismiss(this);
    };

    this.$saveButton.onclick = () => {
      if (occupant !== this.occupant) return;
      const saved = this.onHtmlSaved;
      const html = this.currentHtml;
      this.onModalDismiss();
      saved?.(html);
      Overlay.dismiss(this);
    };
  }

  onModalDismiss() {
    this.occupant++;
    this.$htmlEditor.onRecycle();
    this.$saveButton.onclick = null;
    this.$cancelButton.onclick = null;
    this.onHtmlSaved = undefined;
    this.currentHtml = undefined;
  }

  onRecycle(): void {
    this.onModalDismiss();
    this.$title.textContent = "";
    super.onRecycle();
  }

  static $styles: Style.Compat[] = [
    LonaModalWebComponent.$headerStyle,
    LonaModalWebComponent.$style,
    Button.$style,
    css`
      :host {
        --std-modal-max-width: 800px;
      }

      #content {
        flex: 1;
      }

      #html-editor {
        width: 100%;
        height: 100%;
        --editor-padding: 20px;
        flex-grow: 1;
      }

      #footer {
        padding: 12px 16px;
        border-top: 1px solid var(--divider);
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
    `,
  ];

  static $html = html`
    <std-col id="root">
      <std-round floating id=bg></std-round>

      <std-col id="header" class=modal-header>
        <h3 id="title" class="h6 modal-title"></h3>
      </std-col>

      <std-col id="content">
        <std-html-editor id="html-editor"></std-html-editor>
      </std-col>

      <std-row id="footer">
        <button id="cancel-button" secondary>Cancel</button>
        <button id="save-button" primary>Save</button>
      </std-row>
    </std-col>
  `;
}
