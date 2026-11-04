import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Button } from "../components/button/button";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Tracing } from "@tento-core/tracing";

/**
 * "Continue with Microsoft" button. Unlike `GoogleSigninButton` there is
 * no client SDK — Microsoft auth runs as a popup redirect flow the app
 * layer owns — so this is presentation only: the app assigns `onPress`
 * to open its OAuth popup.
 */
@component({
  name: "microsoft-signin-button",
})
export class MicrosoftSigninButton extends LonaWebComponent {
  onPress: Option<() => Promise<void>>;

  connectedCallback() {
    GESTURE_MANAGER.addPointerEvent(this.$("root"), {
      onClick: async () => {
        const onPress = this.onPress;
        if (!onPress) {
          Tracing.err("net")("no microsoft signin press callback");
          return;
        }
        await onPress();
      },
    });
  }

  static $styles = [
    Button.$style,
    css`
      :host {
        display: flex;
        background-color: white;
        color: #444;
        border-radius: 4px;
        height: 48px;
        box-shadow: 0px 1px 3px 2px var(--black16);
      }

      #root {
        width: 100%;
        transition: background-color 0.3s ease, color 0.3s ease;
        border-radius: inherit;
      }

      #root:hover {
        background-color: var(--bg-hover, rgba(0, 0, 0, 0.08));
        color: var(--color);
      }

      #root:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $icons: Option<string[]> = [
    /* xml */ `
    <symbol id="microsoft" viewBox="0 0 23 23">
      <rect x="1" y="1" width="10" height="10" fill="#F25022"></rect>
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00"></rect>
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF"></rect>
      <rect x="12" y="12" width="10" height="10" fill="#FFB900"></rect>
    </symbol>
  `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <button id="root">
      <svg
        height="16"
        width="16"
        viewBox="0 0 23 23"
        style="margin-right: 12px"
        aria-hidden="true"
      >
        <use href="#microsoft" />
      </svg>
      <p>Continue with Microsoft</p>
    </button>
  `;
}
