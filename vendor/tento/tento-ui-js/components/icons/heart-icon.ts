import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-heart-icon",
})
export class LonaHeartIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaHeartIcon {
    const $el = LonaHeartIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        --icon-color: var(--red);
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

      .heart {
        fill: var(--fg-icon-sec);
        transform-origin: center;
        transition: fill 0.3s ease, transform 0.3s ease;
      }

      :host([variant="filled"]) #root,
      :host(:hover) #root,
      :host([hover]) #root {
        background-color: var(--icon-color);
      }

      :host([variant="filled"]) .heart,
      :host(:hover) .heart,
      :host([hover]) .heart {
        fill: white;
      }

      :host(:hover) .heart,
      :host([hover]) .heart {
        transform: scale(1.12);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path class="heart" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
      </svg>
    </div>
  `;
}
