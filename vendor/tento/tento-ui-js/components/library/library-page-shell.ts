import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

/** Document-scrolling collection shell. Content, routing and detail lifetimes
 * belong to the caller; overlays remain outside the content's flow stack. */
@component({ name: "std-library-page-shell" })
export class LibraryPageShell extends LonaWebComponent {
  static $styles = [css`
    :host {
      display: block;
      min-width: 0;
      min-height: 100dvh;
      color: var(--text-pri);
    }

    :host([hidden]) {
      display: none;
    }

    ::slotted([slot="content"]) {
      display: block;
      min-width: 0;
    }
  `];

  static $html = html`
    <slot name="header"></slot>
    <slot name="content"></slot>
    <slot name="overlay"></slot>
  `;
}
