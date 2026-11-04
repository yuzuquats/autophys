import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { Hotkeys } from "../../hotkeys";
import { Typography } from "../../ui/typography";
import { InputStyles } from "../input/input-styles";

// The multi-line half of text-input. `std-text-input` is an `<input>` only,
// though `InputStyles.fieldStyle` already styles `textarea`. This is a native
// `<textarea>` in the same frame: label, helper, error and an optional count,
// all wired through `aria-describedby`; `autoGrow` measures `scrollHeight`
// inside `$$.measure` and writes the height in the mutate phase, so a grow
// never reads and writes layout in the same breath.
//
// Props is total. Every field is written on every bind — including the ones
// that are null — so a pooled instance carries nothing forward. The own-shadow
// listeners are installed once in the constructor and never removed, the
// lesson `text-input` learned.
@component({ name: "std-text-area" })
export class TextArea extends LonaWebComponent {
  private $label: HTMLLabelElement = this.$("label");
  private $labelText: HTMLElement = this.$("label-text");
  private $required: HTMLElement = this.$("required");
  private $textarea: HTMLTextAreaElement = this.$("textarea");
  private $helper: HTMLElement = this.$("helper");
  private $error: HTMLElement = this.$("error");
  private $count: HTMLElement = this.$("count");
  private props: Option<TextArea.Props>;
  private growGeneration = 0;
  private static seq = 0;

  constructor() {
    super();
    this.$textarea.addEventListener("input", () => {
      this.props?.onChange(this.$textarea.value);
      this.reflectCount();
      this.grow();
    });
    this.$textarea.addEventListener("blur", () => this.props?.onBlur?.());
    // Editor keys stay in the field; app hotkeys do not fire from inside it.
    this.onkeydown = this.onkeyup = (e) => {
      const hotkey = DomUtils.hotkeyIdentifier(e);
      if (!hotkey) return;
      if (Hotkeys.allowedHotkeyInEditor(hotkey)) return;
      if (Hotkeys.shouldPreventDefault(hotkey)) e.preventDefault();
      e.stopPropagation();
    };
  }

  bind(props: TextArea.Props): this {
    this.props = props;
    const id = props.name ?? `std-text-area-${++TextArea.seq}`;
    this.$textarea.id = id;
    this.$textarea.name = props.name ?? "";
    this.$label.htmlFor = id;
    this.$labelText.textContent = props.label;
    this.$required.toggleAttribute("hidden", !props.required);
    this.$textarea.required = props.required;
    this.$textarea.disabled = props.disabled;
    this.$textarea.placeholder = props.placeholder ?? "";
    this.$textarea.rows = props.rows;
    if (props.maxLength != null) this.$textarea.maxLength = props.maxLength;
    else this.$textarea.removeAttribute("maxlength");
    if (this.$textarea.value !== props.value) this.$textarea.value = props.value;

    const describedBy: string[] = [];
    const helper = props.helper;
    this.$helper.textContent = helper ?? "";
    this.$helper.toggleAttribute("hidden", helper == null);
    if (helper != null) {
      this.$helper.id = `${id}-helper`;
      describedBy.push(this.$helper.id);
    }
    const error = props.error;
    this.$error.textContent = error ?? "";
    this.$error.toggleAttribute("hidden", error == null);
    this.toggleAttribute("invalid", error != null);
    if (error != null) {
      this.$error.id = `${id}-error`;
      this.$textarea.setAttribute("aria-invalid", "true");
      describedBy.push(this.$error.id);
    } else {
      this.$textarea.removeAttribute("aria-invalid");
    }
    if (props.maxLength != null) {
      this.$count.id = `${id}-count`;
      describedBy.push(this.$count.id);
    }
    this.$count.toggleAttribute("hidden", props.maxLength == null);
    if (describedBy.length > 0) this.$textarea.setAttribute("aria-describedby", describedBy.join(" "));
    else this.$textarea.removeAttribute("aria-describedby");

    this.toggleAttribute("auto-grow", props.autoGrow);
    this.reflectCount();
    this.grow();
    return this;
  }

  private reflectCount(): void {
    const max = this.props?.maxLength;
    if (max == null) return;
    this.$count.textContent = `${this.$textarea.value.length} / ${max}`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.grow();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.growGeneration++;
  }

  private grow(): void {
    const generation = ++this.growGeneration;
    if (this.props?.autoGrow !== true) {
      this.$textarea.style.removeProperty("height");
      return;
    }
    if (!this.isConnected) return;
    const ownsGrowth = () => generation === this.growGeneration && this.isConnected && this.props?.autoGrow === true;
    $$.measure(() => {
      if (!ownsGrowth()) return;
      this.$textarea.style.height = "auto";
      const h = this.$textarea.scrollHeight;
      $$.mutate(() => {
        if (!ownsGrowth()) return;
        this.$textarea.style.height = `${h}px`;
      });
    });
  }

  onRecycle(): void {
    super.onRecycle();
    this.growGeneration++;
    this.props = null;
    this.$textarea.value = "";
    this.$textarea.style.removeProperty("height");
    for (const a of ["aria-describedby", "aria-invalid", "maxlength"]) this.$textarea.removeAttribute(a);
    this.$labelText.textContent = "";
    this.$helper.textContent = "";
    this.$error.textContent = "";
    this.$count.textContent = "";
    this.removeAttribute("invalid");
    this.removeAttribute("auto-grow");
  }

  static makeWith(props: TextArea.Props): TextArea {
    return TextArea.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    InputStyles.variables,
    InputStyles.fieldStyle,
    InputStyles.invalidState,
    InputStyles.labelStyle,
    InputStyles.helperStyle,
    css`
      :host {
        display: block;
        width: 100%;
      }

      textarea {
        display: block;
        resize: vertical;
        min-height: 2.5em;
        line-height: 1.4;
      }

      :host([auto-grow]) textarea {
        resize: none;
        overflow: hidden;
      }

      .required[hidden],
      .helper-text[hidden],
      .error-text[hidden],
      .count[hidden] {
        display: none;
      }

      .error-text {
        display: block;
        margin-top: 4px;
        margin-left: 10px;
        color: var(--red);
      }

      #foot {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }

      .count {
        margin-left: auto;
        margin-top: 4px;
        margin-right: 10px;
        color: var(--text-ter);
        font-variant-numeric: tabular-nums;
      }
    `,
  ];

  static $html = html`
    <label id="label" class="label">
      <span id="label-text"></span>
      <span id="required" class="required" hidden> *</span>
    </label>
    <textarea id="textarea"></textarea>
    <div id="foot">
      <div>
        <p id="helper" class="small helper-text" hidden></p>
        <p id="error" class="small error-text" hidden></p>
      </div>
      <p id="count" class="small count" hidden></p>
    </div>
  `;
}

export namespace TextArea {
  export type Props = {
    value: string;
    label: string;
    placeholder: Option<string>;
    rows: number;
    autoGrow: boolean;
    maxLength: Option<number>;
    helper: Option<string>;
    /** Present = invalid; the text is the reason. */
    error: Option<string>;
    disabled: boolean;
    required: boolean;
    name: Option<string>;
    onChange: (value: string) => void;
    onBlur: Option<EmptyFunction>;
  };
}
