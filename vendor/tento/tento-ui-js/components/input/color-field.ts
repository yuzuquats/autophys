import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({
  name: "std-color-field",
})
export class ColorField extends LonaWebComponent {
  private $colorDisplay = this.hydrate("color-display");
  private $hiddenInput: HTMLInputElement = this.$("hidden-input");
  private $hexValue = this.hydrate("hex-value");

  private _value: string = "#000000";
  set value(color: string) {
    const validHex = /^#[0-9A-Fa-f]{6}$/;
    if (validHex.test(color)) {
      this._value = color;
      this.$hiddenInput.value = color;
      this.render();
    }
  }

  get value(): string {
    return this._value;
  }

  onChange?: Option<(color: string) => void>;

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.$hiddenInput.click();
    }
  };

  constructor() {
    super();
    this.$hiddenInput.addEventListener("input", () => {
      this.value = this.$hiddenInput.value;
      this.onChange?.(this._value);
    });
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "button");
    this.setAttribute("tabindex", "0");
    this.setAttribute("aria-label", "Choose color");
    this.addPointerEvent({
      onClick: () => {
        this.$hiddenInput.click();
      },
    });
    this.addEventListener("keydown", this.handleKeydown);
  }

  disconnectedCallback() {
    this.removeEventListener("keydown", this.handleKeydown);
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.onChange = null;
    super.onRecycle();
  }

  static makeWith(props: ColorField.Props): ColorField {
    const component = ColorField.make();
    component.bind(props);
    return component;
  }

  bind(props: ColorField.Props): this {
    this.value = props.value ?? "#000000";
    this.onChange = props.onChange;
    this.render();
    return this;
  }

  private render(): void {
    this.$colorDisplay.style.backgroundColor = this.value;
    this.$hexValue.textContent = this.value.toUpperCase();
  }

  /**
   * Set the invalid state for this input.
   * Uses [invalid] attribute which matches HTML5 constraint validation.
   */
  setInvalid(hasError: boolean): void {
    if (hasError) {
      this.setAttribute("invalid", "");
    } else {
      this.removeAttribute("invalid");
    }
  }

  static $styles = [
    css`
      :host {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 38px;
        padding: 0 10px;
        box-sizing: border-box;
        background: var(--container-bg, var(--bg));
        border: 2px solid transparent;
        border-radius: 8px;
        cursor: pointer;
        user-select: none;
        transition: border-color 0.3s ease;
        position: relative;
      }

      :host(:hover) {
        border-color: var(--blue);
      }

      :host([invalid]) {
        border-color: var(--red);
      }

      :host(:focus-visible) {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #color-display {
        width: 24px;
        height: 24px;
        border-radius: 4px;
        border: 1px solid var(--divider);
        background-color: #000000;
      }

      #hex-value {
        font-family: monospace;
        font-size: var(--text-14px);
        color: var(--text-sec);
        min-width: 70px;
      }

      #hidden-input {
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
        pointer-events: none;
      }
    `,
  ];

  static $html = html`
    <div id="color-display"></div>
    <span id="hex-value">#000000</span>
    <input type="color" id="hidden-input" value="#000000" />
  `;
}

export namespace ColorField {
  export interface Props {
    value?: Option<string>;
    onChange?: (color: string) => void;
  }
}
