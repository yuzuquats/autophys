import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-blog-list-layout" })
export class BlogListLayout extends LonaWebComponent {
  static makeWith(): BlogListLayout {
    return BlogListLayout.make();
  }

  static $html = html`
    <std-col id="root">
      <slot name="nav"></slot>
      <slot name="hero"></slot>
      <slot name="content"></slot>
      <slot name="footer"></slot>
    </std-col>
  `;

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
        min-height: 100vh;
      }

      #root {
        width: 100%;
        min-height: 100vh;
      }
    `,
  ];
}
