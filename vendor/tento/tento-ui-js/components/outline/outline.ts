import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Typography } from "../../ui/typography";

// A document's headings as navigation, without reading the page.
// `std-docs-nav` reads `localStorage`, which fails the charter's "no global".
// This is a `<nav aria-label>` of items with a level, indented by
// `--outline-indent × level`, with `aria-current=location` on the active one.
// It does no scroll-spy: the caller passes `activeId`, and the story below
// shows the rebind.
@component({ name: "std-outline" })
export class Outline extends LonaWebComponent {
  private $list: HTMLElement = this.$("list");
  private props: Option<Outline.Props>;

  constructor() {
    super();
    this.$list.addEventListener("click", (e) => {
      const $b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]");
      if ($b == null || this.props == null) return;
      this.props.onSelect($b.dataset.id ?? "");
    });
  }

  bind(props: Outline.Props): this {
    this.props = props;
    this.setAttribute("aria-label", props.label);
    DomUtils.clearChildren(this.$list);
    for (const item of props.items) {
      const $li = document.createElement("li");
      const $b = document.createElement("button");
      $b.type = "button";
      $b.dataset.id = item.id;
      $b.style.setProperty("--outline-level", String(Math.max(0, item.level - 1)));
      const $label = Typography.small(item.label);
      $label.className = "label";
      $b.appendChild($label);
      const active = item.id === props.activeId;
      $b.toggleAttribute("active", active);
      if (active) $b.setAttribute("aria-current", "location");
      $li.appendChild($b);
      this.$list.appendChild($li);
    }
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.props = null;
    DomUtils.clearChildren(this.$list);
    this.removeAttribute("aria-label");
  }

  static makeWith(props: Outline.Props): Outline {
    return Outline.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        --outline-indent: var(--outline-indent-preset, 12px);
        --outline-color: var(--text-sec);
        --outline-color-active: var(--text-pri);
        --outline-rule: var(--divider);

        display: block;
        width: 100%;
      }

      nav {
        border-inline-start: 1px solid var(--outline-rule);
      }

      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }

      button {
        display: block;
        width: 100%;
        margin: 0;
        padding: 3px 8px;
        padding-inline-start: calc(8px + var(--outline-level, 0) * var(--outline-indent));
        border: 0;
        border-inline-start: 2px solid transparent;
        margin-inline-start: -1px;
        background: transparent;
        color: var(--outline-color);
        font-family: inherit;
        text-align: start;
        cursor: pointer;
      }

      button:hover {
        color: var(--outline-color-active);
      }

      button[active] {
        color: var(--outline-color-active);
        border-inline-start-color: var(--outline-color-active);
      }

      button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: -2px;
        border-radius: 4px;
      }

      .label {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: inherit;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  static $html = html`<nav><ul id="list"></ul></nav>`;
}

export namespace Outline {
  export type Item = { id: string; label: string; level: 1 | 2 | 3 | 4 | 5 | 6 };
  export type Props = {
    items: Item[];
    activeId: Option<string>;
    onSelect: (id: string) => void;
    /** The nav's accessible name, e.g. "On this page". */
    label: string;
  };
}
