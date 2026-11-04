import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Button } from "../button/button";

// The auth-specific contents that fill the AuthShell's default slot: the
// banner, title, status list, the OAuth buttons, and the terms-of-service line.
// It renders no structural chrome (no round bg, no sizing) — the shell owns
// that. It is one interchangeable page-content unit; the signin page swaps it
// out wholesale for the email-capture card on mobile.
@component({
  name: "std-auth-content",
})
export class AuthContent extends LonaWebComponent {
  static $styles = [
    css`
      :host {
        display: flex;
        flex-direction: column;
        flex-grow: 1;
        min-height: 0;
        width: 100%;
      }

      #frame {
        flex-grow: 1;
        width: 100%;
      }
    `,
    Button.$style,
    css`
      #banner {
        background-color: var(--bg-surface-light);
        border-radius: 12px;
        padding: 8px 8px;
        color: #666;
      }

      #content {
        align-self: center;
        max-width: 440px;
        width: 100%;
        padding-inline: 20px;
      }

      #status-list {
        flex-grow: 1;
        flex-direction: column-reverse;
        align-items: stretch;
        align-self: stretch;
        gap: 4px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="frame">
      <std-center id="banner" style=display:none;>
        <p>Try for free for 14 days. No credit card required.</p>
      </std-center>

      <std-spacer style=min-height:80px;></std-spacer>
      <std-col id="content" style="align-items:center;flex-grow:1;">
        <slot name="title"></slot>
        <std-col id="status-list">
          <slot name="status"></slot>
        </std-col>
        <slot name="button"></slot>
        <p
          style="--margin-top:32px;color:var(--text-ter);font-weight:300;text-align:center;"
        >
          By signing up, I agree to the
          <slot name="privacy-policy"></slot> and <slot name="tos"></slot>.
        </p>
      </std-col>
      <std-spacer></std-spacer>
    </std-col>
  `;
}
