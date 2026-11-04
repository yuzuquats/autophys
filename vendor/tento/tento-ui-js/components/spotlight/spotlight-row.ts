import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { ArrowBackIcon, LonaIcons, PlusIcon } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { Spotlight } from "./spotlight";

@component({
  name: "std-spotlight-row",
})
export class SpotlightRow extends LonaWebComponent {
  command: Option<() => Promise<void>>;

  static makeWith(row: Spotlight.Row) {
    const $item = SpotlightRow.make();
    $item.bindRow(row);
    return $item;
  }

  bindRow(row: Spotlight.Row) {
    const $title = row.title ?? SpotlightRow.$title(row.name);
    this.bind($title, row.icon ? row.icon() : null, row.subtitle, async () => {
      await row.command();
    });
  }

  bind(
    $title: HTMLElement,
    $icon: Option<HTMLElement>,
    $subtitle: Option<HTMLElement>,
    command: () => Promise<void>,
  ): this {
    this.clearChildren();

    this.command = command;

    // ARIA accessibility for listbox option
    this.setAttribute("role", "option");
    this.setAttribute("tabindex", "-1"); // Managed by parent spotlight

    if ($icon) {
      $icon.slot = "icon";
      this.appendChild($icon);
    }

    $title.slot = "title";
    this.appendChild($title);

    if ($subtitle) {
      $subtitle.slot = "subtitle";
      this.appendChild($subtitle);
    }
    return this;
  }

  async performCommand() {
    await this.command!();
  }

  static $icons: Option<string[]> = [
    LonaIcons.symbol(ArrowBackIcon),
    LonaIcons.symbol(PlusIcon),
  ];

  static $styles = [
    css`
      :host {
        justify-content: start;
        padding: 12px 16px;
        border-radius: 10px;
        font-size: 0.85rem;
        color: var(--text-sec);
        cursor: pointer;
      }

      :host(:focus-visible) {
        outline: 2px solid var(--blue);
        outline-offset: -2px;
      }
      #root {
        align-items: flex-start;
      }
      #enter-key {
        opacity: 0;
        color: var(--text-ter);
        align-self: center;
      }
      :host([aria-selected="true"]) #enter-key {
        opacity: 1;
      }
      #icon {
        height: 20px;
        width: 20px;
        margin-right: 12px;
        color: var(--text-ter);
      }
      #icon svg {
        margin: 2px;
        height: 16px;
        width: 16px;
      }
      #content {
        align-self: stretch;
        padding-top: 0px;
        flex-grow: 1;
        margin-right: 8px;
        justify-content: center;
      }
    `,
  ];

  static $html = html`
    <std-row id="root">
      <div id="icon">
        <slot name="icon"></slot>
      </div>
      <std-col id="content">
        <slot name="title"></slot>
        <slot name="subtitle"></slot>
      </std-col>
      <std-row id="enter-key">
        <div style="margin-right:8px;">Enter</div>
        <svg height="16" width="16" style="transform:scale(1,-1)">
          <use href="#arrow-back" />
        </svg>
      </std-row>
    </std-row>
  `;
}

export namespace SpotlightRow {
  export function $subtitle(t: string): HTMLElement {
    const $subtitle = Typography.small(t);
    $subtitle.assignStyles({
      color: "var(--text-ter)",
      "--margin-top": "6px",
    });
    return $subtitle;
  }

  export function $title(t: string): HTMLElement {
    const $p = Typography.h2(t, "p");
    return $p;
  }
}
