import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-presentation-header" })
export class PresentationHeader extends LonaWebComponent {
  private $left: HTMLElement = this.$("left");
  private $right: HTMLElement = this.$("right");

  bind(left: string, right: string): this {
    this.$left.textContent = left;
    this.$right.textContent = right;
    return this;
  }

  static $styles = [
    css`
      :host {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 16px;
        height: 32px;
        --font-size: var(--caption-size);
        color: var(--text-ter);
      }
    `,
  ];

  static $html = html`<span id="left"></span><span id="right"></span>`;
}
