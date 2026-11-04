import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Hotkeys } from "../../hotkeys";
import { Typography } from "../../ui/typography";

@component({
  name: "std-text-input",
})
export class TextInput extends LonaWebComponent {
  private $label = this.hydrate<HTMLLabelElement>("label");
  private $labelText = this.hydrate<HTMLSpanElement>("label-text");
  private $required = this.hydrate<HTMLSpanElement>("required");
  private $input = this.hydrate<HTMLInputElement>("input");
  private $helper = this.hydrate<HTMLParagraphElement>("helper");
  private $error = this.hydrate<HTMLParagraphElement>("error");

  onChange?: Option<(value: string) => void>;
  onBlur?: Option<(value: string) => void>;

  private handleInput = () => {
    this.onChange?.(this.$input.value);
  };

  private handleBlur = () => {
    this.onBlur?.(this.$input.value);
  };

  constructor() {
    super();
    // `$input` is this component's OWN shadow node, and `_recycle` clears only
    // light DOM — so these outlive every detach and must never be removed on
    // disconnect. Removing them made a pooled input render, accept typing, and
    // silently stop reporting.
    this.$input.addEventListener("input", this.handleInput);
    this.$input.addEventListener("blur", this.handleBlur);
    this.onkeydown = this.onkeyup = (e) => {
      const hotkey = DomUtils.hotkeyIdentifier(e);
      if (!hotkey) return;
      if (Hotkeys.allowedHotkeyInEditor(hotkey)) return;
      if (Hotkeys.shouldPreventDefault(hotkey)) e.preventDefault();
      e.stopPropagation();
    };
  }

  // Listeners belong to this instance: moving a form into a presentation must
  // not disable its input/blur callbacks when it is attached again.

  static makeWith(props: TextInput.Props): TextInput {
    const instance = TextInput.make();
    instance.bind(props);
    return instance;
  }

  bind(props: TextInput.Props): this {
    // Generate unique ID for accessibility linking
    const inputId =
      props.name ?? `input-${Math.random().toString(36).slice(2, 9)}`;
    const helperId = `${inputId}-helper`;

    // Label
    const hasLabel = props.label != null;
    this.$label.style.display = hasLabel ? "block" : "none";
    if (hasLabel) {
      this.$labelText.textContent = props.label!;
      this.$label.setAttribute("for", inputId);
    }

    // Required indicator
    this.$required.style.display = props.required ? "inline" : "none";

    // Input attributes
    this.$input.type = props.type ?? "text";
    this.$input.name = props.name ?? "";
    this.$input.id = inputId;
    this.$input.value = props.value ?? "";
    this.$input.placeholder = props.placeholder ?? "";
    this.$input.required = props.required ?? false;
    this.$input.disabled = props.disabled ?? false;

    // Helper text with aria-describedby linkage
    const hasHelper = props.helperText != null;
    this.$helper.style.display = hasHelper ? "block" : "none";
    if (hasHelper) {
      this.$helper.textContent = props.helperText!;
      this.$helper.id = helperId;
      this.$input.setAttribute("aria-describedby", helperId);
    } else {
      this.$input.removeAttribute("aria-describedby");
    }

    // Error/invalid state (using [invalid] attribute to match HTML5)
    if (props.error) {
      this.$input.setAttribute("aria-invalid", "true");
      this.setAttribute("invalid", "");
    } else {
      this.$input.removeAttribute("aria-invalid");
      this.removeAttribute("invalid");
    }

    // Callbacks
    this.onChange = props.onChange;
    this.onBlur = props.onBlur;

    return this;
  }

  /**
   * Set the invalid state for this input.
   * Uses [invalid] attribute which matches HTML5 constraint validation.
   */
  setInvalid(hasError: boolean, errorText?: Option<string>): void {
    if (hasError) {
      this.$input.setAttribute("aria-invalid", "true");
      this.setAttribute("invalid", "");
      if (errorText) {
        this.$error.textContent = errorText;
        this.$error.style.display = "block";
      }
    } else {
      this.$input.removeAttribute("aria-invalid");
      this.removeAttribute("invalid");
      this.$error.textContent = "";
      this.$error.style.display = "none";
    }
  }

  /**
   * @deprecated Use setInvalid() instead
   */
  setError(hasError: boolean, errorText?: Option<string>): void {
    this.setInvalid(hasError, errorText);
  }

  getValue(): string {
    return this.$input.value;
  }

  setValue(value: string): void {
    this.$input.value = value;
  }

  focus(): void {
    this.$input.focus();
  }

  static $styles = [
    Typography.$style,
    css`
      /* The field's frame, and the one number derived from it.

         A label, a caption and an error all want to start where the field's
         OWN text starts — on the placeholder, not on the border box that
         happens to be 12px to its left. That inset is not a taste value: it is
         the border plus the horizontal padding, and it is wrong the moment
         anyone writes it down a second time. So it is written once, here, and
         the input is drawn from the same two numbers it is derived from. Move
         the padding and every line that hangs off the field moves with it. */
      :host {
        display: block;
        position: relative;
        margin-bottom: var(--form-input-margin-bottom, 0px);
        --input-border-width: 2px;
        --input-pad-x: 10px;
        --input-text-inset: calc(var(--input-border-width) + var(--input-pad-x));
      }

      .label {
        display: block;
        margin-left: var(--input-text-inset);
        margin-bottom: 4px;
        color: var(--text-sec);
      }

      .required {
        color: var(--red);
      }

      input {
        background: var(--bg-surface-light);
        height: 38px;
        padding: 0 var(--input-pad-x);
        border: var(--input-border-width) solid transparent;
        border-radius: 8px;
        color: var(--text-pri);
        font-family: inherit;
        --font-size: var(--p-size);
        width: 100%;
        box-sizing: border-box;
        transition: border-color 0.3s ease;
      }

      input:focus {
        outline: none;
        border-color: var(--blue);
      }

      input::placeholder {
        color: var(--text-ter);
      }

      input:disabled {
        opacity: 1;
        cursor: not-allowed;
      }

      .helper-text {
        display: block;
        margin-top: 4px;
        margin-left: var(--input-text-inset);
        color: var(--text-ter);
      }

      :host([invalid]) input {
        border-color: var(--red);
      }

      /* The error starts on the field's text, like everything else that hangs
         off it. It is the line that appears exactly when the operator is
         already having a bad time, so it is the worst one to leave sitting two
         pixels off its own label — and two pixels is what a hand-written 10px
         costs here, because it counts the padding and forgets the border. */
      .error-text {
        display: none;
        position: absolute;
        left: var(--input-text-inset);
        top: calc(100% + 4px);
        color: var(--red);
        pointer-events: none;
        z-index: 1;
      }
    `,
  ];

  static $html = html`
    <label id="label" class="label">
      <span id="label-text"></span>
      <span id="required" class="required"> *</span>
    </label>
    <input id="input" type="text" />
    <p id="helper" class="small helper-text"></p>
    <p id="error" class="small error-text"></p>
  `;
}

export namespace TextInput {
  export interface Props {
    label?: Option<string>;
    name?: Option<string>;
    value?: Option<string>;
    placeholder?: Option<string>;
    required?: Option<boolean>;
    helperText?: Option<string>;
    type?: Option<"text" | "email" | "password" | "url" | "tel" | "search">;
    disabled?: Option<boolean>;
    error?: Option<boolean>;
    onChange?: (value: string) => void;
    onBlur?: (value: string) => void;
  }
}
