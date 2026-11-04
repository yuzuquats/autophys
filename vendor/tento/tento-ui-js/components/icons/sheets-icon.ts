import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-sheets-icon",
})
export class SheetsIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): SheetsIcon {
    const $el = SheetsIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles = [
    css`
      :host {
        --icon-color: var(--yellow);
        --_dim: var(--icon-size, var(--icon-button-dimension, 20px));
      }

      #root {
        background-color: var(--icon-color);
        height: var(--_dim);
        width: var(--_dim);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: calc(var(--_dim) * 0.125);
        border-radius: 6px;
        transition: background-color 0.3s ease;
      }

      .notes-button-line {
        height: calc(var(--_dim) * 0.1);
        width: calc(var(--_dim) * 0.6);
        /* Lines sit on the colored (--icon-color) chip; --bg keeps them white in
           light mode but makes them dark in dark mode for legibility. */
        background-color: var(--bg);
        border-radius: calc(var(--_dim) * 0.05);
        transition: background-color 0.3s ease;
      }

      :host([variant="grayscale"]) #root {
        background-color: var(--bg-surface);
      }

      :host([variant="grayscale"]) .notes-button-line {
        background-color: var(--fg-icon-sec);
      }

      :host([variant="grayscale"]:hover) #root,
      :host([variant="grayscale"][hover]) #root {
        background-color: var(--icon-color);
      }

      :host([variant="grayscale"]:hover) .notes-button-line,
      :host([variant="grayscale"][hover]) .notes-button-line {
        background-color: var(--bg);
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <div class="notes-button-line"></div>
      <div class="notes-button-line"></div>
      <div class="notes-button-line"></div>
    </div>
  `;
}
