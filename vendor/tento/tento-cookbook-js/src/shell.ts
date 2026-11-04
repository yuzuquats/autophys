import { h, reducedMotion } from "./dom.ts";
import { createDeck } from "./deck.ts";
import type { DeckSlide } from "./deck-data.ts";
import { installDrawer } from "./drawer.ts";
import { createHeader } from "./header.ts";
import type { Stage } from "./model.ts";
import { createPanels } from "./panels.ts";
import { describeHealth, readHealthz, type StatusLine } from "./status.ts";
import { cookbookCss } from "./styles.ts";
import { createTutorial, shellSteps, type TutorialStep } from "./tutorial.ts";
import type { CookbookApp, CookbookClasses, CookbookHost, CookbookShell } from "./types.ts";

export type ShellOptions = {
  /** The pitch deck for an app; default: placeholderDeck(app.title). */
  deck?: (app: CookbookApp) => readonly DeckSlide[];
  /** Tutorial steps; default: shellSteps, which point only at shell pieces. */
  tutorial?: readonly TutorialStep[];
  /** Path prefix of the open app (default /app). The server must answer it with index.html. */
  appPath?: string;
  /** Sidebar status line; default reads GET /api/healthz. null hides it. */
  status?: (() => Promise<StatusLine>) | null;
  /** Panel headings (default "Workspace" and "Details"). */
  labels?: { sidebar?: string; details?: string };
  /** Told whenever the drawer moves between landing, tour and app. */
  onStage?: (stage: Stage) => void;
};

export const cookbookClasses: Required<CookbookClasses> = {
  toolbar: "ck-toolbar",
  button: "ck-btn",
  primary: "ck-btn-primary",
  name: "ck-name",
  status: "ck-status-text",
  decision: "ck-decision",
  cardNameAttribute: "data-card-name",
  list: "ck-list",
  listItem: "ck-list-item",
};

/** Six neutral slides, one of each body kind; slide one carries the title. */
export function placeholderDeck(title: string, appPath = "/app"): DeckSlide[] {
  const open = { label: "Open app", href: appPath };
  const stat = (label: string) => ({ value: "—", label });
  const lead = (n: number, word: string) => ({
    eyebrow: { label: `Slide ${n}` },
    title: `Placeholder title for slide ${word}.`,
    description: "Placeholder description.",
  });
  return [
    {
      eyebrow: { icon: "mark" },
      title,
      description: "Placeholder description for the first slide.",
      body: { kind: "actions", primary: open, stats: [stat("Placeholder"), stat("Placeholder"), stat("Placeholder")] },
    },
    { ...lead(2, "two"), body: { kind: "person", name: "Placeholder name", role: "Placeholder role" } },
    {
      ...lead(3, "three"),
      body: {
        kind: "breakdown",
        stats: [stat("Placeholder"), stat("Placeholder"), stat("Placeholder")],
        segments: [
          { label: "Part A", value: "", share: 20 },
          { label: "Part B", value: "", share: 50, emphasis: true },
          { label: "Part C", value: "", share: 30 },
        ],
      },
    },
    {
      ...lead(4, "four"),
      body: {
        kind: "comparison",
        columns: ["Column A", "Column B"],
        rows: [1, 2, 3].map((n) => ({ label: `Row ${n}`, before: "Placeholder", after: "Placeholder" })),
      },
    },
    { ...lead(5, "five"), body: { kind: "demo", caption: "Placeholder" } },
    {
      ...lead(6, "six"),
      body: {
        kind: "result",
        bars: [{ label: "Bar A", value: "—", share: 100 }, { label: "Bar B", value: "—", share: 40, emphasis: true }],
        primary: open,
      },
    },
  ];
}

/** A host that builds the shell (header, deck, tutorial, panels) and runs
 * one app in it. The app is mounted into fresh slots each time the drawer
 * opens and unmounted once the deck has settled back. Public as
 * Cookbook.mount (src/cookbook.ts). */
export function mountHost(options: ShellOptions = {}): CookbookHost {
  return {
    run(app, runOptions = {}) {
      const root = runOptions.root ?? document.body;
      const appPath = options.appPath ?? "/app";
      if (!document.querySelector("style[data-cookbook]")) {
        const style = document.createElement("style");
        style.dataset.cookbook = "";
        style.textContent = cookbookCss;
        document.head.append(style);
      }
      if (!document.title) document.title = app.title;
      const scopeId = app.id.replace(/[^a-zA-Z0-9_-]/g, "-");
      const panels = createPanels({
        scopeId,
        sidebarLabel: options.labels?.sidebar ?? "Workspace",
        detailsLabel: options.labels?.details ?? "Details",
      });
      const appStyles = new Set<HTMLStyleElement>();
      let mounted = false;
      const header = createHeader({
        title: app.title,
        appPath,
        onHome: () => drawer.close(),
        onExport: () =>
          shell.download(`${scopeId}-export.json`, "application/json", JSON.stringify(app.export(), null, 2)),
      });
      const shell: CookbookShell = {
        get slots() {
          return slotsNow;
        },
        scope: `.ck-app[data-cookbook="${scopeId}"]`,
        classes: cookbookClasses,
        addStyles(css) {
          const style = document.createElement("style");
          style.dataset.cookbookApp = scopeId;
          style.textContent = css;
          document.head.append(style);
          appStyles.add(style);
          return () => {
            style.remove();
            appStyles.delete(style);
          };
        },
        onSelect: () => panels.showMain(),
        download(filename, type, data) {
          const url = URL.createObjectURL(new Blob([data], { type }));
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        setCrumb: (text) => header.setCrumb(text),
        reflow: (change) => panels.reflow(change),
      };
      let slotsNow = panels.freshSlots();
      const tutorial = createTutorial(options.tutorial ?? shellSteps);
      const deck = createDeck(options.deck?.(app) ?? placeholderDeck(app.title, appPath));
      const backToTop = h("button", "ck-footer-link", { type: "button" }, "Back to top");
      backToTop.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: reducedMotion() ? "instant" : "smooth" });
        header.brand.focus({ preventScroll: true });
      });
      const footer = h("footer", "ck-footer", null,
        h("span", "ck-footer-name", null, app.title),
        h("nav", "ck-footer-links", { "aria-label": "Footer" },
          h("a", "ck-footer-link", { href: appPath }, "Open app"),
          backToTop,
        ),
      );
      const drawer = installDrawer({
        root,
        header,
        deck,
        footer,
        panels,
        tutorial,
        appPath,
        onOpen() {
          if (mounted) return;
          slotsNow = panels.freshSlots();
          app.mount(shell);
          mounted = true;
        },
        onClosed() {
          if (!mounted) return;
          app.unmount();
          mounted = false;
          // A closed app leaves nothing behind; the next mount gets empty slots.
          slotsNow = panels.freshSlots();
          header.setCrumb("");
        },
        onStage: options.onStage,
      });
      const status = options.status === undefined ? () => readHealthz() : options.status;
      if (status) {
        panels.setStatus({ tone: "pending", text: "Checking server…" });
        void status().then((line) => panels.setStatus(line)).catch(() => panels.setStatus(describeHealth(null)));
      } else panels.setStatus(null);
    },
  };
}
