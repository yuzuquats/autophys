import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

// Text for assistive technology that the eye never sees. The clip-rect
// pattern: one pixel, clipped, no overflow — the node stays in the accessible
// tree and out of layout. `focusable` is for a skip-link: the moment anything
// inside receives focus the clip is removed, so a keyboard user sees what they
// are on.
//
// Nothing in the tree provided this before; icon-only controls and live
// regions each invented a way to hide their text, or did not hide it. This is
// the one way.
@component({ name: "std-visually-hidden" })
export class VisuallyHidden extends LonaWebComponent {
  bind(props: VisuallyHidden.Props): this {
    this.toggleAttribute("focusable", props.focusable);
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.removeAttribute("focusable");
  }

  static makeWith(props: VisuallyHidden.Props): VisuallyHidden {
    return VisuallyHidden.make().bind(props);
  }

  static $styles = [
    css`
      :host {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
      }

      :host([focusable]:focus-within) {
        position: static;
        width: auto;
        height: auto;
        margin: 0;
        overflow: visible;
        clip: auto;
        clip-path: none;
        white-space: normal;
      }
    `,
  ];

  static $html = html`<slot></slot>`;
}

export namespace VisuallyHidden {
  export type Props = {
    /** A skip-link reappears when focused; a label for a control never does. */
    focusable: boolean;
  };
}
