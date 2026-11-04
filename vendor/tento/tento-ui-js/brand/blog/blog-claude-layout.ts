import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-blog-claude-layout" })
export class BlogClaudeLayout extends LonaWebComponent {
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

  static $html = html`
    <std-col id="root">
      <slot name="nav"></slot>
      <slot name="hero"></slot>
      <slot name="featured"></slot>
      <slot name="content"></slot>
      <slot name="footer"></slot>
    </std-col>
  `;
}