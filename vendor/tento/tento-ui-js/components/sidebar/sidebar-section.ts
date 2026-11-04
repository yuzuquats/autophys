import "@tento-ui/components/sidebar/sidebar-section-nav";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { $qs_maybe } from "../../dom-selectors";
import { Typography } from "../../ui/typography";
import { SidebarSectionNav } from "./sidebar-section-nav";

@component({
  name: "std-sidebar-section",
})
export class SidebarSection extends LonaWebComponent {
  $nav: SidebarSectionNav = this.hydrate("nav");

  static makeWithRawContents($content: LonaWebComponent): SidebarSection {
    const $section = SidebarSection.make();
    $section.appendChild($content);
    return $section;
  }

  static makeWithContent(
    label: string,
    $icon: LonaWebComponent,
    $content: LonaWebComponent,
    callbacks?: SidebarSection.Callbacks,
  ): SidebarSection {
    const $section = SidebarSection.make();
    $section.$nav.bind(label, $icon, callbacks);
    $section.appendChild($content);
    return $section;
  }

  static $makeTitle(label: string): HTMLElement {
    const $title = Typography.h1(label, "h6");
    $title.assignStyles({
      padding: "4px 8px",
      "--margin-top": "8px",
      "--margin-bottom": "8px",
      color: "var(--text-pri)",
      fontWeight: "500",
      cursor: "pointer",
    });
    return $title;
  }

  toggleActive(force: boolean) {
    $qs_maybe("[slot=icon]", this.$nav)?.toggleAttribute("active", force);
  }

  toggleBackButton(force: boolean) {
    this.$nav.toggleAttribute("back-button-shown", force);
  }

  static $styles = [
    css`
      :host {
        --p-padding-vertical: var(--std-sidebar-section-vertical-padding, 12px);
        --p-padding-horizontal: var(
          --std-sidebar-section-horizontal-padding,
          12px
        );

        --p-sidebar-section-overflow: var(--std-sidebar-section-overflow, scroll);
        --std-sidebar-section-bottom-margin: 0px;

        will-change: transform;
      }

      * {
        transition-property: transform, opacity;
        transition-duration: var(--std-sidebar-section-transition-duration);
        transition-timing-function: ease;
      }

      #root {
        padding: var(--p-padding-vertical) var(--p-padding-horizontal);
        padding-bottom: calc(
          var(--p-padding-vertical) + var(--std-sidebar-section-bottom-margin)
        );
        position: relative;
        height: 100%;
        overflow-y: var(--override-overflow, var(--p-sidebar-section-overflow));
        overflow-x: hidden;

        -ms-overflow-style: none;
        scrollbar-width: none;
      }

      #root::after {
        content: "";
        position: absolute;
        left: 20px;
        right: 20px;
        bottom: 0px;
        height: 1px;
        width: calc(100% - 36px);
        background: var(--divider);
        transition: opacity 0.3s ease;
      }

      :host([expanded]) #root::after,
      :host([hide-bottom-border]) #root::after {
        opacity: 0;
      }

      #nav {
        display: none;
        margin-bottom: 0px;
        position: sticky;
        top: 0px;
        left: 0px;
      }

      :host([nav-clickable]) #nav {
        cursor: pointer;
        border-radius: 8px;
      }

      #root:has(slot::slotted(*)) #nav {
        margin-bottom: 4px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <std-sidebar-section-nav id="nav"></std-sidebar-section-nav>
      <slot></slot>
    </div>
  `;
}

export namespace SidebarSection {
  export type Callbacks = SidebarSectionNav.Callbacks;
}
