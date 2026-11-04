import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

@component({ name: "std-presentation-footer" })
export class PresentationFooter extends LonaWebComponent {
  private $counter: HTMLElement = this.$("counter");

  bind(current: number, total: number): this {
    this.$counter.textContent = `${current}/${total}`;
    return this;
  }

  static $styles = [
    css`
      :host {
        display: flex;
        align-items: center;
        padding: 0 16px;
        height: 32px;
        --font-size: var(--caption-size);
        color: var(--text-ter);
      }
    `,
  ];

  static $html = html`<span id="counter"></span>`;
}
