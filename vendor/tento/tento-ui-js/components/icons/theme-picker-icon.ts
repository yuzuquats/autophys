import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { applyIconProps, type IconProps } from "./icon-contract";

@component({
  name: "std-theme-picker-icon",
})
export class LonaThemePickerIcon extends LonaWebComponent {
  static makeWith(props: IconProps = {}): LonaThemePickerIcon {
    const $el = LonaThemePickerIcon.make();
    applyIconProps($el, props);
    return $el;
  }

  static $styles = [
    css`
      #root {
        height: var(--icon-size, var(--icon-button-dimension, 20px));
        width: var(--icon-size, var(--icon-button-dimension, 20px));
        border-radius: 4px;
        transition: filter 0.3s ease;
      }

      div {
        height: calc((var(--icon-size, var(--icon-button-dimension, 20px)) - 1px) / 2);
        width: calc((var(--icon-size, var(--icon-button-dimension, 20px)) - 1px) / 2);
        border-radius: 3px;
      }

      .row {
        margin-bottom: 1px;
      }

      .row *:first-child {
        margin-right: 1px;
      }

      :host([variant="grayscale"]) #root {
        filter: grayscale(1);
      }

      :host([variant="grayscale"]:hover) #root,
      :host([variant="grayscale"][hover]) #root {
        filter: none;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id=root>
      <std-row class=row>
        <div style=background:var(--red)></div>
        <div style=background:var(--orange)></div>
      </std-row>
      <std-row class=row>
        <div style=background:var(--green)></div>
        <div style=background:var(--purple)></div>
      </std-row>
    </std-col>
  `;
}
