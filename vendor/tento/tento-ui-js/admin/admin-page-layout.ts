import "../components/sidebar/sidebar-container";

import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import {
  SidebarContainer,
  SidebarContainerState,
} from "../components/sidebar/sidebar-container";
import { CSSLength } from "../css-length";
import { Typography } from "../ui/typography";

@component({ name: "std-admin-page-layout" })
export class AdminPageLayout extends LonaWebComponent {
  private $sidebarContainer: SidebarContainer =
    this.hydrate("sidebar-container");
  $navContainer: HTMLElement = this.$("nav");
  $main: HTMLElement = this.$("main");

  connectedCallback() {
    super.connectedCallback();
    this.$sidebarContainer.bind({
      viewModel: SidebarContainerState.docked({
        width: CSSLength.fromPx(240),
        animate: false,
        resizeEnabled: false,
      }),
      delegate: null,
    });
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        display: block;
        height: 100vh;
      }

      #sidebar-container {
        height: 100%;
        --sidebar-container-border-radius: 0;
        --background-color: var(--bg-elevated);
      }

      .sidebar {
        height: 100%;
        padding: 12px;
        border-right: 1px solid var(--divider);
      }

      #sidebar-title {
        color: var(--text-pri);
        --font-size: var(--h5-size);
        --margin-top: 16px;
        --margin-bottom: 24px;
        margin-inline: 8px;
      }

      #main {
        height: 100%;
        width: calc(100% - var(--sidebar-stickied-width));
        overflow: hidden;
      }
    `,
  ];

  static $html = html`
    <std-sidebar-container id="sidebar-container">
      <std-col slot="sidebar" class="sidebar">
        <h1 id="sidebar-title">Admin</h1>
        <div id="nav"></div>
      </std-col>

      <std-col id="main" slot="main-content"></std-col>
    </std-sidebar-container>
  `;
}
