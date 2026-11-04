import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";

@component({
  name: "std-switch",
})
export class Switch extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");

  checked: boolean = false;
  disabled: boolean = false;
  onChange?: Option<(checked: boolean) => void>;

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this.toggle();
    }
  };

  connectedCallback(): void {
    // Set up ARIA attributes
    this.$container.setAttribute("role", "switch");
    this.$container.setAttribute("tabindex", "0");
    this.updateAriaChecked();

    GESTURE_MANAGER.addPointerEvent(this.$container, {
      onClick: () => this.toggle(),
    });

    // Keyboard support for Space and Enter
    this.$container.addEventListener("keydown", this.handleKeydown);
  }

  disconnectedCallback() {
    this.$container.removeEventListener("keydown", this.handleKeydown);
    GESTURE_MANAGER.unregister(this.$container);
  }

  private toggle(): void {
    if (this.disabled) return;
    this.setChecked(!this.checked);
    this.onChange?.(this.checked);
  }

  private updateAriaChecked(): void {
    this.$container.setAttribute("aria-checked", String(this.checked));
  }

  bind(props: Switch.Props): this {
    this.onChange = props.onChange;
    this.disabled = props.disabled ?? false;

    if (this.disabled) {
      this.setAttribute("disabled", "");
      this.$container.setAttribute("aria-disabled", "true");
    } else {
      this.removeAttribute("disabled");
      this.$container.removeAttribute("aria-disabled");
    }

    if (props.checked != null) {
      this.setChecked(props.checked);
    }

    return this;
  }

  setChecked(checked: boolean): void {
    this.checked = checked;
    this.updateAriaChecked();

    if (checked) {
      this.setAttribute("on", "");
    } else {
      this.removeAttribute("on");
    }
  }

  static makeWith(props: Switch.Props): Switch {
    const instance = Switch.make();
    instance.bind(props);
    return instance;
  }

  static $styles = [
    css`
      #container {
        position: relative;
        height: 20px;
        width: 32px;
        background-color: var(--bg-selected);
        border-radius: 20px;
        transition: background-color 0.15s ease;
      }
      #thumb {
        position: absolute;
        top: 2px;
        left: 2px;
        height: 16px;
        width: 16px;
        border-radius: 8px;
        /* Off/default thumb: lighter than --bg-btn-pri-hover so it reads on
           the faint track in dark mode; light mode keeps its white thumb. */
        background-color: light-dark(
          var(--bg-elevated),
          color-mix(in srgb, var(--bg-btn-pri-hover) 60%, var(--text-pri) 40%)
        );
        transition: transform 0.15s ease, background-color 0.15s ease;
      }
      :host([on]) #thumb {
        transform: translateX(11px);
        /* When on, keep the elevated (darker) thumb so it contrasts against
           the blue track instead of washing out light-on-light. */
        background-color: var(--bg-elevated);
      }
      :host([on]) #container {
        background-color: var(--blue);
      }

      :host([disabled]) {
        opacity: 0.5;
        cursor: not-allowed;
      }

      :host([disabled]) #container {
        pointer-events: none;
      }

      #container:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      :host {
        display: inline-flex;
        cursor: pointer;
      }
    `,
  ];

  static $html = html`
    <div id="container">
      <div id="thumb"></div>
    </div>
  `;
}

export namespace Switch {
  export type Props = {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (checked: boolean) => void;
  };
}
