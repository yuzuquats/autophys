import "../tooltip/tooltip";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { Tooltip } from "../tooltip/tooltip";

// Grouped navigation that collapses to icons. `std-sidebar-section-nav` is a
// section's header bar and `std-rail-section` is a label; nothing was a
// navigation LIST. This is `nav > ul > li > button` with optional group
// labels, glyphs, badges and `aria-current=page` on the active item, and a
// `collapsed` mode that shows the glyph alone with a `std-tooltip` carrying
// the name — the label is never lost, only moved.
@component({ name: "std-side-nav" })
export class SideNav extends LonaWebComponent {
  private $nav: HTMLElement = this.$("nav");
  private props: Option<SideNav.Props>;

  constructor() {
    super();
    this.$nav.addEventListener("click", (e) => {
      const $b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]");
      const props = this.props;
      if ($b == null || props == null) return;
      const id = $b.dataset.id ?? "";
      for (const g of props.groups) for (const item of g.items) if (item.id === id) item.onSelect();
    });
  }

  bind(props: SideNav.Props): this {
    this.props = props;
    this.$nav.setAttribute("aria-label", props.label);
    this.toggleAttribute("collapsed", props.collapsed);
    DomUtils.clearChildren(this.$nav);
    for (const group of props.groups) {
      const $section = document.createElement("div");
      $section.className = "group";
      if (group.label != null) {
        const $h = Typography.small(group.label);
        $h.className = "group-label";
        $h.toggleAttribute("hidden", props.collapsed);
        $section.appendChild($h);
      }
      const $ul = document.createElement("ul");
      for (const item of group.items) {
        const $li = document.createElement("li");
        const $b = document.createElement("button");
        $b.type = "button";
        $b.dataset.id = item.id;
        const active = item.id === props.activeId;
        $b.toggleAttribute("active", active);
        if (active) $b.setAttribute("aria-current", "page");
        if (item.icon != null) {
          const $glyph = document.createElement("span");
          $glyph.className = "glyph";
          $glyph.appendChild(LonaIcons.$svg(item.icon));
          $glyph.setAttribute("aria-hidden", "true");
          $b.appendChild($glyph);
        }
        const $label = Typography.p(item.label);
        $label.className = "label";
        $b.appendChild($label);
        if (item.badge != null) {
          const $badge = Typography.small(item.badge);
          $badge.className = "badge";
          $b.appendChild($badge);
        }
        if (props.collapsed) {
          // The name survives collapse as the accessible name and a tooltip.
          $b.setAttribute("aria-label", item.label);
          $b.appendChild(Tooltip.makeWith({ text: item.label, placement: "right", delayMs: null }));
        }
        $li.appendChild($b);
        $ul.appendChild($li);
      }
      $section.appendChild($ul);
      this.$nav.appendChild($section);
    }
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    DomUtils.clearChildren(this.$nav);
    this.removeAttribute("collapsed");
  }

  static makeWith(props: SideNav.Props): SideNav {
    return SideNav.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --side-nav-width: var(--side-nav-width-preset, 240px);
        --side-nav-collapsed-width: var(--side-nav-collapsed-width-preset, 56px);
        --side-nav-inset: 8px;
        --side-nav-color: var(--text-sec);
        --side-nav-color-active: var(--text-pri);
        --side-nav-bg-active: var(--bg-surface-light);
        --side-nav-radius: 8px;

        display: block;
        width: var(--side-nav-width);
        max-width: var(--side-nav-width);
        box-sizing: border-box;
        padding: var(--side-nav-inset);
      }

      :host([collapsed]) {
        width: var(--side-nav-collapsed-width);
        max-width: var(--side-nav-collapsed-width);
      }

      .group + .group {
        margin-top: 12px;
      }

      .group-label {
        --margin-top: 0px;
        --margin-bottom: 4px;
        padding-inline: 10px;
        color: var(--text-ter);
      }

      .group-label[hidden] {
        display: none;
      }

      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      button {
        position: relative;
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        height: 32px;
        padding: 0 10px;
        margin: 0;
        border: 0;
        border-radius: var(--side-nav-radius);
        background: transparent;
        color: var(--side-nav-color);
        font-family: inherit;
        text-align: start;
        cursor: pointer;
      }

      button:hover {
        background: var(--bg-hover-very-light);
      }

      button[active] {
        background: var(--side-nav-bg-active);
        color: var(--side-nav-color-active);
      }

      button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: -2px;
      }

      .glyph {
        display: inline-flex;
        flex: none;
        width: 16px;
        height: 16px;
      }

      .glyph > svg {
        width: 100%;
        height: 100%;
        fill: currentColor;
      }

      .label {
        --margin-top: 0px;
        --margin-bottom: 0px;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: inherit;
      }

      .badge {
        --margin-top: 0px;
        --margin-bottom: 0px;
        flex: none;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--bg-surface-light);
        color: var(--text-ter);
        font-variant-numeric: tabular-nums;
      }

      :host([collapsed]) button {
        justify-content: center;
        padding: 0;
      }

      :host([collapsed]) .label,
      :host([collapsed]) .badge {
        display: none;
      }
    `,
  ];

  static $html = html`<nav id="nav"></nav>`;
}

export namespace SideNav {
  export type Item = {
    id: string;
    label: string;
    icon: Option<LonaIcons.RawSvg>;
    badge: Option<string>;
    onSelect: EmptyFunction;
  };
  export type Group = { label: Option<string>; items: Item[] };
  export type Props = {
    groups: Group[];
    activeId: Option<string>;
    collapsed: boolean;
    /** The nav's accessible name. */
    label: string;
  };
}
