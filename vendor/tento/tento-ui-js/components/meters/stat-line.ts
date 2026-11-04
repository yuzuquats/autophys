import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";

// One metric text line: a label on the left, one or more values pushed to the
// right, everything baseline-aligned with tabular numerals so columns of
// figures don't jitter as they refresh. Sized by the baseline-capheight text
// system (Typography.$style); hosts rescale via `--stat-line-size` (defaults
// to `--small-size`).
@component({ name: "std-stat-line" })
export class StatLine extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");
  private $values: HTMLElement = this.$("values");

  bind(props: StatLine.Props): void {
    if (this.$label.textContent !== props.label) this.$label.textContent = props.label;
    for (let index = 0; index < props.values.length; index += 1) {
      const value = props.values[index];
      const $current = this.$values.children.item(index);
      const $value = $current instanceof HTMLElement ? $current : StatLine.$value(value);
      const className = `text metric value ${value.tone}`;
      if ($value.className !== className) $value.className = className;
      if ($value.textContent !== value.text) $value.textContent = value.text;
      if ($current !== $value) this.$values.insertBefore($value, $current);
    }
    while (this.$values.children.length > props.values.length) {
      this.$values.lastElementChild?.remove();
    }
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: block;
      }
      #line {
        align-items: baseline;
      }
      /* Each piece opts into the baseline-capheight text box via .text; the
         DEFAULT font is inherited (no mono — mono's cap-height doesn't match
         the :root metrics). */
      .metric {
        --font-size: var(--stat-line-size, var(--small-size));
        --line-height-ratio: 1;
        font-variant-numeric: tabular-nums;
      }
      #label {
        color: var(--text-sec);
      }
      #values {
        margin-left: auto;
        align-items: baseline;
        gap: 10px;
      }
      .value.primary {
        color: var(--text-pri);
      }
      .value.secondary {
        color: var(--text-sec);
      }
      .value.tertiary {
        color: var(--text-ter);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="line">
      <span id="label" class="text metric"></span>
      <std-row id="values"></std-row>
    </std-row>
  `;
}

export namespace StatLine {
  /** Maps to the text color ramp: --text-pri / --text-sec / --text-ter. */
  export type Tone = "primary" | "secondary" | "tertiary";

  export interface Value {
    text: string;
    tone: Tone;
  }

  export interface Props {
    label: string;
    values: Value[];
  }

  export function $value(value: Value): HTMLElement {
    const $v = document.createElement("span");
    $v.classList.add("text", "metric", "value", value.tone);
    $v.textContent = value.text;
    return $v;
  }
}
