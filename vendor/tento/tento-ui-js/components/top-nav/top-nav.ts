import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";

// A header bar that is not a marketing header. `std-floating-navbar` and
// `std-marketing-header` are brand components. This is `role=navigation`
// with a brand slot at the start, items with `aria-current=page`, and a
// `trailing` slot for whatever the page puts at the far edge — an avatar, a
// search field. Both slots stay in the caller's light DOM.
@component({ name: "std-top-nav" })
export class TopNav extends LonaWebComponent {
  private $brand: HTMLElement = this.$("brand");
  private $items: HTMLElement = this.$("items");
  private props: Option<TopNav.Props>;

  constructor() {
    super();
    this.$items.addEventListener("click", (e) => {
      const $b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]");
      const props = this.props;
      if ($b == null || props == null) return;
      const id = $b.dataset.id ?? "";
      props.items.find((i) => i.id === id)?.onSelect();
    });
  }

  bind(props: TopNav.Props): this {
    this.props = props;
    this.setAttribute("role", "navigation");
    this.setAttribute("aria-label", props.label);
    DomUtils.clearChildren(this.$brand);
    if (props.$brand != null) this.$brand.appendChild(props.$brand());
    this.$brand.toggleAttribute("hidden", props.$brand == null);
    DomUtils.clearChildren(this.$items);
    for (const item of props.items) {
      const $b = document.createElement("button");
      $b.type = "button";
      $b.dataset.id = item.id;
      const active = item.id === props.activeId;
      $b.toggleAttribute("active", active);
      if (active) $b.setAttribute("aria-current", "page");
      const $label = Typography.p(item.label);
      $label.className = "label";
      $b.appendChild($label);
      this.$items.appendChild($b);
    }
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    DomUtils.clearChildren(this.$brand);
    DomUtils.clearChildren(this.$items);
    this.removeAttribute("role");
    this.removeAttribute("aria-label");
  }

  static makeWith(props: TopNav.Props): TopNav {
    return TopNav.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --top-nav-height: var(--top-nav-height-preset, 48px);
        --top-nav-bg: var(--top-nav-bg-preset, var(--bg));
        --top-nav-rule: var(--top-nav-rule-preset, var(--divider));
        --top-nav-color: var(--text-sec);
        --top-nav-color-active: var(--text-pri);
        --top-nav-inset: 16px;

        display: flex;
        align-items: center;
        gap: 16px;
        width: 100%;
        height: var(--top-nav-height);
        padding-inline: var(--top-nav-inset);
        box-sizing: border-box;
        background: var(--top-nav-bg);
        border-bottom: 1px solid var(--top-nav-rule);
      }

      #brand {
        display: flex;
        align-items: center;
        flex: none;
      }

      #brand[hidden] {
        display: none;
      }

      #items {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 1;
        min-width: 0;
      }

      button {
        position: relative;
        height: 30px;
        padding: 0 10px;
        margin: 0;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--top-nav-color);
        font-family: inherit;
        cursor: pointer;
      }

      button:hover {
        background: var(--bg-hover-very-light);
      }

      button[active] {
        color: var(--top-nav-color-active);
      }

      button[active]::after {
        content: "";
        position: absolute;
        left: 10px;
        right: 10px;
        bottom: -9px;
        height: 2px;
        border-radius: 2px;
        background: var(--top-nav-color-active);
      }

      button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: -2px;
      }

      .label {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: inherit;
        white-space: nowrap;
      }

      #trailing {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: none;
      }
    `,
  ];

  static $html = html`
    <div id="brand" hidden></div>
    <div id="items"></div>
    <div id="trailing"><slot name="trailing"></slot></div>
  `;
}

export namespace TopNav {
  export type Item = { id: string; label: string; onSelect: EmptyFunction };
  export type Props = {
    $brand: Option<() => HTMLElement>;
    items: Item[];
    activeId: Option<string>;
    /** The nav's accessible name. */
    label: string;
  };
}
