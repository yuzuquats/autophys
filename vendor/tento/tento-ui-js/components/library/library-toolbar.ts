import "../../component-builtin";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

/** Sticky collection chrome. Slots retain caller-owned controls and listeners.
 * A search twin is revealed by the caller after the hero leaves the viewport. */
@component({ name: "std-library-toolbar" })
export class LibraryToolbar extends LonaWebComponent {
  bind(props: LibraryToolbar.Props): this {
    this.toggleAttribute("scrolled", props.scrolled);
    this.toggleAttribute("search-visible", props.searchVisible);
    return this;
  }

  static $styles = [css`
    :host {
      position: sticky;
      top: 0;
      z-index: 20;
      display: block;
      background: var(--library-toolbar-bg, var(--bg));
      backdrop-filter: var(--library-toolbar-backdrop-filter, none);
    }

    #root {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      box-sizing: border-box;
      min-height: 62px;
      padding: 12px clamp(16px, 3vw, 42px);
    }

    #root::after {
      content: "";
      position: absolute;
      inset-inline: 0;
      bottom: 0;
      height: 1px;
      background: var(--divider);
      opacity: 0;
      transition: opacity 0.18s ease;
      pointer-events: none;
    }

    :host([scrolled]) #root::after {
      opacity: 1;
    }

    ::slotted([hidden]) {
      display: none !important;
    }

    #leading {
      min-width: 0;
    }

    #actions {
      align-items: center;
      gap: 12px;
    }

    #search {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(420px, calc(100% - 240px));
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.18s ease;
    }

    :host([search-visible]) #search {
      opacity: 1;
      visibility: visible;
    }

    @media (max-width: 680px) {
      #root {
        min-height: 56px;
        padding-block: 10px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #root::after, #search {
        transition: none;
      }
    }
  `];

  static $html = html`
    <header id="root">
      <div id="leading"><slot name="leading"></slot></div>
      <div id="search"><slot name="search"></slot></div>
      <std-row id="actions"><slot name="actions"></slot></std-row>
    </header>
  `;
}

export namespace LibraryToolbar {
  export type Props = { scrolled: boolean; searchVisible: boolean };
}
