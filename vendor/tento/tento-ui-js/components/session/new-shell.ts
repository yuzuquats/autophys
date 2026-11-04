// Side-effect imports beside the named ones, and they are load-bearing: the
// `<std-…>` tags in `$html` resolve through the custom-element REGISTRY, which
// a class only joins when its module is EVALUATED. A named import used only in
// a type position is erased by the bundler and the tag stays inert — silently,
// with no surface and no error. See `thread/actions-modal.ts`, which shipped
// broken by exactly this.
import "../round";
import "../modal-close-button/modal-close-button";

import { html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { ModalCloseButton } from "../modal-close-button/modal-close-button";
import { Round } from "../round";
import { LonaModalWebComponent } from "../../ui/modal-component";

/** `std-new-shell` — the dialog behind "new shell".
 *
 * ## Why the prompt is optional, and why that is two things
 *
 * A shell with an opening message and a shell without one are different acts,
 * not one act with a blank field. With a prompt, the session is created, an
 * agent lane is declared and the unit is submitted — the thing every agent
 * surface calls "start a thread". Without one, a session simply exists and
 * waits. The server keeps them as two paths because tsh does; this dialog
 * keeps them as ONE form because the operator does not care which entry point
 * runs, only whether they have something to say yet.
 *
 * So `handler` is disclosed but only consulted when a prompt is present, and
 * the submit label says which act is about to happen. A form whose button
 * reads the same for both would be a form that hides the distinction it
 * exists to express.
 *
 * ## It does not create anything
 *
 * `onCreate` is the caller's. This component collects, validates that the
 * shape is sane, and hands over — it holds no fetch, no URL and no knowledge
 * that a spool exists, which is what lets the same dialog sit on any surface
 * that can make a session. */
@component({ name: "std-new-shell" })
export class NewShell extends LonaModalWebComponent {
  /** The harnesses the server will accept. Duplicated from the node's own
   * `HANDLERS` rather than fetched: a three-item list that changes when a
   * vendor is added is not worth a round trip, and a stale entry fails
   * loudly at the server with a readable 400. */
  static readonly HANDLERS: readonly string[] = ["codex", "claude", "opencode"];

  private $bg: Round = this.hydrate<Round>("bg").bind(Round.Props.MODAL);
  private $close: ModalCloseButton = this.hydrate("close");
  private $handlers: HTMLElement = this.$("handlers");
  private $name: HTMLInputElement = this.$("name") as HTMLInputElement;
  private $prompt: HTMLTextAreaElement = this.$("prompt") as HTMLTextAreaElement;
  private $submit: HTMLButtonElement = this.$("submit") as HTMLButtonElement;
  private $error: HTMLElement = this.$("error");

  private handler: string = NewShell.HANDLERS[0];
  private onCreate: Option<(request: NewShell.Request) => Promise<void>>;
  private busy: boolean = false;

  static makeWith(props: NewShell.Props): NewShell {
    return (NewShell.make() as NewShell).bind(props);
  }

  bind(props: NewShell.Props): this {
    this.onCreate = props.onCreate;
    this.handler = NewShell.HANDLERS[0];
    this.busy = false;
    this.$name.value = "";
    this.$prompt.value = "";
    this.$error.textContent = "";
    this.$error.hidden = true;
    this.buildHandlers();
    this.syncSubmit();
    this.$close.bind({ onDismiss: () => this.dismiss(), scrollSource: null });
    return this;
  }

  /** One button per harness. Buttons rather than a `<select>`: there are
   * three, they are the form's only branching choice, and a native select on
   * a dark surface is the one control that cannot be themed consistently
   * across platforms. */
  private buildHandlers(): void {
    this.$handlers.replaceChildren(...NewShell.HANDLERS.map((name) => {
      const $option = document.createElement("button");
      $option.type = "button";
      $option.className = "handler";
      $option.textContent = name;
      $option.toggleAttribute("selected", name === this.handler);
      $option.addEventListener("click", () => {
        this.handler = name;
        this.buildHandlers();
      });
      return $option;
    }));
  }

  /** The label names the act. See the class doc — the two paths are the
   * point, so the button must not read the same for both. */
  private syncSubmit(): void {
    const prompt = this.$prompt.value.trim();
    this.$submit.textContent = this.busy
      ? "Creating…"
      : prompt === ""
      ? "Create shell"
      : `Create and run in ${this.handler}`;
    this.$submit.disabled = this.busy;
  }

  private async submit(): Promise<void> {
    if (this.busy || this.onCreate == null) return;
    const name = this.$name.value.trim();
    const prompt = this.$prompt.value.trim();
    this.busy = true;
    this.$error.hidden = true;
    this.syncSubmit();
    try {
      await this.onCreate({
        name: name === "" ? undefined : name,
        prompt: prompt === "" ? undefined : prompt,
        handler: prompt === "" ? undefined : this.handler,
      });
      this.dismiss();
    } catch (error) {
      // The failure stays ON the dialog with the operator's typing intact.
      // Dismissing on error would discard a prompt they may have spent a
      // minute writing, to show them a message about why it did not run.
      this.busy = false;
      this.$error.textContent = String(error);
      this.$error.hidden = false;
      this.syncSubmit();
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.$prompt.addEventListener("input", () => this.syncSubmit());
    this.$submit.addEventListener("click", () => void this.submit());
  }

  static $styles: Style.Compat[] = [
    LonaModalWebComponent.$style,
    css`
      :host {
        --std-modal-max-width: 520px;
        background: transparent;
      }
      #root {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 18px 20px 20px;
      }
      #title {
        --margin-top: 0px;
        --margin-bottom: 0px;
        padding-right: 32px;
      }
      /* The button carries its own inset as a margin and leaves the AXIS to
         the modal — the same contract the actions modal states. Without this
         it anchors at the left edge and lands on the title, which rendered as
         "Ne X shell". The title's padding-right is the other half. */
      #close {
        right: 0;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .label {
        color: var(--text-ter, #8b93a7);
        font-size: 11px;
        letter-spacing: 0.02em;
        text-transform: uppercase;
      }
      #handlers {
        display: flex;
        gap: 6px;
      }
      /* The selected harness is a FILL, not a border: a ring on one of three
         adjacent buttons shifts their optical baseline, and the row stops
         reading as one control. */
      .handler {
        flex: 1;
        padding: 7px 10px;
        border: 1px solid var(--divider, #d8dee9);
        border-radius: 8px;
        background: transparent;
        color: var(--text-sec, #5c6370);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .handler[selected] {
        background: var(--fg-blue, #3b82f6);
        border-color: var(--fg-blue, #3b82f6);
        color: #fff;
      }
      input,
      textarea {
        box-sizing: border-box;
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--divider, #d8dee9);
        border-radius: 8px;
        background: var(--bg, transparent);
        color: var(--text-pri, #1f2328);
        font: inherit;
        font-size: 13px;
      }
      textarea {
        min-height: 88px;
        resize: vertical;
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      }
      input:focus,
      textarea:focus {
        outline: 2px solid var(--fg-blue, #3b82f6);
        outline-offset: -1px;
      }
      #submit {
        align-self: flex-end;
        padding: 9px 16px;
        border: none;
        border-radius: 8px;
        background: var(--fg-blue, #3b82f6);
        color: #fff;
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
      }
      #submit:disabled {
        opacity: 0.6;
        cursor: default;
      }
      #error {
        color: var(--fg-red, #e5484d);
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      #error[hidden] {
        display: none;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <std-round id="bg" floating></std-round>
      <h2 id="title" class="h6">New shell</h2>
      <div class="field">
        <span class="label">Name (optional)</span>
        <input id="name" type="text" placeholder="a saved name for this session" />
      </div>
      <div class="field">
        <span class="label">Opening message (optional)</span>
        <textarea id="prompt" placeholder="leave empty for a shell that just waits"></textarea>
      </div>
      <div class="field">
        <span class="label">Harness</span>
        <div id="handlers"></div>
      </div>
      <span id="error" hidden></span>
      <button id="submit" type="button"></button>
      <std-modal-close-button id="close"></std-modal-close-button>
    </div>
  `;
}

export namespace NewShell {
  /** What the operator asked for. Field names match the node's
   * `CreateTerminalRequest` so the caller is a JSON.stringify away. */
  export type Request = {
    name?: string;
    prompt?: string;
    handler?: string;
  };

  export type Props = {
    /** Rejects to keep the dialog open with the message shown. */
    onCreate: (request: Request) => Promise<void>;
  };
}
