import { Tracing } from "@tento-core/tracing";

export namespace GoogleAuth {
  function corsImport(_s: string): Promise<Api> {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.setAttribute("src", "https://accounts.google.com/gsi/client");
      // @ts-ignore
      script.onload = () => resolve(google);
      script.onerror = () => reject(new Error("Could not load Google sign-in"));
      document.head.appendChild(script);
    });
  }

  export type Client = {
    requestCode: () => void;
  };

  /** GIS `CodeResponse`: a code, or a single ASCII OAuth `error`. */
  export type ClientCodeResponse = {
    code?: Option<string>;
    error?: Option<string>;
  };

  export type Api = {
    accounts: {
      oauth2: {
        initCodeClient: (config: {
          client_id: string;
          scope: string;
          ux_mode: "popup";
          select_account: boolean;
          login_hint?: Option<string>;
          include_granted_scopes: boolean;
          error_callback: (error: { type: string }) => void;
          callback: (response: ClientCodeResponse) => void;
        }) => Client;
      };
    };
  };

  /**
   * Why a login ended without a code, as Google Identity Services reported it
   * (https://developers.google.com/identity/oauth2/web/reference/js-reference):
   *
   * - `access_denied`: the code response's OAuth error — the user refused.
   * - `provider_error`: any other OAuth error, or a response without a code.
   * - `popup_failed_to_open`: `error_callback` — the popup could not open.
   * - `popup_closed`: `error_callback` — the popup closed before an OAuth
   *   response. It is NOT a refusal: nothing says the user declined.
   * - `unknown`: `error_callback`'s placeholder for other errors.
   * - `sdk_load_failed`: the GIS script did not load; no popup was requested.
   * - `client_error`: our own code threw around the GIS call (setting up the
   *   client or requesting the code) — not anything Google reported.
   *
   * Only these names leave this module: never a provider message or code.
   */
  export type Failure =
    | "access_denied"
    | "provider_error"
    | "popup_failed_to_open"
    | "popup_closed"
    | "unknown"
    | "sdk_load_failed"
    | "client_error";

  /** The rejection of [`login`]; its message is the one callers already saw. */
  export class LoginError extends Error {
    constructor(readonly failure: Failure, message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = "GoogleAuth.LoginError";
    }
  }

  /**
   * Optional telemetry of one login. Called synchronously and never awaited;
   * a callback that throws (or rejects) is logged and ignored, so an
   * observer can never change the login's outcome.
   */
  export type Observer = {
    /** The authorization popup is being requested; at most once per login, before any failure. */
    readonly onHandoff?: () => void;
    /** The login ended without a code; at most once, after any handoff. */
    readonly onFailure?: (failure: Failure) => void;
  };

  /** One press of a sign-in control, for telemetry: its id ties a press's hooks together. */
  export type Attempt = { readonly id: string };

  /**
   * A fresh press id, or null when one cannot be made (`crypto.randomUUID`
   * is missing outside a secure context, or throws). Never throws: telemetry
   * must never stop a login.
   */
  export function newAttempt(): Attempt | null {
    try {
      const id = globalThis.crypto?.randomUUID?.();
      return typeof id === "string" ? { id } : null;
    } catch {
      return null;
    }
  }

  /** Optional per-press hooks, read when they fire. */
  export type AttemptHooks = {
    readonly onAttempt?: Option<(attempt: Attempt) => void>;
    readonly onAttemptFailure?: Option<(attempt: Attempt, failure: Failure) => void>;
  };

  /**
   * The login observer for one press: both hooks receive the same `attempt`.
   * Without an attempt (no id could be made) there is no observer, so the
   * hooks are skipped and the login runs exactly as without telemetry.
   */
  export function attemptObserver(attempt: Attempt | null, hooks: AttemptHooks): Observer | undefined {
    if (attempt == null) return undefined;
    return {
      onHandoff: () => hooks.onAttempt?.(attempt),
      onFailure: (failure) => hooks.onAttemptFailure?.(attempt, failure),
    };
  }

  export type LoginOptions = {
    hint?: Option<string>;
    observer?: Option<Observer>;
  };

  async function load(): Promise<Api> {
    return await corsImport("https://accounts.google.com/gsi/client");
  }

  export async function login(
    clientId: string,
    scope: string[],
    options: LoginOptions = {},
  ): Promise<string> {
    let google: Api;
    try {
      google = await load();
    } catch {
      notify(() => options.observer?.onFailure?.("sdk_load_failed"));
      throw new LoginError("sdk_load_failed", "Could not load Google sign-in");
    }
    return requestCode(google, clientId, scope, options);
  }

  /** The popup code flow over a loaded GIS API: what [`login`] runs once the script is in. */
  export function requestCode(
    google: Api,
    clientId: string,
    scope: string[],
    options: LoginOptions = {},
  ): Promise<string> {
    const observer = options.observer;
    return new Promise((resolve, reject) => {
      // GIS reports through two callbacks; the first outcome is the only one.
      let settled = false;
      const fail = (failure: Failure, message: string, options?: ErrorOptions) => {
        if (settled) return;
        settled = true;
        notify(() => observer?.onFailure?.(failure));
        reject(new LoginError(failure, message, options));
      };
      try {
        // https://developers.google.com/identity/oauth2/web/guides/use-code-model#popup-mode
        const client = google.accounts.oauth2.initCodeClient({
          client_id: clientId,
          scope: scope.join(" "),
          ux_mode: "popup",
          // Normal sign-in chooses an account; permission upgrades target the linked account.
          select_account: !options.hint,
          login_hint: options.hint,
          include_granted_scopes: true,
          error_callback: (error) =>
            fail(popupFailure(error?.type), "Google sign-in popup was closed or blocked"),
          callback: (response) => {
            if (response.error || !response.code) {
              fail(
                response.error === "access_denied" ? "access_denied" : "provider_error",
                "Google authorization was not granted",
              );
            } else if (!settled) {
              settled = true;
              resolve(response.code);
            }
          },
        });
        notify(() => observer?.onHandoff?.());
        client.requestCode();
      } catch (error) {
        // Thrown locally, before or while requesting the code: ours, not
        // Google's. The rejection keeps the thrown message (as before this
        // classification existed) and the error as its cause; observers get
        // only the failure name.
        fail("client_error", error instanceof Error ? error.message : String(error), { cause: error });
      }
    });
  }

  function popupFailure(type: unknown): Failure {
    switch (type) {
      case "popup_failed_to_open":
      case "popup_closed":
        return type;
      default:
        return "unknown";
    }
  }

  /** Run an observer callback; its failure (sync or async) never reaches the login. */
  function notify(callback: () => unknown): void {
    const logged = (error: unknown) =>
      Tracing.warn("net")("google-auth/observer-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    try {
      const result = callback();
      if (result instanceof Promise) result.catch(logged);
    } catch (error) {
      logged(error);
    }
  }
}
