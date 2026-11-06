/**
 * The autophys page: the only place the cookbook, the view-only ui and the client meet. The
 * cookbook builds the shell; each slot gets one ui surface drawing its slice of the client's
 * view through Cookbook.View.mount; the client's Store follows a Source: the daemon's
 * /api/v1 when this page is served by `autophys serve`, with recovery if it cannot answer. The main pane reports connection status only while disconnected.
 */
import { bootstrapContext, readContext, type AppContext } from "./context.ts";
import { Cookbook } from "@tento-cookbook/lib.ts";
import { daemon } from "../client/api.ts";
import { selectionAddress } from "./selection-address.ts";
import { Controller } from "../client/controller.ts";
import { Store } from "../client/store.ts";
import { hydrateComponents } from "../ui/components.ts";
import { AutophysDetails } from "../ui/details.ts";
import { hydrateProjectSetup } from "../ui/new-project-components.ts";
import { AutophysMain } from "../ui/main.ts";
import { AutophysSidebar } from "../ui/sidebar.ts";
import { breadcrumbText } from "../ui/breadcrumb.ts";
import { autophysStyles } from "../ui/styles.ts";
import { placeholderStyles } from "../ui/placeholder-styles.ts";
import { deck } from "./content.ts";
import { mountGuidedTour } from "./guided-tour.ts";
import { contentTransitionStyles } from "./content-transition.ts";
import { landingDocs } from "./docs.ts";
import { quietLoading, signedOutView } from "../client/derive/signed-out.ts";
import { signInInPlace, takeSignInError, showSignInError } from "./sign-in-in-place.ts";
import { mountAccount } from "./account-header.ts";
import "./brand.ts";
import "./light-only.ts";

let pendingSignInError = takeSignInError();

// The drawer normalizes history before mounting the app. Keep the original address.
let requestedLocation: { search: string; hash: string } | null = { search: location.search, hash: location.hash };
let context = bootstrapContext();
const identity = () => context?.principal?.email ?? context?.principal?.displayName ?? "browser";
const environment = () => ({ user: identity(), now: clock, capabilities: context?.capabilities });
let sourceEpoch = 0;
const makeStore = () => {
  const epoch = ++sourceEpoch;
  return new Store(daemon({ user: identity(), workspaceId: context?.workspace?.id, principalId: context?.principal?.id, reauth: () => { if (epoch === sourceEpoch) reauth(); } }));
};
/** How often the open app re-reads the devices waiting to pair (pairings have no stream). */
const PAIRING_POLL_MS = 5000;

// Session cookies are HttpOnly and invalidated by daemon restarts. The client only
// asks for reauthentication; the host owns document reload and its per-tab loop guard.
const REAUTH_WINDOW_MS = 30_000;
let signingOut = false;
function reauth(): void {
  if (signingOut) return; // The explicit session transition clears the old Store.
  // Refresh the document context when a login session ends. The workspace
  // renders its inline form and makes no authenticated calls while signed out.
  ctl.store.close();
  guided?.dispose();
  if (context?.auth.canSignOut || context?.auth.canSignIn) {
    // Refresh context at this address; a signed-out workspace owns its form.
    // Preserve the current route and hash instead of leaving for /login.
    location.reload();
    return;
  }
  try {
    const key = "autophys.reauth-at", now = Date.now(), last = Number(sessionStorage.getItem(key));
    if (last && now - last < REAUTH_WINDOW_MS) return;
    sessionStorage.setItem(key, String(now));
  } catch { return; } // Without persistent per-tab storage, refuse an unguarded reload.
  location.reload();
}

const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const ctl = new Controller(makeStore(), environment());
// `serve --login` marks a signed-out page (the Sign in badge). The landing page stays usable:
// the app makes no API calls (no 401, no reload) and its main pane asks to sign in.
let SIGNED_OUT = !!context?.auth.canSignIn && !context.principal;
let walkthroughRequested = false;
const baseView = ctl.view.bind(ctl);
ctl.view = () => {
  if (SIGNED_OUT) return signedOutView(baseView(), context?.auth.allowDemo);
  const view = quietLoading(baseView());
  if (view.main.body.kind === "project-setup") return view;
  return { ...view, main: { ...view.main, actions: [...view.main.actions, { name: "walkthrough", label: "Walkthrough" }] } };
};

let teardown: (() => void) | null = null;
let guided: ReturnType<typeof mountGuidedTour> | undefined;
let resumeSession: (() => void) | undefined;

