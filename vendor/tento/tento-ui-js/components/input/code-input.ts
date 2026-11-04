import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";

@component({ name: "std-code-input" })
export class CodeInput extends LonaWebComponent {
  private $digits: HTMLInputElement[] = [];
  private digitCount: number = 6;

  onChange?: Option<(value: string) => void>;
  onComplete?: Option<(value: string) => void>;

  constructor() {
    super();
    const $container = this.$("digits");
    for (let i = 0; i < 6; i++) {
      const $digit = $container.children[i] as HTMLInputElement;
      this.$digits.push($digit);
      $digit.addEventListener("input", () => this.handleInput(i));
      $digit.addEventListener("keydown", (e) => this.handleKeydown(e, i));
      $digit.addEventListener("paste", (e) => this.handlePaste(e));
      $digit.addEventListener("focus", () => $digit.select());
    }
  }

  connectedCallback() {
    super.connectedCallback();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.onChange = null;
    this.onComplete = null;
    this.setValue("");
    super.onRecycle();
  }

  static makeWith(props: CodeInput.Props): CodeInput {
    const instance = CodeInput.make();
    instance.bind(props);
    return instance;
  }

  bind(props: CodeInput.Props): this {
    const requestedCount = props.digitCount ?? this.$digits.length;
    const normalizedCount = Number.isFinite(requestedCount)
      ? Math.trunc(requestedCount)
      : this.$digits.length;
    this.digitCount = Math.max(
      1,
      Math.min(this.$digits.length, normalizedCount),
    );
    const masked = props.masked === true;
    this.toggleAttribute("masked", masked);

    for (let i = 0; i < this.$digits.length; i++) {
      const isActive = i < this.digitCount;
      this.$digits[i].type = masked ? "password" : "text";
      this.$digits[i].hidden = !isActive;
      if (!isActive) this.$digits[i].value = "";
    }

    this.onChange = props.onChange;
    this.onComplete = props.onComplete;
    return this;
  }

  private handleInput(index: number): void {
    const $digit = this.$digits[index];
    // Keep only the last typed digit
    const value = $digit.value.replace(/\D/g, "");
    $digit.value = value.slice(-1);

    if ($digit.value && index < this.digitCount - 1) {
      this.$digits[index + 1].focus();
    }

    this.emitChange();
  }

  private handleKeydown(e: KeyboardEvent, index: number): void {
    if (e.key === "Backspace") {
      const $digit = this.$digits[index];
      if (!$digit.value && index > 0) {
        this.$digits[index - 1].focus();
        this.$digits[index - 1].value = "";
        this.emitChange();
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      this.$digits[index - 1].focus();
    } else if (e.key === "ArrowRight" && index < this.digitCount - 1) {
      this.$digits[index + 1].focus();
    }
  }

  private handlePaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData("text") ?? "";
    const digits = text.replace(/\D/g, "").slice(0, this.digitCount);

    for (let i = 0; i < this.digitCount; i++) {
      this.$digits[i].value = digits[i] ?? "";
    }

    // Focus the next empty digit, or the last one
    const nextEmpty = this.$digits
      .slice(0, this.digitCount)
      .findIndex((d) => !d.value);
    if (nextEmpty >= 0) {
      this.$digits[nextEmpty].focus();
    } else {
      this.$digits[this.digitCount - 1].focus();
    }

    this.emitChange();
  }

  private emitChange(): void {
    const value = this.getValue();
    this.onChange?.(value);
    if (value.length === this.digitCount) {
      this.onComplete?.(value);
    }
  }

  getValue(): string {
    let result = "";
    for (let i = 0; i < this.digitCount; i++) {
      result += this.$digits[i].value;
    }
    return result;
  }

  setValue(value: string): void {
    const digits = value.replace(/\D/g, "").slice(0, this.digitCount);
    for (let i = 0; i < this.$digits.length; i++) {
      this.$digits[i].value = i < this.digitCount ? (digits[i] ?? "") : "";
    }
  }

  clear(): void {
    for (const $digit of this.$digits) {
      $digit.value = "";
    }
    this.$digits[0].focus();
  }

  focus(): void {
    const $activeDigits = this.$digits.slice(0, this.digitCount);
    const nextEmpty = $activeDigits.findIndex((d) => !d.value);
    if (nextEmpty >= 0) {
      this.$digits[nextEmpty].focus();
    } else {
      this.$digits[0].focus();
    }
  }

  setInvalid(invalid: boolean): void {
    if (invalid) {
      this.setAttribute("invalid", "");
    } else {
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
      #digits {
        gap: 8px;
        justify-content: center;
      }
      input {
        width: 48px;
        height: 56px;
        text-align: center;
        font-weight: 600;
        --font-size: var(--h3-size);
        background: var(--bg-surface-light);
        border: 2px solid transparent;
        border-radius: 8px;
        color: var(--text-pri);
        font-family: inherit;
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
      :host([invalid]) input {
        border-color: var(--red);
      }
    `,
  ];

  static $html = html`
    <std-row id="digits">
      <input type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code" />
      <input type="text" inputmode="numeric" maxlength="1" />
      <input type="text" inputmode="numeric" maxlength="1" />
      <input type="text" inputmode="numeric" maxlength="1" />
      <input type="text" inputmode="numeric" maxlength="1" />
      <input type="text" inputmode="numeric" maxlength="1" />
    </std-row>
  `;
}

export namespace CodeInput {
  export type Props = {
    digitCount?: Option<number>;
    masked?: Option<boolean>;
    onChange?: (value: string) => void;
    onComplete?: (value: string) => void;
  };
}
