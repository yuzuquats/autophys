import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";

@component({
  name: "std-radio-button",
})
export class RadioButton extends LonaWebComponent {
  private $outer: HTMLElement = this.$("outer");
  private checkedState: boolean = false;
  private disabledState: boolean = false;
  private nameState: string = "";
  private valueState: string = "";

  onChange?: ((checked: boolean, value: string) => void) | undefined;

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this.select();
    }
  };

  get checked(): boolean {
    return this.checkedState;
  }

  set checked(value: boolean) {
    this.checkedState = value;
    this.toggleAttribute("checked", value);
    this.updateAriaChecked();
  }

  get disabled(): boolean {
    return this.disabledState;
  }

  set disabled(value: boolean) {
    this.disabledState = value;
    this.toggleAttribute("disabled", value);
    if (value) {
      this.$outer.setAttribute("aria-disabled", "true");
    } else {
      this.$outer.removeAttribute("aria-disabled");
    }
  }

  get name(): string {
    return this.nameState;
  }

  set name(value: string) {
    this.nameState = value;
    if (value) {
      this.setAttribute("name", value);
    } else {
      this.removeAttribute("name");
    }
  }

  get value(): string {
    return this.valueState;
  }

  set value(val: string) {
    this.valueState = val;
  }

  private updateAriaChecked(): void {
    this.$outer.setAttribute("aria-checked", String(this.checkedState));
  }

  private select(): void {
    if (this.disabled || this.checked) return;

    // Uncheck all other radio buttons with the same name
    if (this.name) {
      const radios = document.querySelectorAll(
        `std-radio-button[name="${this.name}"]`,
      );
      for (const radio of radios) {
        if (radio !== this && radio instanceof RadioButton) {
          radio.checked = false;
        }
      }
    }

    this.checked = true;
    this.onChange?.(true, this.valueState);
  }

  bind(options: RadioButton.Props): this {
    this.name = options.name ?? "";
    this.value = options.value ?? "";
    this.checked = options.checked ?? false;
    this.disabled = options.disabled ?? false;
    this.onChange = options.onChange ?? undefined;

    return this;
  }

  static makeWith(props: RadioButton.Props): RadioButton {
    const $radio = RadioButton.make();
    $radio.bind(props);
    return $radio;
  }

  connectedCallback() {
    // Set up ARIA attributes
    this.$outer.setAttribute("role", "radio");
    this.$outer.setAttribute("tabindex", "0");
    this.updateAriaChecked();

    GESTURE_MANAGER.addPointerEvent(this, {
      onClick: () => this.select(),
    });

    // Keyboard support for Space and Enter
    this.$outer.addEventListener("keydown", this.handleKeydown);
  }

  disconnectedCallback() {
    this.$outer.removeEventListener("keydown", this.handleKeydown);
    GESTURE_MANAGER.unregister(this);
  }

  static $styles = [
    css`
      :host {
        display: inline-block;
        cursor: pointer;
        position: relative;
      }

      #outer {
        width: 18px;
        height: 18px;
        border: 2px solid var(--text-ter);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: border-color 0.3s ease;
        background: var(--bg);
      }

      #inner {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--blue);
        opacity: 0;
        transform: scale(0);
        transition: opacity 0.3s ease, transform 0.3s ease;
      }

      :host(:hover) #outer {
        border-color: var(--text-sec);
      }

      :host([checked]) #outer {
        border-color: var(--blue);
      }

      :host([checked]) #inner {
        opacity: 1;
        transform: scale(1);
      }

      :host([disabled]) {
        cursor: not-allowed;
        opacity: 0.5;
      }

      :host([disabled]) #outer {
        border-color: var(--text-ter);
      }

      :host([disabled]:hover) #outer {
        border-color: var(--text-ter);
      }

      #outer:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html = html`
    <div id="outer">
      <div id="inner"></div>
    </div>
  `;
}

export namespace RadioButton {
  export type Props = {
    name?: Option<string>;
    value?: Option<string>;
    checked?: Option<boolean>;
    disabled?: Option<boolean>;
    onChange?: Option<(checked: boolean, value: string) => void>;
  };
}
