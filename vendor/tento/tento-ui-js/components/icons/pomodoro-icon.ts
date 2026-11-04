import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-pomodoro-icon",
})
export class LonaPomodoroIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaPomodoroIcon {
    const $el = LonaPomodoroIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        --icon-color: var(--red);
        --_dim: var(--icon-size, var(--icon-button-dimension, 20px));
      }

      #root {
        position: relative;
        background-color: var(--bg-surface);
        height: var(--_dim);
        width: var(--_dim);
        border-radius: 6px;
        transition: background-color 0.3s ease;
      }

      .radial-line {
        position: absolute;
        top: 50%;
        left: 50%;
        width: var(--thickness);
        height: var(--length);
        --length: calc(var(--_dim) * 0.15);
        --offset: calc(var(--_dim) * 0.25);
        --thickness: calc(var(--_dim) * 0.075);
        --color: var(--fg-icon-sec);
        background-color: var(--color);
        border-radius: calc(var(--thickness) / 2);
        transform-origin: center bottom;
        transform: translate(-50%, -100%)
                   rotate(var(--angle))
                   translateY(calc(-1 * var(--offset)));
        transition: transform 0.3s ease, background-color 0.3s ease;
      }

      #hr {
        --angle: 60deg;
        --length: calc(var(--_dim) * 0.35);
        --offset: calc(var(--_dim) * -0.05);
        --thickness: calc(var(--_dim) * 0.075);
      }

      #min {
        --angle: 0deg;
        --length: calc(var(--_dim) * 0.45);
        --offset: calc(var(--_dim) * -0.025);
        --thickness: calc(var(--_dim) * 0.1);
      }

      :host([variant="filled"]) #root,
      :host(:hover) #root,
      :host([hover]) #root {
        background-color: var(--icon-color);
      }

      :host([variant="filled"]) .radial-line,
      :host(:hover) .radial-line,
      :host([hover]) .radial-line {
        --color: var(--bg);
      }

      :host(:hover) #hr,
      :host([hover]) #hr {
        --angle: 125deg;
      }

      :host(:hover) #min,
      :host([hover]) #min {
        --angle: 15deg;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id=root>
      <div class=radial-line style="--angle: 90deg;"></div>
      <div class=radial-line style="--angle: 180deg;"></div>
      <div class=radial-line style="--angle: 270deg;"></div>

      <div id=hr class=radial-line></div>
      <div id=min class=radial-line></div>
    </div>
  `;
}
