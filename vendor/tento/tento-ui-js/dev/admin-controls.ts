import "@tento-ui/components/controls/switch";

import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { LazySync } from "@tento-ui/lazy";
import { Pip } from "@tento-ui/ui/pip";
import { ButtonGroupRow } from "../components/button-group-row";
import { DevMode, DevModeUtils } from "../dev-mode";
import { Globals } from "../globals";

const DEV_MODE_ITEMS: ButtonGroupRow.Item<DevMode>[] = [
  {
    label: "Beta",
    identifier: "beta",
  },
  {
    label: "RC",
    identifier: "rc",
  },
  {
    label: "Prod",
    identifier: "prod",
  },
];

const LOGS: Map<string, any> = new Map();

@component({
  name: "dev-admin-controls",
})
export class AdminControls extends LonaWebComponent {
  private $devModeSwitch: ButtonGroupRow<DevMode> =
    this.hydrate("dev-mode-switch");

  static _instance = new LazySync<AdminControls>(() => {
    const $a = AdminControls.make();
    $a.bind();
    return $a;
  });
  static get instance() {
    return AdminControls._instance.get();
  }

  static async toggleReveal() {
    if (!Globals.isServiceAccount) return;
    Pip.show(AdminControls.instance, {
      margin: "8px",
    });
  }

  static log(key: string, value: any, autoRevealIfAdmin: boolean = false) {
    LOGS.set(key, value);
    AdminControls.renderIfNecessary(autoRevealIfAdmin);
  }

  static clearKey(key: string, autoRevealIfAdmin: boolean = false) {
    LOGS.delete(key);
    AdminControls.renderIfNecessary(autoRevealIfAdmin);
  }

  static renderIfNecessary(autoRevealIfAdmin: boolean) {
    if (autoRevealIfAdmin && Globals.AUTO_REVEAL_ADMIN_LOG) {
      AdminControls.autoRevealIfAdmin().then(() => {
        AdminControls.instance.render();
      });
    } else {
      if (!AdminControls._instance.hasResolved) return;
      AdminControls.instance.render();
    }
  }

  static async autoRevealIfAdmin() {
    if (!Globals.isServiceAccount) return;
    if (AdminControls._instance.hasResolved) return;
    await AdminControls.toggleReveal();
  }

  private bind() {
    this.$devModeSwitch.bind(DevModeUtils.getMode(), DEV_MODE_ITEMS);
  }

  private render() {
    this.clearChildren();
    for (const [k, v] of LOGS.entries()) {
      const $content = AdminLog.make();
      $content.textContent = `${k} ` + JSON.stringify(v, null, 2);

      this.appendChild($content);
    }
  }

  static $styles = [
    css`
      #root {
        height: 100%;
        width: 100%;
        padding: 12px;
        background: var(--bg);
        box-shadow: var(--box-shadow);
        border-radius: 12px;
        z-index: 9500; /* ZIndex.DEV_TOOLS */
      }

      slot::slotted(*) {
        margin-top: 8px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-row style="align-items:center;">
        <p>Dev</p>
        <std-spacer></std-spacer>
        <std-button-group-row id="dev-mode-switch"></std-button-group-row>
      </std-row>
      <std-col id="logs">
        <slot></slot>
      </std-col>
    </std-col>
  `;
}

@component({
  name: "admin-log",
})
class AdminLog extends LonaWebComponent {
  static $styles: Style.Compat[] = [
    css`
      :host {
        background: var(--bg-surface-light);
        padding: 12px;
        border-radius: 16px;
      }

      p {
        white-space: break-spaces;
        font-family: monospace, monospace;
        --font-size: var(--p-size);
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`<p><slot></slot></p>`;
}
