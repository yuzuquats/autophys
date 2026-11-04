import "../visually-hidden/visually-hidden";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { XIcon } from "../../icon-exports";
import { LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { InputStyles } from "../input/input-styles";

// Removable chips, and the field that grows them. `std-chip` is
// non-interactive by design and `std-tag-selector` is a domain component.
// `std-token` is a chip with a remove button named "Remove <label>", and
// Backspace or Delete on the focused token removes it. `std-token-input`
// below is the tokenizer.
@component({ name: "std-token" })
export class Token extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");
  private $remove: HTMLButtonElement = this.$("remove");
  private props: Option<Token.Props>;

  constructor() {
    super();
    this.$remove.appendChild(LonaIcons.$svg(XIcon));
    this.$remove.addEventListener("click", () => this.props?.onRemove?.());
    this.addEventListener("keydown", (e) => {
      if ((e.key === "Backspace" || e.key === "Delete") && this.props?.removable) {
        e.preventDefault();
        this.props.onRemove?.();
      }
    });
  }

  bind(props: Token.Props): this {
    this.props = props;
    this.$label.textContent = props.label;
    this.$remove.toggleAttribute("hidden", !props.removable);
    this.$remove.setAttribute("aria-label", `Remove ${props.label}`);
    this.setAttribute("tone", props.tone ?? "default");
    // The token itself is a focus stop so Backspace can reach it.
    this.tabIndex = props.removable ? 0 : -1;
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$label.textContent = "";
    this.$remove.removeAttribute("aria-label");
    this.removeAttribute("tone");
  }

  static makeWith(props: Token.Props): Token {
    return Token.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --token-bg: var(--token-bg-preset, var(--bg-surface-light));
        --token-color: var(--token-color-preset, var(--text-pri));
        --token-radius: 6px;

        display: inline-flex;
        align-items: center;
        gap: 4px;
        max-width: max-content;
        height: 24px;
        padding-inline: 8px 4px;
        border-radius: var(--token-radius);
        background: var(--token-bg);
        color: var(--token-color);
        outline: none;
      }

      :host([tone="accent"]) {
        --token-bg-preset: var(--blue);
        --token-color-preset: var(--bg);
      }

      :host(:focus-visible) {
        outline: 2px solid var(--blue);
        outline-offset: 1px;
      }

      #label {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: inherit;
        white-space: nowrap;
      }

      #remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        padding: 0;
        margin: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        opacity: 0.7;
      }

      #remove:hover,
      #remove:focus-visible {
        opacity: 1;
        outline: none;
        background: rgba(0, 0, 0, 0.08);
      }

      #remove[hidden] {
        display: none;
      }

      #remove > svg {
        width: 10px;
        height: 10px;
        fill: currentColor;
      }
    `,
  ];

  static $html = html`<p id="label" class="small"></p><button id="remove" type="button" hidden></button>`;
}

export namespace Token {
  export type Props = {
    label: string;
    removable: boolean;
    onRemove: Option<EmptyFunction>;
    tone: Option<"default" | "accent">;
  };
}

// The tokenizer: tokens plus an inline input. Enter or a separator commits,
// Backspace on an empty input removes the last token, paste splits on the
// separators, a validator can refuse, and a polite live region announces the
// count (rule R9) so a reader hears "3 tokens" without focus moving.
@component({ name: "std-token-input" })
export class TokenInput extends LonaWebComponent {
  private $tokens: HTMLElement = this.$("tokens");
  private $input: HTMLInputElement = this.$("input");
  private $live: HTMLElement = this.$("live");
  private props: Option<TokenInput.Props>;

  constructor() {
    super();
    this.$input.addEventListener("keydown", this.onKeydown);
    this.$input.addEventListener("paste", this.onPaste);
    this.$input.addEventListener("blur", () => this.commit(this.$input.value, false));
    this.addEventListener("click", (e) => {
      if (e.target === this) this.$input.focus();
    });
  }

  bind(props: TokenInput.Props): this {
    this.props = props;
    this.$input.placeholder = props.placeholder ?? "";
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", props.label);
    DomUtils.clearChildren(this.$tokens);
    props.tokens.forEach((t, i) => {
      this.$tokens.appendChild(
        Token.makeWith({ label: t, removable: true, tone: null, onRemove: () => this.removeAt(i) }),
      );
    });
    this.$live.textContent = `${props.tokens.length} ${props.tokens.length === 1 ? "token" : "tokens"}`;
    return this;
  }

  private separators(): string[] {
    return this.props?.separators ?? [",", "\n"];
  }

  private emit(tokens: string[]): void {
    const props = this.props;
    if (props == null) return;
    this.bind({ ...props, tokens });
    props.onChange(tokens);
  }

  private commit(raw: string, focusInput: boolean): void {
    const props = this.props;
    if (props == null) return;
    const seps = this.separators();
    const parts = raw
      .split(new RegExp(`[${seps.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}]`))
      .map((s) => s.trim())
      .filter((s) => s !== "" && (props.validate == null || props.validate(s)));
    if (parts.length === 0) {
      if (raw.trim() === "") this.$input.value = "";
      return;
    }
    this.$input.value = "";
    this.emit([...props.tokens, ...parts]);
    if (focusInput) this.$input.focus();
  }

  private removeAt(i: number): void {
    const props = this.props;
    if (props == null) return;
    this.emit(props.tokens.filter((_, k) => k !== i));
    this.$input.focus();
  }

  private onKeydown = (e: KeyboardEvent): void => {
    const props = this.props;
    if (props == null) return;
    if (e.key === "Enter" || this.separators().includes(e.key)) {
      e.preventDefault();
      this.commit(this.$input.value, true);
    } else if (e.key === "Backspace" && this.$input.value === "" && props.tokens.length > 0) {
      e.preventDefault();
      this.removeAt(props.tokens.length - 1);
    }
  };

  private onPaste = (e: ClipboardEvent): void => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!this.separators().some((s) => text.includes(s))) return;
    e.preventDefault();
    this.commit(this.$input.value + text, true);
  };

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.$input.value = "";
    DomUtils.clearChildren(this.$tokens);
    this.$live.textContent = "";
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
  }

  static makeWith(props: TokenInput.Props): TokenInput {
    return TokenInput.make().bind(props);
  }

  static $styles = [
    InputStyles.variables,
    css`
      :host {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        width: 100%;
        min-height: 36px;
        padding: 4px var(--input-padding-inline, 10px);
        box-sizing: border-box;
        border-radius: var(--input-border-radius, 8px);
        background: var(--input-bg, var(--bg-surface-light));
        border: var(--input-border-width, 2px) solid transparent;
        cursor: text;
      }

      :host(:focus-within) {
        border-color: var(--input-focus-border-color, var(--blue));
      }

      #tokens {
        display: contents;
      }

      #input {
        flex: 1;
        min-width: 80px;
        border: 0;
        background: transparent;
        color: var(--text-pri);
        font-family: inherit;
        font-size: var(--p-size);
        outline: none;
        padding: 2px 0;
      }

      #input::placeholder {
        color: var(--text-ter);
      }
    `,
  ];

  static $html = html`
    <span id="tokens"></span>
    <input id="input" type="text" />
    <std-visually-hidden id="live" aria-live="polite"></std-visually-hidden>
  `;
}

export namespace TokenInput {
  export type Props = {
    tokens: string[];
    placeholder: Option<string>;
    onChange: (tokens: string[]) => void;
    /** Keys and paste separators that commit; default `,` and newline. */
    separators: Option<string[]>;
    /** Refuse a value; refused input stays in the field. */
    validate: Option<(s: string) => boolean>;
    /** The group's accessible name. */
    label: string;
  };
}
