import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

// A short strip of headline numbers at the top of a settings page — how many
// workspaces, keys, devices — before the sections that explain them. Values
// are text, not numbers, so a caller can show "—" for an unknown count.
@component({ name: "std-settings-summary" })
export class SettingsSummary extends LonaWebComponent {
  static makeWith(items: SettingsSummary.Item[]): SettingsSummary {
    return SettingsSummary.make().bind(items);
  }

  bind(items: SettingsSummary.Item[]): this {
    const $root = this.$("root");
    $root.replaceChildren(
      ...items.map((item) => {
        const $tile = document.createElement("div");
        $tile.className = "tile";
        const $value = document.createElement("p");
        $value.className = "value";
        $value.textContent = item.value;
        const $label = document.createElement("p");
        $label.className = "label";
        $label.textContent = item.label;
        $tile.append($value, $label);
        return $tile;
      }),
    );
    $root.setAttribute("aria-label", items.map((i) => `${i.label} ${i.value}`).join(", "));
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        min-width: 0;
      }

      #root {
        display: grid;
        grid-template-columns: repeat(
          auto-fit,
          minmax(var(--settings-summary-min, 96px), 1fr)
        );
        gap: var(--settings-summary-gap, 8px);
      }

      .tile {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        border-radius: 12px;
        background: var(--settings-card-bg, var(--bg-surface-light));
        min-width: 0;
      }

      .value {
        --font-size: var(--h6-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-pri);
        font-variant-numeric: tabular-nums;
      }

      .label {
        --font-size: var(--small-size);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<div id="root" role="group"></div>`;
}

export namespace SettingsSummary {
  export type Item = { label: string; value: string };
}
