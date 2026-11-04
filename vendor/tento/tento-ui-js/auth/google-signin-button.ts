import { nonnull } from "@tento-core/assert";
import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Button } from "../components/button/button";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Tracing } from "@tento-core/tracing";
import { GoogleAuth } from "./google";

/**
 * @attribute @required google-client-id
 *   ie. 1234-abcd.apps.googleusercontent.com
 * @attribute @required google-client-scopes
 *   comma-delmited scopes
 *   ie. calendar.readonly,calendar.events,userinfo.profile,userinfo.email
 */
@component({
  name: "google-signin-button",
})
export class GoogleSigninButton extends LonaWebComponent {
  onReceiveCode: Option<(s: string) => Promise<void>>;
  /**
   * Optional telemetry: the press asked Google for authorization. One
   * `attempt` per press; the same object reaches `onAttemptFailure`, so its
   * id ties the stages of one press together. A throwing hook is ignored,
   * and when no press id can be made neither hook fires; the login proceeds.
   */
  onAttempt: Option<(attempt: GoogleSigninButton.Attempt) => void> = null;
  /** Optional telemetry: the press ended without a code (see `GoogleAuth.Failure`). */
  onAttemptFailure: Option<
    (attempt: GoogleSigninButton.Attempt, failure: GoogleAuth.Failure) => void
  > = null;

  connectedCallback() {
    GESTURE_MANAGER.addPointerEvent(this.$("root"), {
      onClick: async () => {
        const onReceiveCode = this.onReceiveCode;
        if (!onReceiveCode) {
          Tracing.err("net")("no receive code callback");
          return;
        }
        const clientId = nonnull(this.getAttribute("google-client-id"));
        const scopes = nonnull(this.getAttribute("google-client-scopes"))
          .split(",")
          .map((s) => `https://www.googleapis.com/auth/${s}`);
        // Telemetry never blocks the login: without a press id (e.g. no
        // crypto.randomUUID outside a secure context) the hooks are skipped.
        const attempt = GoogleAuth.newAttempt();
        if (attempt == null) Tracing.warn("net")("google-signin/no-attempt-id", {});
        let code: string;
        try {
          code = await GoogleAuth.login(clientId, scopes, {
            observer: GoogleAuth.attemptObserver(attempt, this),
          });
        } catch (error) {
          // Ended without a code; the hooks above already reported why.
          Tracing.warn("net")("google-signin/no-code", {
            failure: error instanceof GoogleAuth.LoginError ? error.failure : "unknown",
          });
          return;
        }
        await onReceiveCode(code);
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
    <symbol id="google" viewBox="0 0 48 48">
      <g>
        <path fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z">
        </path>
        <path fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z">
        </path>
        <path fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z">
        </path>
        <path fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z">
        </path>
        <path fill="none" d="M0 0h48v48H0z"></path>
      </g>
    </symbol>
  `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <button id="root">
      <svg
        height="16"
        width="16"
        viewBox="0 0 24 24"
        style="margin-right: 12px"
        aria-hidden="true"
      >
        <use href="#google" />
      </svg>
      <p>Continue with Google</p>
    </button>
  `;
}

export namespace GoogleSigninButton {
  /** One press of the button. */
  export type Attempt = GoogleAuth.Attempt;
}
