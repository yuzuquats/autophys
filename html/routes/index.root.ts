/**
 * The autophys page: the only place the cookbook, the view-only ui and the client meet. The
 * cookbook builds the shell; each slot gets one ui surface drawing its slice of the client's
 * view through Cookbook.View.mount; the client's Store follows a Source: the daemon's
 * /api/v1 when this page is served by `autophys serve`, with recovery if it cannot answer.
 * `?source=fixtures` or `?source=daemon` forces one. The sidebar status line names it.
 */
import { Cookbook } from "@tento-cookbook/lib.ts";
import { daemon, type Source } from "../client/api.ts";
import { Controller } from "../client/controller.ts";
import { fixtures } from "../client/fixtures/source.ts";
import { Store } from "../client/store.ts";
import { hydrateComponents } from "../ui/components.ts";
import { AutophysDetails } from "../ui/details.ts";
import { AutophysMain } from "../ui/main.ts";
import { AutophysSidebar } from "../ui/sidebar.ts";
import { autophysStyles } from "../ui/styles.ts";
import { tutorial } from "./content.ts";

const USER = "james";
/** How often the open app re-reads the devices waiting to pair (pairings have no stream). */
const PAIRING_POLL_MS = 5000;

// Session cookies are HttpOnly and invalidated by daemon restarts. The client only
// asks for reauthentication; the host owns document reload and its per-tab loop guard.
const REAUTH_WINDOW_MS = 30_000;
function reauth(): void {
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

/** The sidebar status line: which source the records come from. */
async function status(): Promise<Cookbook.Status.Line> {
  await ctl.store.start().catch(() => {});
  const active = source.chosen ? await source.chosen : source;
  if (ctl.store.error) return { tone: "down", text: "Connection unavailable" };
  if (active.name !== "daemon") {
    return { tone: "pending", text: forced === "fixtures" ? "Fixture data · ?source=fixtures" : "Fixture data · no daemon answered" };
  }
  const health = await Cookbook.Status.readHealthz();
  return health.tone === "ok" ? { tone: "ok", text: `Live from the daemon · ${health.text.replace(/^Server ok · /, "")}` } : health;
}

const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const ctl = new Controller(new Store(source), { user: USER, now: clock });

let teardown: (() => void) | null = null;

const app: Cookbook.App = {
  id: "autophys",
  title: "Autophys",
  mount(shell) {
    ctl.shell = { download: (name, type, data) => shell.download(name, type, data), picked: () => shell.onSelect() };
    const removeStyles = shell.addStyles(autophysStyles(shell.scope));
    const handle: typeof ctl.handle = (intent) => {
      if (intent.kind === "select" && intent.id === "devices") {
        const toggle = document.querySelector<HTMLButtonElement>(".ck-details-toggle");
        if (toggle && document.querySelector<HTMLElement>(".ck-panels")?.dataset.mobile !== "details") toggle.click();
        return;
      }
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
    const hydrate = (host: HTMLElement) => hydrateComponents(host, handle);
    const views = [
      Cookbook.View.mount(shell, new AutophysSidebar(shell.slots.queue, handle), () => ctl.view().sidebar),
      Cookbook.View.mount(shell, new AutophysMain(shell.slots.main, handle, shell.classes, hydrate), () => ctl.view().main),
      Cookbook.View.mount(shell, new AutophysDetails(shell.slots.details, handle, shell.classes, hydrate), () => ctl.view().details),
    ];
    // A record arrived or the selection moved: every view re-reads its model (main with FLIP).
    const redraw = () => {
      views.forEach((v) => v.redraw());
      if (ctl.store.error) {
        // Cookbook currently exposes its initial status callback only.
        const line = document.querySelector<HTMLElement>(`${shell.scope} .ck-status`);
        if (line) { line.dataset.tone = "down"; line.textContent = "Connection unavailable"; }
      }
      shell.setCrumb?.(ctl.view().main.crumb.at(-1)?.label ?? "");
    };
    const unsubscribe = ctl.subscribe(redraw);
    redraw();
    void ctl.store.start().catch(() => {}); // Store exposes the failure through the view.
    const poll = setInterval(() => void ctl.store.refreshPairings(), PAIRING_POLL_MS);
    teardown = () => { clearInterval(poll); unsubscribe(); views.forEach((v) => v.dispose()); removeStyles(); };
  },
  unmount() {
    teardown?.();
    teardown = null;
  },
  export: () => ctl.exportDocument(),
};

Cookbook.mount({ tutorial: [...Cookbook.Tutorial.shellSteps, ...tutorial], status, labels: { sidebar: "Workspace" } }).run(app);
