import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { CheckmarkIcon, LonaIcons } from "../../ui/icons";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-tasks-icon",
})
export class TasksIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): TasksIcon {
    const $el = TasksIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles = [
    css`
      :host {
        --icon-color: var(--green);
      }

      #root {
        background-color: var(--icon-color);
        height: var(--icon-size, var(--icon-button-dimension, 20px));
        width: var(--icon-size, var(--icon-button-dimension, 20px));
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        transition: background-color 0.3s ease;
      }

      #root svg {
        height: var(--icon-size, var(--icon-button-dimension, 20px));
        width: var(--icon-size, var(--icon-button-dimension, 20px));
        color: var(--bg);
        transition: color 0.3s ease;
      }

      :host([variant="grayscale"]) #root {
        background-color: var(--bg-surface);
      }

      :host([variant="grayscale"]) #root svg {
        color: var(--fg-icon-sec);
      }

      :host([variant="grayscale"]:hover) #root,
      :host([variant="grayscale"][hover]) #root {
        background-color: var(--icon-color);
      }

      :host([variant="grayscale"]:hover) #root svg,
      :host([variant="grayscale"][hover]) #root svg {
        color: var(--bg);
      }
    `,
  ];

  static $icons: Option<string[]> = [LonaIcons.symbol(CheckmarkIcon)];
  static $html = html`
    <div id="root">
      <svg height="20" width="20">
        <use href="#checkmark-icon" />
      </svg>
    </div>
  `;
}
