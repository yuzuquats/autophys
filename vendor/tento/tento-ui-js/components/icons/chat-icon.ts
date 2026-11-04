import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-chat-icon",
})
export class LonaChatIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaChatIcon {
    const $el = LonaChatIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        --icon-color: var(--purple);
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

      .sparkle {
        fill: none;
        stroke: var(--fg-icon-sec);
        stroke-width: 1.5;
        stroke-linejoin: round;
        transform-origin: center;
        transition: stroke 0.3s ease, fill 0.3s ease, transform 0.3s ease;
      }

      :host([variant="filled"]) #root,
      :host(:hover) #root,
      :host([hover]) #root {
        background-color: var(--icon-color);
      }

      :host([variant="filled"]) .sparkle,
      :host(:hover) .sparkle,
      :host([hover]) .sparkle {
        stroke: var(--bg);
        fill: var(--bg);
      }

      :host(:hover) .sparkle,
      :host([hover]) .sparkle {
        transform: scale(1.1);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path class="sparkle" d="M8 15c4.875 0 7-2.051 7-7c0 4.949 2.11 7 7 7c-4.89 0-7 2.11-7 7c0-4.89-2.125-7-7-7ZM2 6.5c3.134 0 4.5-1.318 4.5-4.5c0 3.182 1.357 4.5 4.5 4.5c-3.143 0-4.5 1.357-4.5 4.5c0-3.143-1.366-4.5-4.5-4.5Z"/>
      </svg>
    </div>
  `;
}
