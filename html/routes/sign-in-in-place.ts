/**
 * `serve --login`, signed out: the main pane's sign-in card submits in place. A full page load
 * would boot on the landing page and replay the drawer's landing-to-app slide, the panel entry
 * and the tutorial; instead the form posts with fetch, the header badge is swapped for the
 * signed-in one the server renders, and `onSignedIn` starts the workspace in the open panes.
 */
const MISMATCH = "That email and password don't match an account.";

export function signInInPlace(onSignedIn: () => void): () => void {
  const onSubmit = async (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains("ap-signin")) return;
    event.preventDefault();
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button[type=submit]")];
    for (const b of buttons) b.disabled = true;
    try {
      const body = new URLSearchParams();
      for (const [k, v] of new FormData(form)) body.append(k, String(v));
      // "Continue as demo" posts the same form to /api/auth/demo (its formaction).
      const submitter = (event as SubmitEvent).submitter;
      const action = submitter instanceof HTMLButtonElement && submitter.hasAttribute("formaction") ? submitter.formAction : form.action;
      const r = await fetch(action, { method: "POST", body, redirect: "manual", credentials: "same-origin" });
      if (r.type === "opaqueredirect" || r.ok) {
        document.removeEventListener("submit", onSubmit, true);
        await swapBadge();
        onSignedIn();
        return;
      }
      showError(form, r.status === 401 ? MISMATCH : "Couldn't sign in. Try again.");
    } catch {
      showError(form, "Couldn't reach Autophys. Try again.");
    } finally {
      for (const b of buttons) b.disabled = false;
    }
  };
  document.addEventListener("submit", onSubmit, true);
  return () => document.removeEventListener("submit", onSubmit, true);
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

function showError(form: HTMLFormElement, message: string): void {
  let el = form.querySelector<HTMLElement>(".ap-signin-err");
  if (!el) {
    el = document.createElement("div");
    el.className = "ap-signin-err";
    el.setAttribute("role", "alert");
    form.querySelector("label")?.before(el);
  }
  el.textContent = message;
  form.querySelector<HTMLInputElement>("input[name=password]")?.select();
}
