/**
 * The autophys page: the only place the cookbook, the view-only ui and the client meet. The
 * cookbook builds the shell; each slot gets one ui surface drawing its slice of the client's
 * view through Cookbook.View.mount; the client's Store follows a Source: the daemon's
 * /api/v1 when this page is served by `autophys serve`, with recovery if it cannot answer.
 * `?source=fixtures` or `?source=daemon` forces one. The main pane reports connection status only while disconnected.
 */
import { Cookbook } from "@tento-cookbook/lib.ts";
import { daemon, type Source } from "../client/api.ts";
import { Controller } from "../client/controller.ts";
import { fixtures } from "../client/fixtures/source.ts";
import { Store } from "../client/store.ts";
import { hydrateComponents } from "../ui/components.ts";
import { AutophysDetails } from "../ui/details.ts";
import { hydrateProjectSetup } from "../ui/new-project-components.ts";
import { AutophysMain } from "../ui/main.ts";
import { AutophysSidebar } from "../ui/sidebar.ts";
import { breadcrumbText } from "../ui/breadcrumb.ts";
import { autophysStyles } from "../ui/styles.ts";
import { placeholderStyles } from "../ui/placeholder-styles.ts";
import { deck, tutorial } from "./content.ts";
import { mountGuidedTour } from "./guided-tour.ts";
import { landingDocs } from "./docs.ts";
import { quietLoading, signedOutView } from "../client/derive/signed-out.ts";
import { signInInPlace } from "./sign-in-in-place.ts";
import { mountAccount } from "./account-header.ts";
import "./brand.ts";
import "./light-only.ts";
import "./tour-ring.ts";

const USER = "james";
/** How often the open app re-reads the devices waiting to pair (pairings have no stream). */
const PAIRING_POLL_MS = 5000;

// Session cookies are HttpOnly and invalidated by daemon restarts. The client only
// asks for reauthentication; the host owns document reload and its per-tab loop guard.
const REAUTH_WINDOW_MS = 30_000;
function reauth(): void {
  // `serve --login` (the page carries the account badge): a 401 means the session ended, so
  // sign in again and come back here rather than reloading into the same 401.
  if (document.getElementById("ap-account")) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return;
  }
  try {
    const key = "autophys.reauth-at", now = Date.now(), last = Number(sessionStorage.getItem(key));
    if (last && now - last < REAUTH_WINDOW_MS) return;
    sessionStorage.setItem(key, String(now));
  } catch { return; } // Without persistent per-tab storage, refuse an unguarded reload.
  location.reload();
}

const forced = new URLSearchParams(location.search).get("source");
const source: Source & { chosen?: Promise<Source> } = forced === "fixtures" ? fixtures() as Source
  : forced === "daemon" ? daemon({ user: USER, reauth })
  : daemon({ user: USER, reauth });

const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
let ctl = new Controller(new Store(source), { user: USER, now: clock });
// `serve --login` marks a signed-out page (the Sign in badge). The landing page stays usable:
// the app makes no API calls (no 401, no reload) and its main pane asks to sign in.
let SIGNED_OUT = forced !== "fixtures" && document.getElementById("ap-account")?.dataset.signedIn === "false";
const DEMO = document.getElementById("ap-account")?.dataset.demo === "true";
const baseView = ctl.view.bind(ctl);
ctl.view = () => SIGNED_OUT ? signedOutView(baseView(), DEMO) : quietLoading(baseView());

let teardown: (() => void) | null = null;
let guided: ReturnType<typeof mountGuidedTour> | null = null;

