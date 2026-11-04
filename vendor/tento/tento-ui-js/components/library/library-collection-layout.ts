import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

/** Media/Vault collection geometry. Search floats in its own mount; the app
 * supplies filters, its grid implementation, empty state and status content. */
@component({ name: "std-library-collection-layout" })
export class LibraryCollectionLayout extends LonaWebComponent {
  static $styles = [css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      padding: var(--library-collection-padding, clamp(22px, 3.4vw, 46px) clamp(16px, 3vw, 42px) 64px);
    }

    :host([hidden]), ::slotted([hidden]) {
      display: none !important;
    }

    ::slotted([slot="search"]) {
      width: min(100%, var(--library-collection-search-width, 560px));
      margin-inline: auto;
      margin-bottom: var(--library-collection-search-gap, 34px);
      z-index: 2;
    }

    ::slotted([slot="navigation"]), ::slotted([slot="status"]) {
      margin-bottom: var(--library-collection-controls-gap, 20px);
    }

    ::slotted([slot="items"]) {
      display: block;
      min-width: 0;
    }

    ::slotted([slot="footer"]) {
      display: block;
      margin-top: var(--library-collection-footer-gap, 24px);
    }

    @media (max-width: 768px) {
      :host {
        padding-inline: var(--library-collection-narrow-gutter, 12px);
      }
    }
  `];

  static $html = html`
    <slot name="search"></slot>
    <slot name="navigation"></slot>
    <slot name="status"></slot>
    <slot name="items"></slot>
    <slot name="empty"></slot>
    <slot name="footer"></slot>
  `;
}
