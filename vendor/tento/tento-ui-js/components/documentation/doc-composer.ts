import "../prosemirror";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { ProseMirrorEditor } from "../prosemirror";

// ── Composer ─────────────────────────────────────────────────────────────────

const PLACEHOLDER = "Add a comment…";

@component({ name: "std-doc-composer" })
export class DocComposer extends LonaWebComponent {
  private $editor: ProseMirrorEditor = this.hydrate<ProseMirrorEditor>("editor");
  private $cancel: HTMLElement = this.$("cancel");
  private $submit: HTMLButtonElement = this.$<HTMLButtonElement>("submit");

  private onCancel: Option<EmptyFunction> = null;
  private onSubmitBody: Option<(body: string) => void> = null;
  /** Live markdown of the editor, tracked via the editor's `onUpdate` callback
   *  (mirrors FeedbackAlert's `feedbackValue`). The submit handler reads this
   *  rather than a `.value` getter so the composer and the reference modal share
   *  one value-capture path. */
  private bodyValue: string = "";

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$cancel, {
      onClick: () => this.onCancel?.(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$submit, {
      onClick: () => this.onSubmitBody?.(this.bodyValue),
    });
  }

  bind(vm: DocComposer.ViewModel): void {
    this.onCancel = vm.onCancel;
    this.onSubmitBody = vm.onSubmit;
    // Reset to an empty draft — a pooled instance must never show a stale one.
    this.bodyValue = "";
    void this.$editor.bind({
      markdown: "",
      editable: true,
      placeholder: PLACEHOLDER,
      onUpdate: (md) => {
        this.bodyValue = md;
      },
    });
  }

  positionAt(left: number, top: number): void {
    this.style.position = "fixed";
    this.style.left = `${Math.max(4, left)}px`;
    this.style.top = `${Math.max(4, top)}px`;
  }

  /** The composer opens without stealing focus — the operator clicks into the
   *  editor to start typing. Kept as a no-op so the controller's open path need
   *  not special-case it. */
  focusInput(): void {}

  onRecycle(): void {
    super.onRecycle();
    this.onCancel = null;
    this.onSubmitBody = null;
    this.bodyValue = "";
  }

  static $styles = [
    css`
      :host {
        display: block;
        z-index: 2147483000;
        width: 320px;
        max-width: calc(100vw - 24px);
        box-sizing: border-box;
        padding: 12px;
        border-radius: 12px;
        border: 1px solid var(--divider);
        background: var(--bg-elevated);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2);
      }

      #editor {
        box-sizing: border-box;
        /* Flex column so the inner ProseMirror editable (flex-grow: 1) fills the
           whole box — otherwise it sits as a thin strip at the top and the empty
           space below is dead (not clickable to type). */
        display: flex;
        flex-direction: column;
        width: 100%;
        min-height: 64px;
        max-height: 240px;
        --editor-padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid var(--divider);
        background: var(--bg);
        color: var(--text-pri);
        font: inherit;
        font-size: 13px;
        /* The whole box is a typeable surface — a click anywhere lands a caret,
           not just on the thin first line. */
        cursor: text;
        transition: border-color 0.15s ease;
      }

      #editor:focus-within {
        border-color: var(--blue);
      }

      #actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 10px;
      }

      .cbtn {
        padding: 5px 14px;
        border-radius: 999px;
        border: 1px solid var(--divider);
        background: var(--bg);
        color: var(--text-pri);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }

      .cbtn.primary {
        background: var(--blue);
        border-color: var(--blue);
        color: #fff;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-prosemirror id="editor"></std-prosemirror>
    <div id="actions">
      <button id="cancel" type="button" class="cbtn">Cancel</button>
      <button id="submit" type="button" class="cbtn primary">Comment</button>
    </div>
  `;
}

export namespace DocComposer {
  export interface ViewModel {
    onCancel: EmptyFunction;
    onSubmit: (body: string) => void;
  }
}
