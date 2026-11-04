import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-chart-icon",
})
export class LonaChartIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaChartIcon {
    const $el = LonaChartIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        --icon-color: var(--green);
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

      .line {
        fill: none;
        stroke: var(--fg-icon-sec);
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
        transition: stroke 0.3s ease;
      }

      .dot {
        fill: var(--fg-icon-sec);
        transition: fill 0.3s ease;
      }

      #trend {
        transform-origin: center;
        transition: transform 0.3s ease;
      }

      :host([variant="filled"]) #root,
      :host(:hover) #root,
      :host([hover]) #root {
        background-color: var(--icon-color);
      }

      :host([variant="filled"]) .line,
      :host(:hover) .line,
      :host([hover]) .line {
        stroke: white;
      }

      :host([variant="filled"]) .dot,
      :host(:hover) .dot,
      :host([hover]) .dot {
        fill: white;
      }

      :host(:hover) #trend,
      :host([hover]) #trend {
        transform: translateY(-1.5px);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <g id="trend">
          <polyline class="line" points="4,15 9,11 13,13 20,6"/>
          <circle class="dot" cx="4" cy="15" r="1.6"/>
          <circle class="dot" cx="9" cy="11" r="1.6"/>
          <circle class="dot" cx="13" cy="13" r="1.6"/>
          <circle class="dot" cx="20" cy="6" r="1.6"/>
        </g>
      </svg>
    </div>
  `;
}
