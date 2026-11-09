/**
 * Following a deep link's account step (decisions.md DL-3) before the workbench selects it:
 * sign in as the demo when signed out, or ask before leaving another account for the demo.
 * The decision itself is open-address.ts; this module owns the dialog and the requests.
 */
import { Dialog } from "@tento-ui/components/dialog/dialog";
import type { AppContext } from "./context.ts";
import { type OpenAddress, openAccess, openAddress } from "./open-address.ts";

/** A demo sign-in this tab started recently: never retry it in a loop. */
const DEMO_ATTEMPT_KEY = "autophys.open-demo-at";
const DEMO_RETRY_MS = 30_000;

export type OpenStep =
  /** Select this once the workspace has loaded. */
  | { kind: "select"; address: OpenAddress }
  /** This session cannot open the link (or the person stayed): remove it from the address. */
  | { kind: "drop" }
  /** The page is navigating to sign in; do nothing more. */
  | { kind: "away" };

/**
 * The same `POST /api/auth/demo` the "Continue as demo" button sends, as a form navigation, so
 * the daemon sets the session and returns to this link (`next`). False when the tab tried it
 * moments ago and is still signed out, or has no session storage to guard a retry with.
 */
function signInAsDemo(search: string): boolean {
  try {
    const last = Number(sessionStorage.getItem(DEMO_ATTEMPT_KEY));
    if (last && Date.now() - last < DEMO_RETRY_MS) return false;
    sessionStorage.setItem(DEMO_ATTEMPT_KEY, String(Date.now()));
  } catch { return false; }
  const form = document.createElement("form");
  form.method = "post";
  form.action = "/api/auth/demo";
  form.hidden = true;
  const next = document.createElement("input");
  next.type = "hidden";
  next.name = "next";
  next.value = location.pathname + search;
  form.append(next);
  document.body.append(form);
  form.submit();
  return true;
}

const DIALOG_STYLE = `:host { --bg:#fff;--text-pri:#141414;--text-sec:#5b5b5b;--blue:#141414;--bg-hover-opaque:#efefef;
  --dialog-padding-preset:28px;--dialog-max-width-preset:min(420px,calc(100vw - 32px));
  --bg-btn-pri:#141414;--fg-btn-pri:#fff;--bg-btn-pri-hover:#333;--bg-btn-sec:#efefef;--fg-btn-sec:#141414;--bg-btn-sec-hover:#e4e4e4; }
#title { font:600 20px/1.3 var(--ap-font,system-ui);letter-spacing:-.02em; }
#description { font:14px/1.5 var(--ap-font,system-ui); }`;

/** Ask before signing out of the current account. Escape, the backdrop or Stay answer no. */
function confirmSwitch(): Promise<boolean> {
  return new Promise(resolve => {
    let answer = false;
    const dialog = Dialog.makeWith({
      title: "Switch to the demo workspace?",
      description: "You'll be signed out of your workspace.",
      $body: null,
      alert: true,
      dismissible: true,
      actions: [
        { label: "Stay here", type: "secondary", onClick: () => dialog.dismiss() },
        { label: "Switch", type: "primary", onClick: () => { answer = true; dialog.dismiss(); } },
      ],
      onDismiss: () => resolve(answer),
    });
    const style = document.createElement("style");
    style.textContent = DIALOG_STYLE;
    dialog.shadowRoot?.append(style);
    // The shell owns arrow and Escape shortcuts; keep the dialog's keys inside it.
    dialog.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); dialog.dismiss(); }
    });
    dialog.open();
  });
}

/** Whether the server would open this address for the current caller. */
async function reachable(address: OpenAddress): Promise<boolean> {
  const path = `/open/${address.user}/${address.kind}/${encodeURIComponent(address.name)}`;
  try {
    const r = await fetch(path, { method: "HEAD", credentials: "same-origin", redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch { return false; }
}

async function signOut(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/logout", { method: "POST", body: new URLSearchParams(),
      credentials: "same-origin", redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return response.ok || response.type === "opaqueredirect";
  } catch { return false; }
}

/**
 * The account step for the page's `?open=` link. `search` is the address the page was loaded
 * with (the shell rewrites history while it mounts). `onSigningOut` is the page's sign-out guard
 * (the store must not reload on the 401s a deliberate sign-out causes).
 */
export async function followOpenLink(search: string, context: AppContext | null, onSigningOut: (pending: boolean) => void): Promise<OpenStep | null> {
  const address = openAddress(search);
  if (!address) return new URLSearchParams(search).has("open") ? { kind: "drop" } : null;
  // Without a bootstrap (a static build) there is no account to change: look for it here.
  const access = context ? openAccess(address, {
    signedIn: !!context.principal,
    demoWorkspace: !!context.workspace?.demo,
    login: context.auth.canSignIn || context.auth.canSignOut,
    allowDemo: context.auth.allowDemo,
  }) : "open";
  switch (access) {
    case "open":
      try { sessionStorage.removeItem(DEMO_ATTEMPT_KEY); } catch { /* only a retry guard */ }
      return { kind: "select", address };
    case "sign-in-demo":
      return signInAsDemo(search) ? { kind: "away" } : { kind: "drop" };
    case "confirm-switch": {
      // Never sign someone out for a link the server would refuse.
      if (!await reachable(address)) return { kind: "drop" };
      if (!await confirmSwitch()) return { kind: "drop" };
      onSigningOut(true);
      if (!await signOut()) { onSigningOut(false); return { kind: "drop" }; }
      if (signInAsDemo(search)) return { kind: "away" };
      // Signed out, but the demo sign-in was just tried: show the signed-out page.
      location.reload();
      return { kind: "away" };
    }
    case "drop":
      return { kind: "drop" };
  }
}
