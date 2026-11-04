import "../icon-button";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { MinusIcon, PlusIcon } from "../../icon-exports";
import { Typography } from "../../ui/typography";
import { IconButton } from "../icon-button";
import { InputStyles } from "../input/input-styles";

// A spinbutton with steppers. `std-number-input` and its accessory are
// contenteditable numbers without steppers or a role. This is
// `<input inputmode=decimal role=spinbutton aria-valuenow/min/max>` with minus
// and plus `std-icon-button`s, ArrowUp/Down stepping and Shift for ten steps,
// clamped to min and max; Home and End go to the bounds. The formatted text
// and the numeric value are kept apart: `onChange` reports the number (or
// null when the field is empty), never the string.
@component({ name: "std-number-field" })
export class NumberField extends LonaWebComponent {
  private $label: HTMLLabelElement = this.$("label");
  private $input: HTMLInputElement = this.$("input");
  private $minus: IconButton = this.hydrate("minus");
  private $plus: IconButton = this.hydrate("plus");
  private props: Option<NumberField.Props>;
  private value: Option<number>;
  private editing = false;
  private static seq = 0;

  constructor() {
    super();
    this.$input.addEventListener("input", () => this.fromText());
    this.$input.addEventListener("focus", () => {
      this.editing = true;
      this.render(true);
    });
    this.$input.addEventListener("blur", () => {
      this.editing = false;
      this.render(true);
    });
    this.$input.addEventListener("keydown", this.onKeydown);
    this.$minus.bindIcon(MinusIcon, { sizePx: 16, squarish: true, ariaLabel: "Decrease" });
    this.$plus.bindIcon(PlusIcon, { sizePx: 16, squarish: true, ariaLabel: "Increase" });
    this.$minus.addEventListener("click", () => this.step(-1, 1));
    this.$plus.addEventListener("click", () => this.step(1, 1));
  }

  bind(props: NumberField.Props): this {
    const changed = props.value !== this.value;
    this.props = props;
    this.value = props.value;
    const id = `std-number-field-${++NumberField.seq}`;
    this.$input.id = id;
    this.$label.htmlFor = id;
    this.$label.textContent = props.label;
    this.$input.setAttribute("role", "spinbutton");
    if (props.min != null) this.$input.setAttribute("aria-valuemin", String(props.min));
    else this.$input.removeAttribute("aria-valuemin");
    if (props.max != null) this.$input.setAttribute("aria-valuemax", String(props.max));
    else this.$input.removeAttribute("aria-valuemax");
    this.render(!this.editing || changed);
    return this;
  }

  private format(n: number): string {
    const f = this.props?.format;
    return f == null ? String(n) : new Intl.NumberFormat(undefined, f).format(n);
  }

  private render(updateText: boolean): void {
    const v = this.value;
    if (updateText) this.$input.value = v == null ? "" : this.editing ? String(v) : this.format(v);
    if (v == null) this.$input.removeAttribute("aria-valuenow");
    else this.$input.setAttribute("aria-valuenow", String(v));
    const props = this.props;
    this.$minus.toggleAttribute("disabled", props?.min != null && v != null && v <= props.min);
    this.$plus.toggleAttribute("disabled", props?.max != null && v != null && v >= props.max);
  }

  private clamp(n: number): number {
    const props = this.props;
    if (props == null) return n;
    let c = n;
    if (props.min != null) c = Math.max(props.min, c);
    if (props.max != null) c = Math.min(props.max, c);
    return c;
  }

  private set(n: Option<number>, updateText: boolean): void {
    const props = this.props;
    if (props == null) return;
    const next = n == null ? null : this.clamp(n);
    if (next === this.value) return;
    this.value = next;
    this.render(updateText);
    props.onChange(next);
  }

  private fromText(): void {
    const raw = this.$input.value.trim();
    if (raw === "" || raw === "-") {
      this.set(null, false);
      return;
    }
    // Formatting belongs to the blurred display, never the editing parser.
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return;
    const n = Number(raw);
    if (Number.isFinite(n)) this.set(n, false);
  }

  private step(dir: number, times: number): void {
    const props = this.props;
    if (props == null) return;
    const base = this.value ?? props.min ?? 0;
    this.set(base + dir * props.step * times, true);
  }

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    const props = this.props;
    if (props == null) return;
    const times = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowUp") this.step(1, times);
    else if (e.key === "ArrowDown") this.step(-1, times);
    else if (e.key === "Home" && props.min != null) this.set(props.min, true);
    else if (e.key === "End" && props.max != null) this.set(props.max, true);
    else return;
    e.preventDefault();
  };

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    this.value = null;
    this.editing = false;
    this.$input.value = "";
    this.$label.textContent = "";
    for (const a of ["aria-valuenow", "aria-valuemin", "aria-valuemax", "role"]) this.$input.removeAttribute(a);
  }

  static makeWith(props: NumberField.Props): NumberField {
    return NumberField.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    InputStyles.variables,
    InputStyles.labelStyle,
    css`
      :host {
        display: block;
        width: 100%;
      }

      #row {
        display: flex;
        align-items: center;
        gap: 2px;
        border-radius: var(--input-border-radius, 8px);
        background: var(--input-bg, var(--bg-surface-light));
        border: var(--input-border-width, 2px) solid transparent;
        padding-inline: 4px;
      }

      #row:focus-within {
        border-color: var(--input-focus-border-color, var(--blue));
      }

      /* bind() gives the input a unique id for its label. Match the element,
         so accessible linking cannot remove the field's presentation. */
      input {
        flex: 1;
        min-width: 0;
        border: 0;
        background: transparent;
        color: var(--text-pri);
        font-family: inherit;
        font-size: var(--p-size);
        font-variant-numeric: tabular-nums;
        text-align: center;
        outline: none;
        padding: var(--input-padding-block, 8px) 4px;
      }

      std-icon-button[disabled] {
        opacity: 0.35;
        pointer-events: none;
      }
    `,
  ];

  static $html = html`
    <label id="label" class="label"></label>
    <div id="row">
      <std-icon-button id="minus" squarish></std-icon-button>
      <input id="input" type="text" inputmode="decimal" autocomplete="off" />
      <std-icon-button id="plus" squarish></std-icon-button>
    </div>
  `;
}

export namespace NumberField {
  export type Props = {
    value: Option<number>;
    min: Option<number>;
    max: Option<number>;
    step: number;
    label: string;
    onChange: (value: Option<number>) => void;
    /** Blurred display formatting; focus edits the raw decimal value. */
    format: Option<Intl.NumberFormatOptions>;
  };
}
