import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-blog-page-shell" })
export class BlogPageShell extends LonaWebComponent {
  static $html = html`
    <std-col id="root">
      <slot name="nav"></slot>
      <std-spacer>
        <slot name="content"></slot>
      </std-spacer>
      <slot name="footer"></slot>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        min-height: 100%;
      }

      #root {
        width: 100%;
        min-height: 100vh;
      }
    `,
  ];
}
