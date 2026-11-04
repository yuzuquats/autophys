import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-simple-auth-page" })
export class SimpleAuthPage extends LonaWebComponent {
  static $styles = [
    css`
      :host {
        display: block;
        min-height: 100vh;
        min-height: 100dvh;
        width: 100%;
        background: var(--simple-auth-page-bg, var(--bg));
      }
      #root {
        min-height: inherit;
        width: 100%;
        padding: var(--simple-auth-page-padding, 16px);
        box-sizing: border-box;
      }
    `,
  ];

  static $html = html`
    <std-center id="root">
      <slot></slot>
    </std-center>
  `;
}
