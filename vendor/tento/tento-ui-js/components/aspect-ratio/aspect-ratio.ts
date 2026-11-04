import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

// A box that keeps its shape. One prop — width over height — written as a
// custom property the root's `aspect-ratio` reads; whatever is slotted fills
// it. Nothing generic did this: every image wrapper reserved its own space
// its own way.
@component({ name: "std-aspect-ratio" })
export class AspectRatio extends LonaWebComponent {
  bind(props: AspectRatio.Props): this {
    this.style.setProperty("--aspect-ratio-value", String(props.ratio));
    return this;
  }

  static makeWith(props: AspectRatio.Props): AspectRatio {
    return AspectRatio.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: 100%;
      }

      #root {
        aspect-ratio: var(--aspect-ratio-value, 1);
        width: 100%;
        position: relative;
        overflow: hidden;
      }

      ::slotted(*) {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
    `,
  ];

  static $html = html`<div id="root"><slot></slot></div>`;
}

export namespace AspectRatio {
  export type Props = {
    /** width / height — 16/9 is 1.777…, a square is 1. */
    ratio: number;
  };
}
