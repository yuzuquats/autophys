import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-globe-icon",
})
export class LonaGlobeIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaGlobeIcon {
    const $el = LonaGlobeIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        --icon-color: var(--teal);
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

      .globe {
        fill: none;
        stroke: var(--fg-icon-sec);
        stroke-width: 1.6;
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

      :host([variant="filled"]) .globe,
      :host(:hover) .globe,
      :host([hover]) .globe {
        stroke: white;
      }

      :host(:hover) .globe,
      :host([hover]) .globe {
        transform: rotate(-12deg);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle class="globe" cx="12" cy="12" r="9"/>
        <ellipse class="globe" cx="12" cy="12" rx="4" ry="9"/>
        <line class="globe" x1="3" y1="12" x2="21" y2="12"/>
      </svg>
    </div>
  `;
}
