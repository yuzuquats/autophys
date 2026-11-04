import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";

@component({
  name: "std-select-input",
})
export class SelectInput<T = string> extends LonaWebComponent {
  private $label = this.hydrate<HTMLLabelElement>("label");
  private $labelText = this.hydrate<HTMLSpanElement>("label-text");
  private $required = this.hydrate<HTMLSpanElement>("required");
  private $select = this.hydrate<HTMLSelectElement>("select");
  private $helper = this.hydrate<HTMLParagraphElement>("helper");

  private options: SelectInput.OptionItem<T>[] = [];
  onChange?: Option<(value: T) => void>;

  constructor() {
    super();
    this.$select.addEventListener("change", () => {
      const selectedIndex = this.$select.selectedIndex;
      if (selectedIndex >= 0 && selectedIndex < this.options.length) {
        this.onChange?.(this.options[selectedIndex].value);
      }
    });
  }

  static makeWith<T = string>(props: SelectInput.Props<T>): SelectInput<T> {
    const instance = SelectInput.make() as SelectInput<T>;
    instance.bind(props);
    return instance;
  }

  bind(props: SelectInput.Props<T>): this {
    // Label
    const hasLabel = props.label != null;
    this.$label.style.display = hasLabel ? "block" : "none";
    if (hasLabel) {
      this.$labelText.textContent = props.label!;
      this.$label.setAttribute("for", props.name ?? "");
    }

    // Required indicator
    this.$required.style.display = props.required ? "inline" : "none";

    // Select attributes
    this.$select.name = props.name ?? "";
    this.$select.id = props.name ?? "";
    this.$select.required = props.required ?? false;
    this.$select.disabled = props.disabled ?? false;

    // Clear and populate options
    DomUtils.clearChildren(this.$select);
    this.options = props.options;

    // Add placeholder option if provided
    if (props.placeholder) {
      const $placeholder = document.createElement("option");
      $placeholder.value = "";
      $placeholder.textContent = props.placeholder;
      $placeholder.disabled = true;
      $placeholder.selected = props.value == null;
      this.$select.appendChild($placeholder);
    }

    for (let i = 0; i < props.options.length; i++) {
      const opt = props.options[i];
      const $option = document.createElement("option");
      $option.value = String(i);
      $option.textContent = opt.label;
      $option.selected = props.value != null && opt.value === props.value;
      this.$select.appendChild($option);
    }

    // Helper text
    const hasHelper = props.helperText != null;
    this.$helper.style.display = hasHelper ? "block" : "none";
    if (hasHelper) {
      this.$helper.textContent = props.helperText!;
    }

    // Callback
    this.onChange = props.onChange;

    return this;
  }

  getValue(): Option<T> {
    const selectedIndex = this.$select.selectedIndex;
    // Account for placeholder option
    const hasPlaceholder = this.$select.options[0]?.disabled;
    const optionIndex = hasPlaceholder ? selectedIndex - 1 : selectedIndex;
    if (optionIndex >= 0 && optionIndex < this.options.length) {
      return this.options[optionIndex].value;
    }
    return null;
  }

  setValue(value: T): void {
    const hasPlaceholder = this.$select.options[0]?.disabled;
    const index = this.options.findIndex((opt) => opt.value === value);
    if (index >= 0) {
      this.$select.selectedIndex = hasPlaceholder ? index + 1 : index;
    }
  }

  focus(): void {
    this.$select.focus();
  }

  /**
   * Set the invalid state for this input.
   * Uses [invalid] attribute which matches HTML5 constraint validation.
   */
  setInvalid(hasError: boolean, errorText?: Option<string>): void {
    if (hasError) {
      this.$select.setAttribute("aria-invalid", "true");
      this.setAttribute("invalid", "");
      if (errorText) {
        this.$helper.textContent = errorText;
        this.$helper.style.display = "block";
      }
    } else {
      this.$select.removeAttribute("aria-invalid");
      this.removeAttribute("invalid");
    }
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: block;
        margin-bottom: var(--form-input-margin-bottom, 0px);
      }

      .label {
        display: block;
        margin-left: 12px;
        margin-bottom: 4px;
        color: var(--text-sec);
      }

      .required {
        color: var(--red);
      }

      select {
        background: var(--bg-surface-light);
        /* Block padding is overridable for compact placements (e.g. toolbars);
           default matches the standard form-field height. */
        padding: var(--select-input-block-padding, 8px) 10px;
        border: 2px solid transparent;
        border-radius: 8px;
        color: var(--text-pri);
        font-family: inherit;
        --font-size: var(--p-size);
        width: 100%;
        box-sizing: border-box;
        transition: border-color 0.3s ease;
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
        padding-right: 30px;
      }

      select:focus {
        outline: none;
        border-color: var(--blue);
      }

      select:disabled {
        opacity: 1;
        cursor: not-allowed;
      }

      select option {
        background: var(--bg);
        color: var(--text-pri);
      }

      select option:disabled {
        color: var(--text-ter);
      }

      .helper-text {
        display: block;
        margin-top: 4px;
        margin-left: 10px;
        margin-bottom: 2px;
        color: var(--text-ter);
      }

      :host([invalid]) select {
        border-color: var(--red);
      }

      :host([invalid]) .helper-text {
        color: var(--red);
      }
    `,
  ];

  static $html = html`
    <label id="label" class="label">
      <span id="label-text"></span>
      <span id="required" class="required"> *</span>
    </label>
    <select id="select"></select>
    <p id="helper" class="small helper-text"></p>
  `;
}

export namespace SelectInput {
  export interface OptionItem<T> {
    label: string;
    value: T;
  }

  export interface Props<T> {
    label?: string | null;
    name?: string | null;
    options: OptionItem<T>[];
    value?: T | null;
    placeholder?: string | null;
    required?: boolean | null;
    helperText?: string | null;
    disabled?: boolean | null;
    onChange?: (value: T) => void;
  }
}
