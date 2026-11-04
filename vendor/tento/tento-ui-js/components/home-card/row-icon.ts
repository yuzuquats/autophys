import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Typography } from "@tento-ui/ui/typography";

@component({
  name: "std-row-icon",
})
export class RowIcon extends LonaWebComponent {
  bind(
    row: { icon: Option<string> },
    plugin: { icon: HTMLTemplateElement },
    size: 24 | 16 = 24,
  ): this {
    return this._bindIcon(row.icon, plugin.icon, size);
  }

  private _bindIcon(
    icon: Option<string>,
    defaultIcon: HTMLTemplateElement,
    size: 24 | 16 = 24,
  ): this {
    this.clearChildren();
    if (size === 24) {
      this.assignStyles({
        "--container-size": "24px",
        "--icon-size": "16px",
      });
    } else {
      this.assignStyles({
        "--container-size": "16px",
        "--icon-size": "14px",
      });
    }
    if (icon) {
      const $icon = Typography.p(icon);
      if (size === 24) {
        $icon.assignStyles({
          "--margin-top": "2px",
          marginLeft: "-3px",
          height: "16px",
          width: "16px",
          fontSize: "var(--text-18px)",
        });
      } else {
        $icon.assignStyles({
          "--margin-top": "1px",
          marginLeft: "1px",
          height: "14px",
          width: "14px",
          fontSize: "var(--text-11px)",
        });
      }
      this.appendChild($icon);
    } else if (defaultIcon) {
      const clone = defaultIcon.content.cloneNode(true);
      this.appendChild(clone);
    }
    return this;
  }

  static $styles = [
    css`
      :host {
        --font-size: var(--h3-size);
        --p-container-size: var(--container-size, 24px);
        --p-icon-size: var(--icon-size, 16px);
        --p-hover-color: var(--icon-hover-color, var(--bg-hover));
        height: var(--p-container-size);
        width: var(--p-container-size);
        flex-shrink: 0;
      }

      #root {
        position: relative;
        cursor: pointer;
        height: 100%;
        width: 100%;
      }

      #root:hover::before {
        content: "";
        position: absolute;
        inset: 0px;
        border-radius: 4px;
        background: var(--p-hover-color);
        z-index: 0;
      }

      :host([disabled]) #root {
        pointer-events: none;
        display: none;
      }

      slot::slotted(*) {
        height: var(--p-icon-size);
        width: var(--p-icon-size);
        color: var(--row-icon-color, var(--text-ter));
      }
    `,
  ];
  static $html = html`
    <std-center id="root">
      <slot></slot>
    </std-center>
  `;
}
