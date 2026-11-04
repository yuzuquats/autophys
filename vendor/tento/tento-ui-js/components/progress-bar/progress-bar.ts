import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";

// Determinate and indeterminate, with a real role. `std-context-meter` is a
// budget meter with thresholds; nothing was a plain progress bar. A value
// draws the fill and `role=progressbar aria-valuenow/min/max`; a null value is
// indeterminate — the sweep animation, no `aria-valuenow`, static under
// reduced motion. Tone is a `-preset` on the host; the public track, fill and
// height knobs stay the caller's.
@component({ name: "std-progress-bar" })
export class ProgressBar extends LonaWebComponent {
  private $fill: HTMLElement = this.$("fill");
  private $label: HTMLElement = this.$("label");
  private $value: HTMLElement = this.$("value");

  bind(props: ProgressBar.Props): this {
    const max = Math.max(1, props.max);
    this.setAttribute("role", "progressbar");
    this.setAttribute("aria-valuemin", "0");
    this.setAttribute("aria-valuemax", String(max));
    this.setAttribute("tone", props.tone);
    const label = props.label;
    if (label == null) this.removeAttribute("aria-label");
    else this.setAttribute("aria-label", label);
    this.$label.textContent = label ?? "";
    this.$label.toggleAttribute("hidden", label == null);

    const value = props.value;
    if (value == null) {
      this.toggleAttribute("indeterminate", true);
      this.removeAttribute("aria-valuenow");
      this.$fill.style.removeProperty("--progress-fraction");
      this.$value.textContent = "";
      this.$value.toggleAttribute("hidden", true);
    } else {
      const clamped = Math.min(max, Math.max(0, value));
      this.toggleAttribute("indeterminate", false);
      this.setAttribute("aria-valuenow", String(clamped));
      this.$fill.style.setProperty("--progress-fraction", String(clamped / max));
      const pct = `${Math.round((clamped / max) * 100)}%`;
      this.$value.textContent = pct;
      this.$value.toggleAttribute("hidden", !props.showValue);
      this.setAttribute("aria-valuetext", pct);
    }
    if (value == null) this.removeAttribute("aria-valuetext");
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    for (const a of ["role", "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext", "aria-label", "tone", "indeterminate"]) {
      this.removeAttribute(a);
    }
    this.$fill.style.removeProperty("--progress-fraction");
    this.$label.textContent = "";
    this.$value.textContent = "";
  }

  static makeWith(props: ProgressBar.Props): ProgressBar {
    return ProgressBar.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --progress-track: var(--progress-track-preset, var(--bg-surface-light));
        --progress-fill: var(--progress-fill-preset, var(--blue));
        --progress-height: var(--progress-height-preset, 6px);
        --progress-radius: 999px;

        display: block;
        width: 100%;
      }

      :host([tone="success"]) {
        --progress-fill-preset: var(--green, var(--blue));
      }

      :host([tone="warn"]) {
        --progress-fill-preset: var(--orange, var(--blue));
      }

      :host([tone="danger"]) {
        --progress-fill-preset: var(--red, var(--blue));
      }

      #head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 4px;
      }

      #label,
      #value {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-sec);
      }

      #value {
        font-variant-numeric: tabular-nums;
        color: var(--text-ter);
      }

      #label[hidden],
      #value[hidden] {
        display: none;
      }

      #track {
        position: relative;
        width: 100%;
        height: var(--progress-height);
        border-radius: var(--progress-radius);
        background: var(--progress-track);
        overflow: hidden;
      }

      #fill {
        position: absolute;
        inset: 0 auto 0 0;
        width: calc(var(--progress-fraction, 0) * 100%);
        border-radius: var(--progress-radius);
        background: var(--progress-fill);
        transition: width 0.2s ease;
      }

      :host([indeterminate]) #fill {
        width: 35%;
        animation: progress-sweep 1.2s ease-in-out infinite;
      }

      @keyframes progress-sweep {
        from {
          transform: translateX(-100%);
        }
        to {
          transform: translateX(300%);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        :host([indeterminate]) #fill {
          animation: none;
          width: 100%;
          opacity: 0.4;
        }
        #fill {
          transition: none;
        }
      }
    `,
  ];

  static $html = html`
    <div id="head">
      <p id="label" hidden></p>
      <p id="value" hidden></p>
    </div>
    <div id="track"><div id="fill"></div></div>
  `;
}

export namespace ProgressBar {
  export type Props = {
    /** `null` is indeterminate. */
    value: Option<number>;
    max: number;
    /** Drawn above the bar and used as the accessible name. */
    label: Option<string>;
    showValue: boolean;
    tone: "default" | "success" | "warn" | "danger";
  };
}
