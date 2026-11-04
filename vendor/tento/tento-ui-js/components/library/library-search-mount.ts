import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

/** Reserves the collapsed input's height; expanding results never move the
 * collection. The caller supplies a SpotlightLayout or another search control. */
@component({ name: "std-library-search-mount" })
export class LibrarySearchMount extends LonaWebComponent {
  static $styles = [css`
    :host {
      position: relative;
      display: block;
      width: 100%;
      height: var(--library-search-height, 56px);
    }

    ::slotted(*) {
      position: absolute;
      top: 0;
      inset-inline: 0;
      width: 100%;
    }
  `];

  static $html = html`<slot></slot>`;
}
