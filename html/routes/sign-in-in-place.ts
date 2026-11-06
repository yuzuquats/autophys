import { readContext, type AppContext } from "./context.ts";
/** Sign-in stays inside the current header dialog or workspace card. */
const SIGN_IN_ERRORS: Record<string, string> = {
  invalid: "That email and password don't match an account.",
  throttled: "Too many sign-in attempts. Wait a few minutes and try again.",
  busy: "Autophys is busy signing people in. Try again in a moment.",
  demo_unavailable: "Demo sign-in is unavailable right now. Try again later or sign in with your account.",
  forbidden: "This page couldn't sign you in. Reload it and try again.",
  workspace_unavailable: "Your account's workspace is unavailable. Contact the account owner.",
  unavailable: "Autophys is temporarily unavailable. Try again in a moment.",
};

/** Native form fallback errors belong in the workspace, without credential autofocus. */
export function takeSignInError(): string | null {
  const url = new URL(location.href);
  const code = url.searchParams.get("signin_error");
  if (code === null) return null;
  url.searchParams.delete("signin_error");
  history.replaceState(history.state, "", url);
  return Object.hasOwn(SIGN_IN_ERRORS, code) ? SIGN_IN_ERRORS[code] : null;
}

let badgeRequest: AbortController | undefined;
/** Identity changes and logout invalidate cosmetic work from earlier sessions. */
export function cancelAccountBadge(): void {
  badgeRequest?.abort();
  badgeRequest = undefined;
}

function replaceBadge(markup: string, principalId: string, current = document.getElementById("ap-account")): void {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const next = template.content.getElementById("ap-account");
  if (!current?.isConnected || !next || next.dataset.signedIn !== "true" || (next.dataset.principalId !== undefined && next.dataset.principalId !== principalId)) return;
  for (const img of next.querySelectorAll<HTMLImageElement>("img")) {
    img.addEventListener("error", () => { img.hidden = true; }, { once: true });
  }
  current.replaceWith(next);
}

/** Older daemons answer 303. Their cosmetic badge never delays workspace entry. */
async function refreshBadge(principalId: string): Promise<void> {
  cancelAccountBadge();
  const request = badgeRequest = new AbortController();
  const current = document.getElementById("ap-account");
  try {
    const response = await fetch("/api/auth/badge", { credentials: "same-origin", cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(2_000)]) });
    if (!response.ok) return;
    const markup = await response.text();
    if (badgeRequest === request && !request.signal.aborted) replaceBadge(markup, principalId, current);
  } catch { /* A cosmetic fetch must never fail sign-in. */ }
  finally { if (badgeRequest === request) badgeRequest = undefined; }
}

async function signInFailure(response: Response): Promise<{ message: string; code: string }> {
  let code = "http";
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string" && Object.hasOwn(SIGN_IN_ERRORS, body.error)) code = body.error;
  } catch { /* A proxy restart can answer HTML rather than JSON. */ }
  const message = SIGN_IN_ERRORS[code] ?? (response.status >= 500 ? SIGN_IN_ERRORS.unavailable
    : response.status === 401 ? SIGN_IN_ERRORS.invalid : response.status === 429 ? SIGN_IN_ERRORS.throttled
    : response.status === 403 ? SIGN_IN_ERRORS.forbidden : response.status === 404 ? SIGN_IN_ERRORS.unavailable
    : "Couldn't sign in. Reload the page and try again.");
  return { message, code };
}

export function signInInPlace(onSignedIn: (context: AppContext) => void, target: Document | HTMLFormElement = document): () => void {
  let listening = true;
  const onSubmit = async (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains("ap-signin")) return;
    event.preventDefault();
    if (form.getAttribute("aria-busy") === "true") return;
    const submitter = (event as SubmitEvent).submitter;
    const action = submitter instanceof HTMLButtonElement && submitter.hasAttribute("formaction") ? submitter.formAction : form.action;
    const passwordSignIn = new URL(action).pathname === "/api/auth/login";
    form.querySelector(".ap-signin-err")?.remove();
    form.setAttribute("aria-busy", "true");
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button[type=submit]")];
    for (const b of buttons) b.disabled = true;
    let stage = "request";
    let requestId: string | null = null;
    try {
      const body = new URLSearchParams();
      // The demo endpoint needs only the destination, never typed credentials.
      for (const [k, v] of new FormData(form)) if (passwordSignIn || k === "next") body.append(k, String(v));
      const response = await fetch(action, { method: "POST", body, redirect: "manual", headers: { Accept: "application/json" }, credentials: "same-origin", signal: AbortSignal.timeout(15_000) });
      const reference = response.headers.get("x-request-id");
      if (reference && /^[a-f0-9]{16}$/.test(reference)) requestId = reference;
      if (response.type !== "opaqueredirect" && !response.ok) {
        const { message, code } = await signInFailure(response);
        console.warn("Autophys sign-in failed", { stage, status: response.status, code, requestId });
        if (listening) showSignInError(form, message, passwordSignIn && response.status === 401);
        return;
      }
      stage = "session";
      // Current daemons resolve the workspace before setting the cookie and
      // return that context with the same server-rendered account control.
      const result = response.ok ? await response.json() as { context: AppContext; badge: string } : null;
      const context = result?.context ?? await readContext();
      if (!context.principal) throw new Error("Session did not resolve an account");
      if (!listening) return;
      if (typeof result?.badge === "string") replaceBadge(result.badge, context.principal.id);
      target.removeEventListener("submit", onSubmit, true);
      onSignedIn(context);
      if (!result) void refreshBadge(context.principal.id);
    } catch {
      console.warn("Autophys sign-in failed", { stage, code: stage === "session" ? "session_unresolved" : "unreachable", requestId });
      if (listening) showSignInError(form, stage === "session"
        ? "Sign-in was accepted, but your session couldn't be confirmed. Reload the page to continue."
        : "Couldn't reach Autophys. Check your connection and try again.", false);
    } finally {
      form.removeAttribute("aria-busy");
      for (const b of buttons) b.disabled = false;
    }
  };
  target.addEventListener("submit", onSubmit, true);
  return () => { listening = false; target.removeEventListener("submit", onSubmit, true); };
}

export function showSignInError(form: HTMLFormElement, message: string, selectPassword = true): void {
  let el = form.querySelector<HTMLElement>(".ap-signin-err");
  if (!el) {
    el = document.createElement("div");
    el.className = "ap-signin-err";
    el.setAttribute("role", "alert");
    form.querySelector("label")?.before(el);
  }
  el.textContent = message;
  if (selectPassword) form.querySelector<HTMLInputElement>("input[name=password]")?.select();
}
