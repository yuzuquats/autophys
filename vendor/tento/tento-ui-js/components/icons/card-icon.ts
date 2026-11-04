import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-calendar-icon",
})
export class LonaCardIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaCardIcon {
    const $el = LonaCardIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        --icon-color: var(--orange);
      }

      #root {
        position: relative;
        background-color: var(--fg-icon-ter);
        height: var(--icon-size, var(--icon-button-dimension, 20px));
        width: var(--icon-size, var(--icon-button-dimension, 20px));
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        overflow: hidden;
        transition: background-color 0.3s ease;
      }

      .card {
        position: absolute;
        height: 100%;
        width: 80%;
        border-radius: 3px;
        border: 1px solid var(--bg-elevated);
        box-shadow: var(--box-shadow);
        background: var(--fg-icon-sec);
        transition: transform 0.3s ease, background-color 0.3s ease;
      }

      #card-1 {
        transform: translate(15%, 25%) rotate(25deg);
      }

      #card-2 {
        transform: translate(-10%, 60%) rotate(-25deg);
      }

      :host([variant="filled"]) #card-1,
      :host(:hover) #card-1,
      :host([hover]) #card-1 {
        background: var(--orange);
      }

      :host([variant="filled"]) #card-2,
      :host(:hover) #card-2,
      :host([hover]) #card-2 {
        background: var(--purple);
      }

      :host(:hover) #card-1,
      :host([hover]) #card-1 {
        transform: translate(15%, 20%) rotate(15deg);
      }

      :host(:hover) #card-2,
      :host([hover]) #card-2 {
        transform: translate(-10%, 55%) rotate(-15deg);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id=root>
      <div id=card-1 class=card></div>
      <div id=card-2 class=card></div>
    </div>
  `;
}
