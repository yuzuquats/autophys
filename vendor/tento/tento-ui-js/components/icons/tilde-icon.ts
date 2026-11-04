import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-tilde-icon",
})
export class LonaTildeIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaTildeIcon {
    const $el = LonaTildeIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        --icon-color: var(--blue);
      }

      #root {
        position: relative;
        background-color: var(--bg-surface);
        height: var(--icon-size, var(--icon-button-dimension, 20px));
        width: var(--icon-size, var(--icon-button-dimension, 20px));
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        overflow: hidden;
        transition: background-color 0.3s ease;
      }

      svg {
        width: 70%;
        height: 70%;
      }

      .tilde {
        fill: none;
        stroke: var(--fg-icon-sec);
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        transform-origin: center;
        transition: stroke 0.3s ease, transform 0.3s ease;
      }

      :host([variant="filled"]) #root,
      :host(:hover) #root,
      :host([hover]) #root {
        background-color: var(--icon-color);
      }

      :host([variant="filled"]) .tilde,
      :host(:hover) .tilde,
      :host([hover]) .tilde {
        stroke: var(--bg);
      }

      :host(:hover) .tilde,
      :host([hover]) .tilde {
        transform: rotate(-10deg);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path class="tilde" d="M2 10 C4 6 6 6 8 8 S12 10 14 6"/>
      </svg>
    </div>
  `;
}
