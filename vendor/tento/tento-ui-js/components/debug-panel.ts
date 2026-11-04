import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";

@component({
  name: "dev-debug-panel",
})
export class DebugPanel extends LonaWebComponent {
  private state: any = {};

  toggleVisibility(force?: boolean) {
    if (force == null) {
      force = this.$("root").style.display != "block";
    }
    this.$("root").style.display = force ? "block" : "none";
  }

  bind(key: string, t: any) {
    this.state[key] = t;
    this.$("root").textContent = JSON.stringify(this.state);
  }

  static $styles = [
    css`
      :host {
        position: fixed;
        pointer-events: none;
        user-select: none;
        bottom: 20px;
        right: 20px;
        z-index: 9999; /* ZIndex.DEBUG */
      }

      #root {
        position: relative;
        height: 200px;
        width: 400px;
        font-size: 0.8125rem;
        padding: 12px;
      }

      #root::after {
        position: absolute;
        content: "";
        inset: 0;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.3);
        border: 1px solid var(--divider);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html` <div id="root"></div> `;
}
