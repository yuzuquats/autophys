import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-search-icon",
})
export class LonaSearchIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaSearchIcon {
    const $el = LonaSearchIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;

        --icon-color: var(--blue);
        background-color: var(--bg-surface);
        height: var(--icon-size, var(--icon-button-dimension, 20px));
        width: var(--icon-size, var(--icon-button-dimension, 20px));
        border-radius: 6px;
        transition: background-color 0.3s ease;
      }

      svg {
        width: 72%;
        height: 72%;
        transform-origin: center;
        transition: transform 0.3s ease;
      }

      .lens,
      .handle {
        fill: none;
        stroke: var(--mag-color, var(--fg-icon-sec));
        stroke-linecap: round;
        transition: stroke 0.3s ease;
      }

      :host([variant="filled"]),
      :host(:hover),
      :host([hover]) {
        background-color: var(--icon-color);
        --mag-color: var(--bg);
      }

      :host(:hover) svg,
      :host([hover]) svg {
        transform: rotate(-10deg);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle class="lens" cx="6.5" cy="6.5" r="4.4" stroke-width="1.6"/>
      <line class="handle" x1="9.7" y1="9.7" x2="13.6" y2="13.6" stroke-width="1.8"/>
    </svg>
  `;
}