const app: Cookbook.App = {
  id: "autophys",
  title: "Autophys",
  mount(shell) {
    ctl.shell = { download: (name, type, data) => shell.download(name, type, data), picked: () => shell.onSelect() };
    document.querySelector(".ck-header .ck-export")?.remove();
    // The in-flow lowered landing must not be pulled back over fixed panels by
    // scrollIntoView/focus scrolling the body's hidden overflow container.
    // Clip only while open; the landing document retains its native scrolling.
    const removeStyles = shell.addStyles(autophysStyles(shell.scope) + placeholderStyles(shell.scope) + contentTransitionStyles(shell.scope) + `
      html[data-ck-stage="tour"] body, html[data-ck-stage="app"] body { overflow: clip; }
    `);
    const startupLocation = requestedLocation;
    requestedLocation = null;
    let pendingAddress = startupLocation
      ? selectionAddress(startupLocation.search, startupLocation.hash)
      : null;
    if (startupLocation) {
      history.replaceState(history.state, "", location.pathname + startupLocation.search + startupLocation.hash);
    }
    const addressChanged = () => {
      pendingAddress = selectionAddress(location.search, location.hash);
      if (pendingAddress && ctl.store.snapshot()) {
        const id = pendingAddress; pendingAddress = null;
        ctl.handle({ kind: "select", id });
      }
    };
    window.addEventListener("hashchange", addressChanged);
    const handle: typeof ctl.handle = (intent) => {
      if (intent.kind === "select" && intent.id === "devices") {
        ctl.handle(intent);
        const toggle = document.querySelector<HTMLButtonElement>(".ck-details-toggle");
        const panels = document.querySelector<HTMLElement>(".ck-panels");
        const open = matchMedia("(max-width:639px)").matches ? panels?.dataset.mobile === "details" : panels?.hasAttribute("data-details");
        if (toggle && !open) toggle.click();
        return;
      }
      if (intent.kind === "action" && intent.name === "sign-in") { document.getElementById("ap-account")?.click(); return; }
      if (intent.kind === "action" && intent.name === "walkthrough") { walkthroughRequested = true; shell.startTour?.(); return; }
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
      if (intent.kind === "select" && ctl.view().sidebar.selectedId === intent.id && intent.id !== "devices") {
        history.replaceState(history.state, "", location.pathname + location.search + "#" + encodeURIComponent(intent.id));
      }
    };
    const hydrate = (host: HTMLElement) => { hydrateProjectSetup(host); hydrateComponents(host, handle); };
    const viewShell = { reflow: (draw: () => void) => shell.reflow ? shell.reflow(draw) : draw() };
    let renderedView = ctl.view();
    const views = [
      Cookbook.View.mount(viewShell, new AutophysSidebar(shell.slots.queue, handle), () => renderedView.sidebar),
      Cookbook.View.mount(viewShell, new AutophysMain(shell.slots.main, handle, shell.classes, hydrate), () => renderedView.main),
      Cookbook.View.mount(viewShell, new AutophysDetails(shell.slots.details, handle, shell.classes, hydrate), () => renderedView.details),
    ];
    let viewKeys = [renderedView.sidebar, renderedView.main, renderedView.details].map(model => JSON.stringify(model));
    let crumb = breadcrumbText(renderedView.main.crumb);
    // Streamed records may affect only one pane. Keep the other panes mounted.
    const redraw = () => {
      if (pendingAddress && ctl.store.snapshot()) {
        const id = pendingAddress; pendingAddress = null;
        ctl.handle({ kind: "select", id });
      }
      const view = renderedView = ctl.view();
      const panels = shell.slots.main.closest<HTMLElement>(".ck-panels");
      const setupOnly = view.main.body.kind === "project-setup" && view.sidebar.selectedId !== "devices";
      if (panels && panels.hasAttribute("data-ap-setup-only") !== setupOnly) panels.toggleAttribute("data-ap-setup-only", setupOnly);
      const details = panels?.querySelector<HTMLElement>(".ck-details");
      if (details) details.inert = setupOnly || !panels?.hasAttribute("data-details");
      const nextKeys = [view.sidebar, view.main, view.details].map(model => JSON.stringify(model));
      const previousKeys = viewKeys; viewKeys = nextKeys;
      views.forEach((v, i) => { if (nextKeys[i] !== previousKeys[i]) v.redraw(); });
      const nextCrumb = breadcrumbText(view.main.crumb);
      if (nextCrumb !== crumb) { crumb = nextCrumb; shell.setCrumb?.(crumb); }
      if (SIGNED_OUT && pendingSignInError) {
        const form = shell.slots.main.querySelector<HTMLFormElement>("form.ap-signin");
        if (form) { showSignInError(form, pendingSignInError, false); pendingSignInError = null; }
      }
    };
    const reconcileMain = () => {
      const panels = shell.slots.main.closest<HTMLElement>(".ck-panels");
      const phoneSheet = matchMedia("(max-width:760px)").matches && panels?.dataset.mobile !== "main";
      shell.slots.main.inert = !panels?.hasAttribute("data-ready") || phoneSheet;
    };
    const unsubscribe = ctl.subscribe(redraw);
    guided = mountGuidedTour({ controller: ctl, signedIn: () => !SIGNED_OUT, redraw });
    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "ArrowDown" || event.repeat || event.isComposing ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.composedPath().some(node => node instanceof HTMLElement &&
        (node.matches("input,textarea,select,[role=textbox],[role=dialog],[role=alertdialog]") || node.isContentEditable))) return;
      const stage = document.documentElement.dataset.ckStage;
      if (stage !== "tour" && stage !== "app") return;
      const reveal = () => {
        if (document.documentElement.dataset.ckStage !== "app") return;
        const panels = shell.slots.main.closest<HTMLElement>(".ck-panels");
        if (panels?.hasAttribute("data-ap-setup-only")) return;
        const phone = matchMedia("(max-width:760px)").matches;
        const open = phone ? panels?.dataset.mobile === "details" : panels?.hasAttribute("data-details");
        if (!open) {
          panels?.querySelector<HTMLButtonElement>(".ck-details-toggle")?.click();
        }
        reconcileMain();
      };
      if (stage === "app") { event.preventDefault(); reveal(); }
      // Let the shell leave the tour, then reveal Details before the first paint.
      else queueMicrotask(reveal);
    };
    document.addEventListener("keydown", down, { capture: true });
    redraw();
    let poll: ReturnType<typeof setInterval> | undefined;
    // Store exposes the failure through the view.
    const start = () => { const store = ctl.store; void store.start().catch(() => {}); poll ??= setInterval(() => {
      void ctl.store.refreshPairings(); void ctl.refresh();
      void readContext().then(next => {
        if (ctl.store !== store) return;
        if (next.principal?.id !== context?.principal?.id || next.workspace?.id !== context?.workspace?.id) { reauth(); return; }
        context = next; ctl.updateAccess(identity(), next.capabilities);
      }).catch(() => {});
    }, PAIRING_POLL_MS); };
    // Signed out: the card signs in without a page load, then the workspace starts in place.
    let stopSignIn: (() => void) | undefined;
    resumeSession = () => {
      stopSignIn?.(); stopSignIn = undefined;
      guided?.dispose(); clearInterval(poll); poll = undefined;
      ctl.reset(makeStore(), environment());
      guided = mountGuidedTour({ controller: ctl, signedIn: () => !SIGNED_OUT, redraw });
      pendingAddress = null;
      if (SIGNED_OUT) stopSignIn = signInInPlace(onContextChanged);
      else start();
      redraw();
    };
    if (SIGNED_OUT) stopSignIn = signInInPlace(onContextChanged);
    else if (context) start();
    else void readContext().then(next => { context = next; SIGNED_OUT = !next.principal; resumeSession?.(); }).catch(error => { ctl.store.error = error.message; redraw(); });
    teardown = () => { resumeSession = undefined; document.removeEventListener("keydown", down, { capture: true }); window.removeEventListener("hashchange", addressChanged); guided?.dispose(); guided = undefined; stopSignIn?.(); clearInterval(poll); unsubscribe(); views.forEach((v) => v.dispose()); removeStyles(); };
  },
  unmount() {
    teardown?.();
    teardown = null;
  },
  export: () => ctl.exportDocument(),
};

const docs = landingDocs();
Cookbook.mount({ deck, onStage: (stage) => docs.onStage(stage), tutorial: { start: () => { if (!walkthroughRequested) return []; walkthroughRequested = false; return guided?.source.start() ?? []; }, finish: result => guided?.source.finish?.(result) }, status: null, labels: { sidebar: "Workspace" } }).run(app);
function onContextChanged(next: AppContext): void {
  context = next; SIGNED_OUT = !next.principal; walkthroughRequested = false;
  const bootstrap = document.getElementById("ap-context");
  if (bootstrap) bootstrap.textContent = JSON.stringify(next);
  if (resumeSession) resumeSession();
  else ctl.reset(makeStore(), environment());
}
mountAccount(onContextChanged, pending => { signingOut = pending; });
docs.mount();

// Remove the unused hard-coded shell control before the first app open too.
document.querySelector(".ck-header .ck-export")?.remove();
