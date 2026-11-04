import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";

@component({ name: "std-blog-app" })
export class BlogApp extends LonaWebComponent {
  private $content: HTMLDivElement = this.$("content");

  setContent($layout: HTMLElement) {
    DomUtils.clearChildren(this.$content);
    this.$content.appendChild($layout);
  }

  static $styles = [css`
    :host {
      display: block;
      width: 100%;
      min-height: 100vh;
    }
  `];
  static $html = html`<div id="content"></div>`;
}
