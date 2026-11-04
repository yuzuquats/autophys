import "./recurrence-editor";
import "./round";

import { NaiveDate } from "@tento-chrono";
import { html } from "../component";
import { component } from "../component-decorators";
import { Style, css } from "../component-styles";
import { LonaModalWebComponent } from "../ui/modal-component";
import { Button } from "./button/button";
import { Overlay } from "./overlay";
import { RecurrenceEditor, RecurrenceModel } from "./recurrence-editor";
import { Round } from "./round";

@component({
  name: "std-recurrence-editor-modal",
})
export class RecurrenceEditorModal extends LonaModalWebComponent {
  private $bg: Round = this.hydrate<Round>("bg")
    .bind(Round.Props.MODAL);

  private $editor: RecurrenceEditor = this.hydrate("editor");
  private $cancelButton: HTMLButtonElement = this.$("cancel-button");
  private $saveButton: HTMLButtonElement = this.$("save-button");
  private $title: HTMLElement = this.$("title");

  private onSave?: Option<(model: RecurrenceModel) => void>;
  private currentModel?: Option<RecurrenceModel>;

  static async show(
    title: string,
    referenceDate: NaiveDate,
    currentModel: RecurrenceModel,
    onSave: (model: RecurrenceModel) => void,
    context: Option<string>,
  ): Promise<void> {
    const $modal = RecurrenceEditorModal.make();
    $modal.bind(title, referenceDate, currentModel, onSave, context);
    $modal.setAttribute("context", context ?? "");
    $modal.reveal(Overlay.instance.get(), context);
  }

  bind(
    title: string,
    referenceDate: NaiveDate,
    currentModel: RecurrenceModel,
    onSave: (model: RecurrenceModel) => void,
    context?: Option<string>,
  ): this {
    this.$title.textContent = title;
    this.onSave = onSave;
    this.currentModel = currentModel;

    // Bind the recurrence editor
    this.$editor.bind({
      referenceDate,
      model: currentModel,
      onChange: (model) => {
        this.currentModel = model;
      },
      modalContext: context,
    });

    // Handle cancel button
    this.$cancelButton.onclick = () => {
      Overlay.dismiss(this);
    };

    // Handle save button
    this.$saveButton.onclick = () => {
      if (this.currentModel) {
        this.onSave?.(this.currentModel);
        Overlay.dismiss(this);
      }
    };

    return this;
  }

  onModalDismiss() {
    this.onSave = null;
    this.currentModel = null;
  }

  static $styles: Style.Compat[] = [
    LonaModalWebComponent.$headerStyle,
    LonaModalWebComponent.$style,
    Button.$style,
    css`
      :host {
        --std-modal-max-width: 480px;
      }

      #root {
        padding: 0;
        min-height: 500px;
        position: relative;
      }

      #content {
        padding: 20px;
        flex: 1;
        overflow-y: auto;
      }

      #footer {
        padding: 12px 16px;
        border-top: 1px solid var(--divider);
        justify-content: flex-end;
        gap: 8px;
      }
    `,
  ];

  static $html = html`
    <std-col id="root">
      <std-round id=bg floating></std-round>

      <std-col id="header" class=modal-header>
        <h3 id="title" class="h6 modal-title"></h3>
      </std-col>
      <std-col id="content">
        <std-recurrence-editor id="editor"></std-recurrence-editor>
      </std-col>
      <std-row id="footer">
        <button id="cancel-button" secondary>Cancel</button>
        <button id="save-button" primary>Save</button>
      </std-row>
    </std-col>
  `;
}
