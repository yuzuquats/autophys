import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

// Indeterminate progress that announces or stays silent. `LoadingIcon` is a
// glyph, `std-loading-button` is a button, and the legacy loading dots have no
// Props. This is an SVG arc in three sizes: with a label it is `role=status`
// and named, so the reader hears "Loading results"; without one it is
// `aria-hidden`, for the place where the surrounding text already says so.
// Under reduced motion the arc stops turning and stays a three-quarter ring.
@component({ name: "std-spinner" })
export class Spinner extends LonaWebComponent {
  bind(props: Spinner.Props): this {
    this.setAttribute("size", props.size);
    if (props.label == null) {
      this.setAttribute("aria-hidden", "true");
      this.removeAttribute("role");
      this.removeAttribute("aria-label");
    } else {
      this.removeAttribute("aria-hidden");
      this.setAttribute("role", "status");
      this.setAttribute("aria-label", props.label);
    }
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    for (const a of ["size", "aria-hidden", "role", "aria-label"]) this.removeAttribute(a);
  }

  static makeWith(props: Spinner.Props): Spinner {
    return Spinner.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        --spinner-color: var(--spinner-color-preset, var(--text-ter));
        --spinner-size: var(--spinner-size-preset, 20px);
        --spinner-stroke: 2.5;

        display: inline-flex;
        flex: none;
        width: var(--spinner-size);
        max-width: var(--spinner-size);
        height: var(--spinner-size);
        color: var(--spinner-color);
      }

      :host([size="sm"]) {
        --spinner-size-preset: 14px;
        --spinner-stroke: 3;
      }

      :host([size="lg"]) {
        --spinner-size-preset: 32px;
        --spinner-stroke: 2;
      }

      svg {
        width: 100%;
        height: 100%;
        animation: spinner-turn 0.9s linear infinite;
      }

      circle {
        fill: none;
        stroke: currentColor;
        stroke-width: var(--spinner-stroke);
        stroke-linecap: round;
        /* three quarters of the circumference of r=10 */
        stroke-dasharray: 47 63;
      }

      @keyframes spinner-turn {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        svg {
          animation: none;
        }
      }
    `,
  ];

  static $html = html`
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
    </svg>
  `;
}

export namespace Spinner {
  export type Props = {
    size: "sm" | "md" | "lg";
    /** Announced as `role=status`; `null` hides the spinner from the tree. */
    label: Option<string>;
  };
}
