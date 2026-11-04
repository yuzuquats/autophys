import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-link-icon",
})
export class LonaLinkIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaLinkIcon {
    const $el = LonaLinkIcon.make();
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

      .chain-link {
        fill: var(--fg-icon-sec);
        stroke: var(--fg-icon-sec);
        stroke-width: 0.33px;
        transition: fill 0.3s ease, stroke 0.3s ease;
      }

      :host([variant="filled"]) #root,
      :host(:hover) #root,
      :host([hover]) #root {
        background-color: var(--icon-color);
      }

      :host([variant="filled"]) .chain-link,
      :host(:hover) .chain-link,
      :host([hover]) .chain-link {
        fill: var(--bg);
        stroke: var(--bg);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id=root>
      <svg viewBox="1 1 14 14">
        <path id="link-1" class="chain-link" d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1 1 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4 4 0 0 1-.128-1.287z"/>
        <path id="link-2" class="chain-link" d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243z"/>
      </svg>
    </div>
  `;
}
