import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({
  name: "std-square-button",
})
export class SquareButton extends LonaWebComponent {
  static $styles = [
    css`
      :host {
        --std-square-button-background: var(--bg-selected);
      }

      #root {
        padding: 10px;
        height: 100px;
        width: 100px;
        border-radius: 12px;
        background: var(--std-square-button-background);
        cursor: pointer;
      }

      :host(:hover) #root {
        background: var(--std-square-button-background);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <slot name="icon"></slot>
      <std-spacer></std-spacer>
      <slot></slot>
    </std-col>
  `;
}
