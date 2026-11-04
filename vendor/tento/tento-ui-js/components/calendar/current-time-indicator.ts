import { LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";

@component({
  name: "std-current-time-indicator",
})
export class CurrentTimeIndicator extends LonaWebComponent {
  static $styles: Style.Compat[] = [
    css`
      :host {
        position: relative;
        height: 2px;
        background: var(--red);
        background: #ff453a;
        width: calc(100% - 1px);
        border-radius: 1px;
        margin-inline: 0.5px;
        pointer-events: none;
      }

      :host::before {
        content: "";
        position: absolute;
        left: 0px;
        top: -4px;
        width: 8px;
        height: 8px;
        border-radius: 8px;
        border: 1px solid var(--bg);
        background: #ff453a;
      }
    `,
  ];
}
