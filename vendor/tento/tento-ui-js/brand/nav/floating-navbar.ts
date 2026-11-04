import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({
  name: "std-floating-navbar",
})
export class FloatingNavbar extends LonaWebComponent {
  static $styles = [
    css`
      :host {
        position: fixed;
        top: 20px;
        display: block;
        width: 100%;
        max-width: 400px;
        z-index: 1;
        left: 50%;
        transform: translateX(-50%);
      }

      #root {
        position: relative;
        border-radius: 20px;
        height: 40px;
        width: 100%;
        align-items: center;
        padding-inline: 8px;
        justify-content: center;
        gap: 4px;
        overflow: hidden;
      }

      #root::before {
        z-index: 0;
        position: absolute;
        content: "";
        inset: 0;
        background: rgba(0, 0, 0, 0.12);
        backdrop-filter: blur(12px);
      }

      slot::slotted(*) {
        z-index: 1;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <slot></slot>
    </std-row>
  `;
}