const app: Cookbook.App = {
  id: "autophys",
  title: "Autophys",
  mount(shell) {
    ctl.shell = { download: (name, type, data) => shell.download(name, type, data), picked: () => shell.onSelect() };
    document.querySelector(".ck-header .ck-export")?.remove();
    // The in-flow lowered landing must not be pulled back over fixed panels by
    // scrollIntoView/focus scrolling the body's hidden overflow container.
    // Clip only while open; the landing document retains its native scrolling.
    const removeStyles = shell.addStyles(autophysStyles(shell.scope) + placeholderStyles(shell.scope) + `
      html[data-ck-stage="tour"] body, html[data-ck-stage="app"] body { overflow: clip; }
    `);
    const handle: typeof ctl.handle = (intent) => {
      if (intent.kind === "select" && intent.id === "devices") {
        ctl.handle(intent);
        const toggle = document.querySelector<HTMLButtonElement>(".ck-details-toggle");
        const panels = document.querySelector<HTMLElement>(".ck-panels");
        const open = matchMedia("(max-width:639px)").matches ? panels?.dataset.mobile === "details" : panels?.hasAttribute("data-details");
        if (toggle && !open) toggle.click();
        return;
      }
      if (intent.kind === "action" && intent.name === "sign-in") { location.assign("/login?next=/app"); return; }
      if (SIGNED_OUT) return; // Nothing else works without an account; the main pane says so.
      if (intent.kind === "action" && intent.name === "retry") { location.reload(); return; }
      if (intent.kind === "action" && intent.name === "copy-sdk") {
        const body = ctl.view().main.body;
        if (body.kind === "onboarding") void (async () => {
          try {
            await navigator.clipboard.writeText(body.snippet);
            ctl.handle({ kind: "action", name: "sdk-copied" });
          } catch {
            ctl.handle({ kind: "action", name: "sdk-select" });
            const code = shell.slots.main.querySelector(".ap-code");
            if (code) { const range = document.createRange(); range.selectNodeContents(code); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
          }
        })();
        return;
      }
      ctl.handle(intent);
    };
    const hydrate = (host: HTMLElement) => { hydrateProjectSetup(host); hydrateComponents(host, handle); };
    const views = [
      Cookbook.View.mount(shell, new AutophysSidebar(shell.slots.queue, handle), () => ctl.view().sidebar),
      Cookbook.View.mount(shell, new AutophysMain(shell.slots.main, handle, shell.classes, hydrate), () => ctl.view().main),
      Cookbook.View.mount(shell, new AutophysDetails(shell.slots.details, handle, shell.classes, hydrate), () => ctl.view().details),
    ];
    // A record arrived or the selection moved: every view re-reads its model (main with FLIP).
    const redraw = () => {
      const view = ctl.view();
      const panels = shell.slots.main.closest<HTMLElement>(".ck-panels");
      const setupOnly = view.main.body.kind === "project-setup" && view.sidebar.selectedId !== "devices";
      panels?.toggleAttribute("data-ap-setup-only", setupOnly);
      const details = panels?.querySelector<HTMLElement>(".ck-details");
      if (details) details.inert = setupOnly || !panels?.hasAttribute("data-details");
      views.forEach((v) => v.redraw());
      shell.setCrumb?.(breadcrumbText(view.main.crumb));
    };
    const unsubscribe = ctl.subscribe(redraw);
    guided = mountGuidedTour({ get: () => ctl, set: (next) => { ctl = next; }, redraw });
    redraw();
    let poll: ReturnType<typeof setInterval> | undefined;
    // Store exposes the failure through the view.
    const start = () => { void ctl.store.start().catch(() => {}); poll = setInterval(() => { void ctl.store.refreshPairings(); void ctl.refresh(); }, PAIRING_POLL_MS); };
    // Signed out: the card signs in without a page load, then the workspace starts in place.
    let stopSignIn: (() => void) | undefined;
    if (SIGNED_OUT) stopSignIn = signInInPlace(() => { SIGNED_OUT = false; start(); redraw(); });
    else start();
    teardown = () => { guided?.dispose(); guided = null; stopSignIn?.(); clearInterval(poll); unsubscribe(); views.forEach((v) => v.dispose()); removeStyles(); };
  },
  unmount() {
    teardown?.();
    teardown = null;
  },
  export: () => ctl.exportDocument(),
};

const docs = landingDocs();
Cookbook.mount({ deck, onStage: (stage) => { docs.onStage(stage); if (stage === "tour") queueMicrotask(() => guided?.offer()); }, tutorial: [...Cookbook.Tutorial.shellSteps, ...tutorial], status: null, labels: { sidebar: "Workspace" } }).run(app);
mountAccount();
docs.mount();

// Remove the unused hard-coded shell control before the first app open too.
document.querySelector(".ck-header .ck-export")?.remove();
