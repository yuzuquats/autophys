import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Constants } from "@tento-core/constants";

// The round-background SHELL for the auth surface. It owns everything
// structural — page sizing, the side-content rail, and the round-bg panel with
// a single default slot — and renders NO auth-specific content. Whatever fills
// the default slot IS the page content; on mobile the signin page swaps the
// whole contents (auth content vs. email-capture card) inside this same shell.
@component({
  name: "std-auth-shell",
})
export class AuthShell extends LonaWebComponent {
  onConnected: EmptyFunction = Constants.EMPTY_FUNCTION;

  connectedCallback() {
    super.connectedCallback();
    this.onConnected();
  }

  static $styles = [
    css`
      :host {
        height: 100%;
        width: 100%;
        display: flex;
        flex-direction: column;
        container-type: inline-size;
      }

      #root {
        width: 100%;
        height: 100%;
      }

      #side-content {
        display: none;
        flex-basis: 0%;
        padding: 2px;
      }

      .side-content-card {
        background: #18181b;
        width: 100%;
        height: 100%;
        border-radius: 8px;
      }

      /* The margin is fluid (not stepped) so the panel never snaps while
         resizing: above 536px viewport the container is capped and margins
         sit at 36px; from 536px down to 488px the margins absorb the shrink
         (50cqw slope = 0.5px per side per viewport px) keeping the panel at
         a constant 464px; below 488px margins hold at 12px and the panel
         shrinks fluidly with the viewport. */
      #main-content {
        padding: 12px;
        background: var(--bg);
        border-radius: 16px;
        box-shadow: var(--box-shadow);
        margin-inline: clamp(12px, calc(50cqw - 232px), 36px);
        margin-block: 12px;
        flex-grow: 1;
        max-height: 100vh;
      }

      /* Fixed panel width (not content-sized): the signin page swaps whole
         surfaces inside this shell (auth content vs. email-capture card) and
         their natural widths differ — a content-sized container would snap
         the panel width at the mobile/desktop boundary. Surfaces narrower
         than the panel center within it. */
      #main-content-container {
        max-height: 800px;
        width: min(536px, 100%);
        height: 100%;
        margin-block: auto;
        align-self: center;
        margin-left: auto;
      }

      @container (width < 840px) {
        #main-content-container {
          margin-inline: auto;
        }
      }

      @container (width > 480px) {
        #side-content {
          display: none;
        }
      }

      @container (width > 960px) {
        #side-content {
          display: block;
        }
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <std-col id="side-content">
        <slot name="side-content"></slot>
      </std-col>

      <std-col id="main-content-container">
        <std-col id="main-content">
          <slot></slot>
        </std-col>
      </std-col>
    </std-row>
  `;
}
