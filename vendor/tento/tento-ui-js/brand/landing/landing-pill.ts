import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";

@component({ name: "std-landing-pill" })
export class LandingPill extends LonaWebComponent {
  private $label: HTMLElement = this.$("label");

  static makeWith(props: LandingPill.Props): LandingPill {
    return (LandingPill.make() as LandingPill).bind(props);
  }

  bind(props: LandingPill.Props): this {
    this.$label.textContent = props.label;

    if (props.variant) {
      this.setAttribute("variant", props.variant);
    }

    if (props.primary) {
      this.setAttribute("primary", "");
    }

    if (props.onClick) {
      this.style.cursor = "pointer";
      this.setAttribute("tabindex", "0");
      GESTURE_MANAGER.addPointerEvent(this, { onClick: props.onClick });
    }

    return this;
  }

  static $html = html`<p id="label"></p>`;

  static $styles = [
    css`
      :host {
        display: inline-block;
        transition: transform 0.3s ease, box-shadow 0.3s ease;
      }

      :host(:focus-visible) {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
        border-radius: 8px;
      }

      #label {
        --margin-top: 0px;
        --margin-bottom: 0px;
        --font-size: var(--text-10px);
        --line-height-ratio: 1.2;
        color: var(--text-sec);
        font-family: inherit;
        font-weight: 500;
        border: none;
        border-radius: 5px;
        padding: 4px 8px;
        background: color-mix(in srgb, var(--bg) 92%, var(--text-pri) 8%);
        letter-spacing: 0;
      }

      :host([variant="trust"]) #label {
        color: color-mix(in srgb, var(--green) 70%, var(--text-pri) 30%);
        background: color-mix(in srgb, var(--bg) 90%, var(--green) 10%);
        font-family: inherit;
      }

      :host([variant="security"]) #label {
        color: color-mix(in srgb, var(--blue) 70%, var(--text-pri) 30%);
        background: color-mix(in srgb, var(--bg) 90%, var(--blue) 10%);
        letter-spacing: 0.02em;
      }

      :host([variant="cta"]) #label {
        color: var(--text-sec);
        background: var(--bg);
        border: 1px solid var(--divider);
        border-radius: 6px;
        padding: 7px 14px;
        --font-size: var(--text-10px);
        font-weight: 500;
        transition: border-color 0.3s ease;
      }

      :host([variant="cta"]:hover) #label {
        border-color: var(--text-ter);
      }

      :host([variant="cta"]:hover) {
        transform: scale(1.02);
        box-shadow: var(--box-shadow-very-light);
      }

      :host([variant="cta"][primary]) #label {
        color: var(--bg);
        background: var(--text-pri);
        border-color: var(--text-pri);
      }

      :host([variant="cta"][primary]:hover) {
        transform: scale(1.02);
        box-shadow: var(--box-shadow-light);
      }

      :host([variant="tag"]) #label {
        color: var(--text-sec);
        background: color-mix(in srgb, var(--bg) 92%, var(--text-pri) 8%);
        padding: 3px 8px;
      }

      :host([variant="integration"]) #label {
        color: var(--text-sec);
        background: color-mix(in srgb, var(--bg) 92%, var(--text-pri) 8%);
        border: 1px solid var(--divider);
        border-radius: 6px;
        padding: 3px 8px;
      }

      :host([variant="logo"]) #label {
        border: none;
        background: transparent;
        --font-size: var(--text-12px);
        font-family: inherit;
        font-weight: 600;
        opacity: 0.55;
        color: var(--text-pri);
        padding: 6px 8px;
        transition: opacity 0.3s ease;
      }

      :host([variant="logo"]:hover) #label {
        opacity: 0.7;
      }

      :host([primary]) #label {
        color: var(--bg);
        background: var(--text-pri);
      }
    `,
  ];
}

export namespace LandingPill {
  export type Props = {
    label: string;
    variant?: Option<"trust" | "security" | "cta" | "tag" | "integration" | "logo">;
    primary?: Option<boolean>;
    onClick?: Option<() => void>;
  };
}
