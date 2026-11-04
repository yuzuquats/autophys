import "./stat-line";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { StatLine } from "./stat-line";

// A labeled usage meter: a StatLine head (label left; value + optional detail
// right) stacked over a soft rounded track whose fill reads green (healthy) →
// orange (warm) → red (hot) as the percent crosses the given thresholds.
// Pure presentation — the percent and all copy come in via props.
@component({ name: "std-usage-meter" })
export class UsageMeter extends LonaWebComponent {
  private $head: StatLine = this.hydrate("head");
  private $fill: HTMLElement = this.$("fill");

  bind(props: UsageMeter.Props): void {
    const values: StatLine.Value[] = [{ text: props.value, tone: "secondary" }];
    if (props.detail != null) {
      values.push({ text: props.detail, tone: "tertiary" });
    }
    this.$head.bind({ label: props.label, values });
    const width = `${Math.min(100, Math.max(0, props.percent))}%`;
    if (this.$fill.style.width !== width) this.$fill.style.width = width;
    const hot = props.percent >= props.thresholds.hot;
    this.$fill.classList.toggle("hot", hot);
    this.$fill.classList.toggle("warm", !hot && props.percent >= props.thresholds.warm);
  }

  static $styles = [
    css`
      :host {
        display: block;
      }
      /* Gap between the head text and its bar; the head sizes itself (no fixed
         height — that would override the baseline-capheight box). */
      #root {
        gap: 8px;
      }
      #track {
        height: 16px;
        border-radius: 6px;
        background: var(--bg-surface-light, #f0f0f0);
        overflow: hidden;
      }
      #fill {
        --bar: var(--green, #2fa84f);
        height: 100%;
        border-radius: 6px;
        background: var(--bar);
        transition: width 0.3s ease;
      }
      #fill.warm {
        --bar: var(--orange, #d80);
      }
      #fill.hot {
        --bar: var(--red, #c33);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-stat-line id="head"></std-stat-line>
      <div id="track"><div id="fill"></div></div>
    </std-col>
  `;
}

export namespace UsageMeter {
  /** Percent cutoffs where the fill turns orange (warm) then red (hot). */
  export interface Thresholds {
    warm: number;
    hot: number;
  }

  export const THRESHOLDS: Thresholds = { warm: 75, hot: 90 };

  export interface Props {
    label: string;
    /** 0–100; clamped for the fill width, raw for the threshold checks. */
    percent: number;
    value: string;
    detail: Option<string>;
    thresholds: Thresholds;
  }
}
