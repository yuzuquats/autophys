import { readContext, type AppContext } from "../client/context.ts";
/**
 * `serve --login`, signed out: the main pane's sign-in card submits in place. A full page load
 * would boot on the landing page and replay the drawer's landing-to-app slide, the panel entry
 * and the tutorial; instead the form posts with fetch, the header badge is swapped for the
 * signed-in one the server renders, and `onSignedIn` starts the workspace in the open panes.
 */
const SIGN_IN_ERRORS: Record<string, string> = {
  invalid: "That email and password don't match an account.",
  throttled: "Too many sign-in attempts. Wait a few minutes and try again.",
  busy: "Autophys is busy signing people in. Try again in a moment.",
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

export function signInInPlace(onSignedIn: (context: AppContext) => void, target: Document | HTMLFormElement = document): () => void {
  let listening = true;
  const onSubmit = async (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains("ap-signin")) return;
    event.preventDefault();
    if (form.getAttribute("aria-busy") === "true") return;
    form.setAttribute("aria-busy", "true");
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button[type=submit]")];
    for (const b of buttons) b.disabled = true;
    try {
      const body = new URLSearchParams();
      for (const [k, v] of new FormData(form)) body.append(k, String(v));
      // "Continue as demo" posts the same form to /api/auth/demo (its formaction).
      const submitter = (event as SubmitEvent).submitter;
      const action = submitter instanceof HTMLButtonElement && submitter.hasAttribute("formaction") ? submitter.formAction : form.action;
      const r = await fetch(action, { method: "POST", body, redirect: "manual", headers: { Accept: "application/json" }, credentials: "same-origin", signal: AbortSignal.timeout(15_000) });
      if (r.type === "opaqueredirect" || r.ok) {
        const context = await readContext();
        if (!context.principal) throw new Error("Session did not resolve an account");
        if (!listening) return;
        await swapBadge();
        if (!listening) return;
        target.removeEventListener("submit", onSubmit, true);
        onSignedIn(context);
        return;
      }
      if (listening) showSignInError(form, r.status === 401 ? SIGN_IN_ERRORS.invalid : r.status === 429
        ? SIGN_IN_ERRORS.throttled : "Couldn't sign in. Try again.");
    } catch {
      if (listening) showSignInError(form, "Couldn't reach Autophys. Try again.");
    } finally {
      form.removeAttribute("aria-busy");
      for (const b of buttons) b.disabled = false;
    }
  };
  target.addEventListener("submit", onSubmit, true);
  return () => { listening = false; target.removeEventListener("submit", onSubmit, true); };
}

/** Replace the Sign in button with the account badge the server renders for this session. */
async function swapBadge(): Promise<void> {
  try {
    const r = await fetch("/api/auth/badge", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const template = document.createElement("template");
    template.innerHTML = await r.text();
    const next = template.content.getElementById("ap-account");
    const current = document.getElementById("ap-account");
    if (next && current) current.replaceWith(next);
  } catch { /* the badge is cosmetic; the session works without it */ }
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
