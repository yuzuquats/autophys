/**
 * The autophys page: the only place the cookbook, the view-only ui and the client meet. The
 * cookbook builds the shell; each slot gets one ui surface drawing its slice of the client's
 * view through Cookbook.View.mount; the client's Store follows a Source: the fixture, until
 * the daemon serves /api/v1 (src/http.rs) and `fixtures()` becomes `daemon()`.
 */
import { Cookbook } from "@tento-cookbook/lib.ts";
import { Controller } from "../client/controller.ts";
import { fixtures } from "../client/fixtures/source.ts";
import { Store } from "../client/store.ts";
import { AutophysDetails } from "../ui/details.ts";
import { AutophysMain } from "../ui/main.ts";
import { AutophysSidebar } from "../ui/sidebar.ts";
import { autophysStyles } from "../ui/styles.ts";
import { tutorial } from "./content.ts";

const clock = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const ctl = new Controller(new Store(fixtures()), { user: "james", now: clock });

let teardown: (() => void) | null = null;

const app: Cookbook.App = {
  id: "autophys",
  title: "Autophys",
  mount(shell) {
    ctl.shell = { download: (name, type, data) => shell.download(name, type, data), picked: () => shell.onSelect() };
    const removeStyles = shell.addStyles(autophysStyles(shell.scope));
    const views = [
      Cookbook.View.mount(shell, new AutophysSidebar(shell.slots.queue, ctl.handle), () => ctl.view().sidebar),
      Cookbook.View.mount(shell, new AutophysMain(shell.slots.main, ctl.handle, shell.classes), () => ctl.view().main),
      Cookbook.View.mount(shell, new AutophysDetails(shell.slots.details, ctl.handle, shell.classes), () => ctl.view().details),
    ];
    // A record arrived or the selection moved: every view re-reads its model (main with FLIP).
    const unsubscribe = ctl.subscribe(() => views.forEach((v) => v.redraw()));
    void ctl.store.start();
    teardown = () => { unsubscribe(); views.forEach((v) => v.dispose()); removeStyles(); };
  },
  unmount() {
    teardown?.();
    teardown = null;
  },
  export: () => ctl.exportDocument(),
};

Cookbook.mount({ tutorial: [...Cookbook.Tutorial.shellSteps, ...tutorial], status: null, labels: { sidebar: "Workspace" } }).run(app);
