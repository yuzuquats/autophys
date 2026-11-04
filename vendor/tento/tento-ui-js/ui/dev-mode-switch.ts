import "../components/button-group-row";

import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css, Style } from "../component-styles";
import { ButtonGroupRow } from "../components/button-group-row";
import { DevMode } from "../dev-mode";

const DEV_MODE_ITEMS: ButtonGroupRow.Item<DevMode>[] = [
  { label: "Beta", identifier: "beta" },
  { label: "RC", identifier: "rc" },
  { label: "Prod", identifier: "prod" },
];

@component({
  name: "dev-mode-switch",
})
export class DevModeSwitch extends LonaWebComponent {
  private $switch = this.hydrate<ButtonGroupRow<DevMode>>("switch");
  onSelected?: (mode: DevMode) => void;

  constructor() {
    super();
    this.$switch.onSelected = (mode) => this.onSelected?.(mode);
  }

  bind(mode: DevMode): this {
    this.$switch.bind(mode, DEV_MODE_ITEMS);
    return this;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #label {
        color: var(--text-ter);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <p id="label">Dev Mode</p>
    <std-spacer></std-spacer>
    <std-button-group-row id="switch"></std-button-group-row>
  `;
}
