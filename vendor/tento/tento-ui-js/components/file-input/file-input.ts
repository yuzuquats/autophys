import "../button/button";
import "../visually-hidden/visually-hidden";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { InputStyles } from "../input/input-styles";

// A file picker and drop zone with a visible button. No `type="file"` existed
// in the tree. The native input is hidden and labelled by a `std-button`, so
// the control keeps the browser's own picker, keyboard activation and the
// `accept` filter; a drop zone on the shadow root takes dragged files; and a
// visually-hidden live region announces how many were chosen (rule R9). Every
// listener is on an own-shadow node, installed once.
@component({ name: "std-file-input" })
export class FileInput extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");
  private $zone: HTMLElement = this.$("zone");
  private $input: HTMLInputElement = this.$("input");
  private $button: Button = this.hydrate("button");
  private $hint: HTMLElement = this.$("hint");
  private $chosen: HTMLElement = this.$("chosen");
  private $error: HTMLElement = this.$("error");
  private $live: HTMLElement = this.$("live");
  private props: Option<FileInput.Props>;
  private static seq = 0;

  constructor() {
    super();
    this.$input.addEventListener("change", () => this.take([...(this.$input.files ?? [])]));
    GESTURE_MANAGER.addPointerEvent(this.$button, { onClick: () => this.$input.click() });
    this.$zone.addEventListener("dragover", (e) => {
      if (this.props?.dropZone !== true) return;
      e.preventDefault();
      this.$zone.toggleAttribute("over", true);
    });
    this.$zone.addEventListener("dragleave", () => this.$zone.removeAttribute("over"));
    this.$zone.addEventListener("drop", (e) => {
      if (this.props?.dropZone !== true) return;
      e.preventDefault();
      this.$zone.removeAttribute("over");
      this.take([...(e.dataTransfer?.files ?? [])]);
    });
  }

  private take(files: File[]): void {
    const props = this.props;
    if (props == null) return;
    const picked = props.multiple ? files : files.slice(0, 1);
    if (picked.length === 0) return;
    this.$chosen.textContent = picked.length === 1 ? picked[0].name : `${picked.length} files`;
    this.$chosen.toggleAttribute("hidden", false);
    this.$live.textContent = picked.length === 1 ? `Chosen: ${picked[0].name}` : `${picked.length} files chosen`;
    props.onFiles(picked);
    this.$input.value = "";
  }

  bind(props: FileInput.Props): this {
    this.props = props;
    const id = `std-file-input-${++FileInput.seq}`;
    this.$input.id = id;
    this.$input.multiple = props.multiple;
    if (props.accept != null) this.$input.accept = props.accept;
    else this.$input.removeAttribute("accept");
    this.$label.textContent = props.label;
    this.$label.setAttribute("for", id);
    this.$button.textContent = props.multiple ? "Choose files" : "Choose a file";
    this.$button.setAttribute("aria-describedby", `${id}-hint`);
    this.$hint.id = `${id}-hint`;
    this.$hint.textContent = props.hint ?? (props.dropZone ? "or drop here" : "");
    this.$hint.toggleAttribute("hidden", this.$hint.textContent === "");
    this.toggleAttribute("drop-zone", props.dropZone);
    const error = props.error;
    this.$error.textContent = error ?? "";
    this.$error.toggleAttribute("hidden", error == null);
    this.toggleAttribute("invalid", error != null);
    this.$chosen.textContent = "";
    this.$chosen.toggleAttribute("hidden", true);
    this.$live.textContent = "";
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$input.value = "";
    this.$label.textContent = "";
    this.$chosen.textContent = "";
    this.$live.textContent = "";
    this.$error.textContent = "";
    this.removeAttribute("drop-zone");
    this.removeAttribute("invalid");
  }

  static makeWith(props: FileInput.Props): FileInput {
    return FileInput.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    Button.$style,
    InputStyles.variables,
    InputStyles.labelStyle,
    css`
      :host {
        display: block;
        width: 100%;
      }

      .native-input {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
      }

      #zone {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: var(--input-padding-block, 8px) var(--input-padding-inline, 10px);
        border-radius: var(--input-border-radius, 8px);
        background: var(--input-bg, var(--bg-surface-light));
        border: var(--input-border-width, 2px) dashed transparent;
      }

      :host([drop-zone]) #zone {
        border-color: var(--divider);
        padding: 20px;
        justify-content: center;
        flex-direction: column;
      }

      :host([drop-zone]) #zone[over] {
        border-color: var(--input-focus-border-color, var(--blue));
      }

      :host([invalid]) #zone {
        border-color: var(--input-invalid-border-color, var(--red));
      }

      .hint,
      #chosen {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }

      #chosen {
        color: var(--text-sec);
      }

      .hint[hidden],
      #chosen[hidden],
      #error[hidden] {
        display: none;
      }

      #error {
        display: block;
        margin-top: 4px;
        margin-left: 10px;
        color: var(--red);
      }
    `,
  ];

  static $html = html`
    <label id="label" class="label"></label>
    <div id="zone">
      <input id="input" class="native-input" type="file" tabindex="-1" aria-hidden="true" />
      <std-button id="button" secondary></std-button>
      <p id="hint" class="small hint" hidden></p>
      <p id="chosen" class="small" hidden></p>
    </div>
    <p id="error" class="small" hidden></p>
    <std-visually-hidden id="live" aria-live="polite"></std-visually-hidden>
  `;
}

export namespace FileInput {
  export type Props = {
    /** The native `accept` filter, e.g. "image/*,.pdf". */
    accept: Option<string>;
    multiple: boolean;
    label: string;
    hint: Option<string>;
    dropZone: boolean;
    onFiles: (files: File[]) => void;
    error: Option<string>;
  };
}
