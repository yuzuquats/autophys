import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";

/** A bounded quantity that is true continuously — a context budget, a rate
 * limit, a quota — drawn small enough to sit inside a composer.
 *
 * This started as a face of `turn.note` and was wrong there for a reason
 * worth keeping written down: **a meter is not an event.** Everything else
 * in a transcript happened at a point and stays true of that point
 * forever. A meter is only ever true NOW, so pinning one to the row where
 * it was last sampled tells the reader something about the scrollback
 * rather than about the question they are about to ask. Scroll up and you
 * are reading a stale number with no way to tell that you are.
 *
 * Its mount point is the composer, next to the send affordance, because
 * that is where the number is actionable: the thing it governs is whether
 * you can ask another question and how much room the answer has. This
 * component knows nothing about composers, sessions or turns — it takes
 * two numbers and draws them — so a header, a status line or a settings
 * page can mount it just as well.
 *
 * ## Thresholds are the point, not decoration
 *
 * A bar that is the same colour at 4% and at 96% makes the reader do the
 * arithmetic. Two thresholds, and they are deliberately late: this is
 * ambient chrome, and a meter that goes yellow at half full has cried wolf
 * before the number ever mattered.
 *
 *   under 75%   quiet, the tertiary tone
 *   75%–90%     warn
 *   over 90%    at the limit
 *
 * The label is monospace and pre-compacted (128k, 1.2M) so the meter does
 * not change width as the session grows — a chrome element that jitters as
 * a number ticks up drags the eye to exactly the thing it is meant to stay
 * out of the way of. */
@component({ name: "std-context-meter" })
export class ContextMeter extends LonaWebComponent {
  private $fill: HTMLElement = this.$("fill");
  private $text: HTMLElement = this.$("text");

  static makeWith(props: ContextMeter.Props): ContextMeter {
    return (ContextMeter.make() as ContextMeter).bind(props);
  }

  bind(props: ContextMeter.Props): this {
    const ratio = props.limit > 0
      ? Math.min(1, Math.max(0, props.used / props.limit))
      : 0;
    this.setAttribute("level", ContextMeter.levelFor(ratio));
    this.$fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    this.$text.textContent = props.text ??
      `${ContextMeter.compact(props.used)} / ${
        ContextMeter.compact(props.limit)
      }`;
    this.$text.style.display = props.showLabel === false ? "none" : "";
    return this;
  }

  static $styles = [
    css`
      :host {
        display: inline-block;
      }
      #root {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #track {
        flex: none;
        width: var(--meter-width, 44px);
        height: var(--meter-height, 3px);
        border-radius: 2px;
        background: var(--divider, rgba(127, 127, 127, 0.35));
        overflow: hidden;
      }
      #fill {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: var(--text-ter, #8b93a7);
        transition: width 0.25s ease;
      }
      #text {
        flex: none;
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
        --font-size: var(--turn-fine-size, var(--text-8px));
        color: var(--text-ter, #8b93a7);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      /* The bar takes the colour; the label follows only at the limit, so
         the warn step stays chrome and the final step reads as a fact
         about what you can still do. */
      :host([level="warn"]) #fill {
        background: var(--yellow, #d4a72c);
      }
      :host([level="limit"]) #fill {
        background: var(--red, #e5484d);
      }
      :host([level="limit"]) #text {
        color: var(--red, #e5484d);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <span id="track"><span id="fill"></span></span>
      <p class="small" id="text"></p>
    </div>
  `;
}

export namespace ContextMeter {
  export type Level = "quiet" | "warn" | "limit";

  export const WARN_AT = 0.75;
  export const LIMIT_AT = 0.9;

  export function levelFor(ratio: number): Level {
    if (ratio > LIMIT_AT) return "limit";
    if (ratio >= WARN_AT) return "warn";
    return "quiet";
  }

  /** Keeps the label from jittering in width as a session grows. */
  export function compact(value: number): string {
    if (value >= 1_000_000) {
      const m = value / 1_000_000;
      return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
    }
    if (value >= 1_000) {
      const k = value / 1_000;
      return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
    }
    return String(value);
  }

  export type Props = {
    used: number;
    limit: number;
    /** Overrides the derived "used / limit" label. */
    text?: string;
    /** False draws the bar alone — for a composer with no room for words. */
    showLabel?: boolean;
  };
}
