import "../components/prompt";
import "../components/input/property-list";
import "../ui/dev-mode-switch";

import { SystemApi } from "../admin/system-api";
import { Network } from "@tento-web/admin/system-routes";
import { html, LonaWebComponent } from "../component";
import { component } from "../component-decorators";
import { css, Style } from "../component-styles";
import { Button } from "../components/button/button";
import { Divider } from "../components/divider";
import { PropertyList } from "../components/input/property-list";
import { Toaster } from "../components/toast/toaster";
import { DevMode, DevModeUtils } from "../dev-mode";
import { GESTURE_MANAGER } from "../gesture-manager";
import { DevModeSwitch } from "../ui/dev-mode-switch";
import { Typography } from "../ui/typography";

@component({
  name: "dev-version-info-popover",
})
export class VersionInfoPopover extends LonaWebComponent {
  private static persistentHandle: Option<Toaster.Persistent.Handle>;

  private $plist = this.hydrate<PropertyList>("plist");
  private $devModeSwitch = this.hydrate<DevModeSwitch>("dev-mode-row");

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$("cta"), {
      onClick: () => VersionInfoPopover.persistentHandle?.dismiss(),
    });
    this.$devModeSwitch.onSelected = (mode) => {
      DevModeUtils.setMode(mode);
      globalThis.location.reload();
    };
    this.syncWithServer();
  }

  static async showPersistent(): Promise<void> {
    if (VersionInfoPopover.persistentHandle) {
      VersionInfoPopover.persistentHandle.dismiss();
      VersionInfoPopover.persistentHandle = undefined;
      return;
    }

    const $popover = VersionInfoPopover.make();
    VersionInfoPopover.persistentHandle = Toaster.showPersistent(
      "version-info",
      $popover,
    );
  }

  private async syncWithServer(): Promise<void> {
    const pingResp = await fetch("/_/app/ping");
    const mode = pingResp.headers.get("x-lona-dev-mode") as Option<DevMode>;
    if (!mode) return;

    this.$devModeSwitch.bind(mode);

    const info = await SystemApi.get("/_/app/version", { query: { mode } });
    this.bind(info);
  }

  bind(info: Network.BundleVersionInfo): this {
    this.$plist.bind({
      server: {
        label: "server",
        $e: Typography.small(info.serverVersion),
        order: 0,
      },
      host: {
        label: "host",
        $e: Typography.small(info.serverHost ?? "-"),
        order: 1,
      },
      dbHostAlias: {
        label: "db/host",
        $e: Typography.small(info.dbHostAlias ?? "-"),
        order: 2,
      },
      dbName: {
        label: "db/name",
        $e: Typography.small(info.dbName ?? "-"),
        order: 3,
      },
      frontend: {
        label: "fe",
        $e: Typography.small(info.feVersion?.version ?? "unknown"),
        order: 4,
      },
      gitHash: {
        label: "fe/hash",
        $e: Typography.small(info.feVersion?.gitHash ?? "-"),
        order: 5,
      },
      stage: {
        label: "fe/stage",
        $e: Typography.small(info.feVersion?.stage ?? "-"),
        order: 6,
      },
      built: {
        label: "fe/built-on",
        $e: Typography.small(
          info.feVersion
            ? new Date(info.feVersion.epochMs).toLocaleString()
            : "-",
        ),
        order: 7,
      },
      path: {
        label: "fe/path",
        $e: Typography.small(info.feVersion?.path ?? "-").assignStyles({
          lineBreak: "anywhere",
        }),
        order: 8,
      },
    });

    return this;
  }

  static $styles: Style.Compat[] = [
    Button.$style,
    Divider.$hr,
    css`
      :host {
        max-width: 320px;
        display: flex;
      }

      #root {
        display: flex;
      }

      #text {
        padding: 20px;
      }

      #title {
        color: var(--text-sec);
      }

      #cta-row {
        border-top: 1px solid var(--divider);
        padding: 12px 20px;
      }

      #contents {
        min-width: 320px;
      }

      #plist {
        margin: 8px;
        display: block;
        --label-min-width: 80px;
        min-height: 250px;
      }

      #dev-mode-row {
        padding: 12px 20px;
      }

      hr {
        margin: 0;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-prompt-layout id="root">
      <std-col id=contents slot=text>
        <std-col id="text">
          <h1 id="title" class="h3">Version Info</h1>
        </std-col>
        <hr />
        <std-property-list id="plist"></std-property-list>
        <hr />
        <dev-mode-switch id="dev-mode-row"></dev-mode-switch>
        <std-row id="cta-row">
          <std-spacer></std-spacer>
          <button id="cta" primary>Dismiss</button>
        </std-row>
      </std-col>
    </std-prompt-layout>
  `;
}
