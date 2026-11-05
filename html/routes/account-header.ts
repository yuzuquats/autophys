/** Account control in the header; sign-in stays over the current page. */
import { initHtmlElement } from "@tento-ui/init/html-element.global";
import { Dialog } from "@tento-ui/components/dialog/dialog";
import { signInFields } from "../ui/sign-in-fields.ts";
import { SIGN_IN_TITLE, SIGN_IN_DESCRIPTION } from "../client/derive/signed-out.ts";
import { signInInPlace } from "./sign-in-in-place.ts";

const formStyles = `
:host { --bg:#fff;--text-pri:#141414;--text-sec:#5b5b5b;--blue:#141414;--bg-hover-opaque:#efefef;
  --dialog-padding-preset:28px;--dialog-max-width-preset:min(420px,calc(100vw - 32px));
  --std-modal-max-height:calc(100dvh - 32px) !important;
  transition:opacity 180ms ease-out,transform 220ms cubic-bezier(.16,1,.3,1) !important; }
#panel { max-height:var(--std-modal-max-height);overflow:auto;font:14px/1.5 var(--ap-font,system-ui); }
#title { font:600 22px/1.3 var(--ap-font,system-ui);letter-spacing:-.02em; }
#description { font:14px/1.5 var(--ap-font,system-ui); }
.ap-signin { display:grid;gap:14px;margin-top:16px;color:var(--text-pri); }
.ap-signin label { display:grid;gap:6px;font-weight:600;font-size:13px; }
.ap-signin input { width:100%;box-sizing:border-box;min-width:0;padding:11px 12px;
  border:1px solid #d6d6d6;border-radius:8px;background:#fff;color:inherit;font:400 16px/1.4 var(--ap-font,system-ui); }
.ap-signin input:focus-visible { outline:2px solid #141414;outline-offset:1px; }
.ap-signin button { min-height:44px;padding:10px 16px;border:0;border-radius:8px;
  background:#141414;color:#fff;font:600 14px/1.5 var(--ap-font,system-ui);cursor:pointer; }
.ap-signin button:hover { background:#333; }
.ap-signin button:focus-visible { outline:2px solid #141414;outline-offset:3px; }
.ap-signin button:disabled { opacity:.55;cursor:wait; }
.ap-signin .ap-signin-demo { background:#efefef;color:#141414; }
.ap-signin .ap-signin-demo:hover { background:#e4e4e4; }
.ap-signin-err { padding:10px 12px;border-radius:8px;background:#fdecec;color:#9b1c1c;font-size:13px; }
::selection { background:#d9ecfa;color:#141414; }
@media(prefers-reduced-motion:reduce) {
  :host { --slide-in-y:0px !important;transition:opacity 120ms linear !important; }
}
`;

export function mountAccount(onSignedIn: () => void): void {
  initHtmlElement();
  const account = document.getElementById("ap-account");
  const links = document.querySelector(".ck-header .ck-nav-links");
  if (account && links && account.parentElement !== links) links.append(account);
  if (account?.dataset.signedIn !== "false") return;
  account.setAttribute("aria-haspopup", "dialog");
  const overlayStyle = document.createElement("style");
  overlayStyle.textContent = "body { --bg-overlay:rgb(0 0 0 / 32%); }";
  document.head.append(overlayStyle);
  let modal: Dialog | null = null;
  document.addEventListener("click", event => {
    const trigger = (event.target as Element).closest?.<HTMLAnchorElement>("#ap-account[data-signed-in=false]");
    if (!trigger || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (modal) return;
    const form = document.createElement("form");
    form.className = "ap-signin";
    form.method = "post";
    form.action = "/api/auth/login";
    form.innerHTML = signInFields(trigger.dataset.demo === "true");
    const stopSignIn = signInInPlace(() => {
      modal?.dismiss();
      onSignedIn();
    }, form);
    const background = [...document.querySelectorAll<HTMLElement>(".ck-app,.ck-landing,.ck-header,.ap-landing-docs,.ck-footer")]
      .map(node => ({ node, inert: node.inert }));
    const overflow = document.documentElement.style.overflow;
    const dialog = Dialog.makeWith({
      title: SIGN_IN_TITLE, description: SIGN_IN_DESCRIPTION,
      $body: () => form, actions: [], alert: false, dismissible: true,
      onDismiss: () => {
        stopSignIn();
        for (const { node, inert } of background) node.inert = inert;
        document.documentElement.style.overflow = overflow;
        modal = null;
        // The shared restore ran while the header was inert. Restore after
        // releasing it, including the new badge when sign-in replaced it.
        const focus = trigger.isConnected ? trigger : document.querySelector<HTMLElement>("#ap-account button");
        focus?.focus({ preventScroll: true });
      },
    });
    const style = document.createElement("style");
    style.textContent = formStyles;
    dialog.shadowRoot!.append(style);
    dialog.dataset.apSignin = "";
    // The shell also owns arrow/Escape shortcuts. Keep modal keys inside;
    // the shared Dialog handles Tab and its Overlay owns backdrop dismissal.
    dialog.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); dialog.dismiss(); }
    });
    modal = dialog;
    dialog.open();
    // The shared close component binds its icon when connected.
    requestAnimationFrame(() => dialog.shadowRoot?.querySelector("#close")?.shadowRoot
      ?.querySelector("std-icon-button")?.setAttribute("aria-label", "Close sign in"));
    for (const { node } of background) node.inert = true;
    document.documentElement.style.overflow = "hidden";
  });
}
