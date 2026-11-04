import "@tento-ui/components/round";

import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";
import { Round } from "@tento-ui/components/round";

@component({
  name: "std-all-complete-state",
})
export class AllCompleteState extends LonaWebComponent {
  private $bg: Round = this.hydrate<Round>("bg").bind({
    bg: "var(--bg-surface-light)",
    radius: 24,
  });

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        position: relative;
        width: 100%;
      }

      #content {
        position: relative;
        padding: 24px 16px;
        text-align: center;
      }

      #text {
        color: var(--text-sec);
      }

      #bg {
        width: 100%;
      }
    `,
  ];

  static $html = html`
    <std-round id="bg" floating></std-round>
    <div id="content">
      <p id="text">All completed!</p>
    </div>
  `;
}
