// A dockable-pane workspace shell, extracted from the video-editor miniapp so any
// fleet app can reuse the same interface: a center stage flanked by panes that
// dock left / right / bottom (tabbed) or float as chromeless windows.
//
// The app supplies the markup skeleton (the ids/classes below are the contract)
// and its own topbar + stage CSS; `Dock` injects the pane-chrome CSS once and owns
// all docking behavior. Panes are authored inside `#pane-source` as
// `<section class="dock-pane" data-pane="<id>" data-pane-title="<Title>">` with a
// `.pane-menubar` header carrying `.dock-actions` buttons (`data-dock="left|right|
// bottom|float"`). The bottom bar carries `[data-dock-active]` buttons.

import "../round";
import { ButtonGroupRow } from "../button-group-row";
import { MiniWindow } from "../mini-window";
import { LonaIcons } from "../../ui/icons";

export type DockLocation = "left" | "right" | "bottom" | "float";

export type DockConfig = {
  /** The `.workspace` element (receives `has-left/right/bottom(-chat)` classes). */
  workspace: HTMLElement;
  dockLeft: HTMLElement;
  dockRight: HTMLElement;
  dockBottomBody: HTMLElement;
  /** The `<std-button-group-row>` used as the bottom-dock tab strip. */
  bottomTabs: ButtonGroupRow<string>;
  bottomPaneTitle: HTMLElement;
  floatLayer: HTMLElement;
  /** Container holding the authored `.dock-pane[data-pane]` sections. */
  paneSource: HTMLElement;
  /** Where each pane docks initially; unlisted panes default to `bottom`. */
  defaultDocks?: Record<string, DockLocation>;
  /** Which pane docks activate on first layout (the visible bottom tab). */
  initialActiveBottom?: string;
  /** Pane id treated as "chat" for the wider chat-dock sizing. Default "chat". */
  chatPaneId?: string;
};

const DOCK_ICONS: Partial<Record<DockLocation, string>> = {
  left: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>`,
  right: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>`,
  bottom: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/></svg>`,
};

export class Dock {
  private panes = new Map<string, HTMLElement>();
  private floatingWindows = new Map<string, MiniWindow>();
  private activeBottomPane: string;
  private chatPaneId: string;

  constructor(private cfg: DockConfig) {
    injectDockStyles();
    this.chatPaneId = cfg.chatPaneId ?? "chat";
    this.activeBottomPane = cfg.initialActiveBottom ?? "";

    for (const pane of cfg.paneSource.querySelectorAll<HTMLElement>(".dock-pane")) {
      const id = pane.dataset.pane;
      if (id) this.panes.set(id, pane);
    }

    this.paintDockIcons();
    this.wirePaneButtons();

    const defaults = cfg.defaultDocks ?? {};
    for (const [id] of this.panes) {
      this.dock(id, defaults[id] ?? "bottom", id === this.activeBottomPane);
    }
    this.updateLayout();

    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-dock-active]")) {
      button.addEventListener("click", () => {
        if (this.activeBottomPane) {
          this.dock(this.activeBottomPane, button.dataset.dockActive as DockLocation);
        }
      });
    }
  }

  /** Move pane `id` to `location`; when bottom, optionally make it the active tab. */
  dock(id: string, location: DockLocation, activate = true): void {
    const pane = this.panes.get(id);
    if (!pane) return;
    this.releaseFrame(id, pane);
    pane.dataset.dock = location;
    pane.classList.remove("active");

    if (location === "left") this.cfg.dockLeft.appendChild(this.makeFrame(pane, location));
    if (location === "right") this.cfg.dockRight.appendChild(this.makeFrame(pane, location));
    if (location === "bottom") {
      this.cfg.dockBottomBody.appendChild(pane);
      if (activate) this.activeBottomPane = id;
    }
    if (location === "float") {
      const offset = [...this.panes.keys()].indexOf(id) * 18;
      const win = MiniWindow.makeWith({ chromeless: true, delegateRadius: true, minWidth: 360 });
      win.style.setProperty("--detached-transform", `translate(${30 + offset}px, ${76 + offset}px)`);
      win.appendChild(this.makeFrame(pane, location));
      this.cfg.floatLayer.appendChild(win);
      win.updateState("detached");
      const menubar = pane.querySelector<HTMLElement>(".pane-menubar");
      if (menubar) win.setDragHandle(menubar);
      this.floatingWindows.set(id, win);
    }
    this.updateLayout();
  }

  /** Bring a bottom-docked pane to the front (activate its tab). */
  focus(id: string): void {
    if (this.panes.get(id)?.dataset.dock === "bottom") this.activateBottom(id);
  }

  pane(id: string): HTMLElement | undefined {
    return this.panes.get(id);
  }

  private makeFrame(pane: HTMLElement, location: DockLocation): HTMLElement {
    const frame = document.createElement("std-round");
    frame.className = "pane-frame";
    frame.dataset.paneFrame = pane.dataset.pane ?? "";
    frame.setAttribute("clip", "");
    frame.setAttribute("bg", "var(--panel)");
    frame.setAttribute("border", "var(--line-strong)");
    frame.setAttribute("radius", "22");
    frame.setAttribute(
      "shadow",
      location === "float" ? "0 18px 50px rgba(25,25,24,.2)" : "0 1px 2px rgba(0,0,0,.12)",
    );
    frame.appendChild(pane);
    return frame;
  }

  private releaseFrame(id: string, pane: HTMLElement): void {
    const previousFrame = pane.closest<HTMLElement>(".pane-frame");
    const previousWindow = this.floatingWindows.get(id);
    previousFrame?.removeAttribute("clip");
    pane.style.removeProperty("clip-path");
    pane.remove();
    if (previousWindow) {
      previousWindow.remove();
      this.floatingWindows.delete(id);
    } else {
      previousFrame?.remove();
    }
  }

  private bottomPanes(): HTMLElement[] {
    return [...this.cfg.dockBottomBody.querySelectorAll<HTMLElement>(":scope > .dock-pane")];
  }

  private activateBottom(id: string): void {
    if (!this.bottomPanes().some((p) => p.dataset.pane === id)) return;
    this.activeBottomPane = id;
    this.updateLayout();
  }

  private updateLayout(): void {
    const { workspace, dockLeft, dockRight, bottomTabs, bottomPaneTitle } = this.cfg;
    const dockedBottom = this.bottomPanes();
    if (!dockedBottom.some((p) => p.dataset.pane === this.activeBottomPane)) {
      this.activeBottomPane = dockedBottom[0]?.dataset.pane ?? "";
    }
    bottomPaneTitle.textContent = this.panes.get(this.activeBottomPane)?.dataset.paneTitle ?? "Pane";

    workspace.classList.toggle("has-left", dockLeft.childElementCount > 0);
    workspace.classList.toggle("has-right", dockRight.childElementCount > 0);
    workspace.classList.toggle("has-bottom", dockedBottom.length > 0);
    workspace.classList.toggle(
      "has-left-chat",
      dockLeft.querySelector(`[data-pane="${this.chatPaneId}"]`) != null,
    );
    workspace.classList.toggle(
      "has-right-chat",
      dockRight.querySelector(`[data-pane="${this.chatPaneId}"]`) != null,
    );

    const tabEntries = dockedBottom.map((p) => ({
      identifier: p.dataset.pane ?? "",
      label: p.dataset.paneTitle ?? p.dataset.pane ?? "Pane",
    }));
    bottomTabs.style.width = `${Math.max(120, Math.min(460, tabEntries.length * 108))}px`;
    if (this.activeBottomPane && tabEntries.length > 0) {
      bottomTabs.style.display = "block";
      bottomTabs.bind(this.activeBottomPane, tabEntries);
      bottomTabs.onSelected = (id) => this.activateBottom(id);
    } else {
      bottomTabs.style.display = "none";
      bottomTabs.bind("", []);
    }
    for (const p of dockedBottom) p.classList.toggle("active", p.dataset.pane === this.activeBottomPane);

    for (const p of this.panes.values()) {
      const location = p.dataset.dock;
      p.querySelectorAll<HTMLButtonElement>("[data-dock]").forEach((button) => {
        button.classList.toggle("active", button.dataset.dock === location);
      });
    }
    document.querySelectorAll<HTMLButtonElement>("[data-dock-active]").forEach((button) => {
      button.classList.toggle("active", button.dataset.dockActive === "bottom");
    });
  }

  private paintDockIcons(): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      ".dock-action[data-dock], .dock-action[data-dock-active]",
    )) {
      const location = (button.dataset.dock ?? button.dataset.dockActive) as DockLocation;
      const icon = DOCK_ICONS[location];
      if (!icon) continue;
      button.replaceChildren(LonaIcons.$svg(icon));
      if (button.title) button.setAttribute("aria-label", button.title);
    }
  }

  private wirePaneButtons(): void {
    for (const [id, pane] of this.panes) {
      pane.querySelectorAll<HTMLElement>(".dock-actions").forEach((actions) => {
        // Keep control presses out of the float window's drag gesture.
        actions.addEventListener("pointerdown", (event) => event.stopPropagation());
      });
      pane.querySelectorAll<HTMLButtonElement>("[data-dock]").forEach((button) => {
        button.addEventListener("click", () => this.dock(id, button.dataset.dock as DockLocation));
      });
    }
  }
}

let stylesInjected = false;
function injectDockStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "lona-dock-styles";
  style.textContent = DOCK_CSS;
  document.head.appendChild(style);
}

// The pane-chrome CSS. Apps define the design tokens it references (--panel,
// --line, --line-strong, --workspace-bg, --window-radius, --workspace-gutter,
// --stage-height, --chat-pane-min-width) plus their own topbar + stage styles.
const DOCK_CSS = `
  .workspace {
    --left-dock-size: 0px; --right-dock-size: 0px;
    --chat-dock-size: calc(var(--chat-pane-min-width, 360px) + 12px);
    position: relative; display: flex; flex-flow: row wrap; align-content: flex-start;
    background: var(--workspace-bg);
  }
  .workspace.has-left { --left-dock-size: 250px; }
  .workspace.has-right { --right-dock-size: 360px; }
  .workspace.has-left-chat { --left-dock-size: var(--chat-dock-size); }
  .workspace.has-right-chat { --right-dock-size: var(--chat-dock-size); }
  .dock-side { min-width: 0; min-height: 0; height: var(--stage-height, 640px); display: flex; flex-direction: column; gap: 6px; padding: 6px; background: transparent; overflow: visible; transition: flex-basis 160ms ease; }
  .dock-side:empty { display: none; }
  #dock-left { flex: 0 0 var(--left-dock-size); }
  #dock-right { flex: 0 0 var(--right-dock-size); }
  .dock-side > .pane-frame { flex: 1 1 0; }
  .dock-side > .pane-frame[data-pane-frame="chat"] { min-width: var(--chat-pane-min-width, 360px); }
  .dock-bottom { flex: 0 0 100%; min-width: 0; min-height: 0; display: none; padding: 9px var(--workspace-gutter, 6px) var(--workspace-gutter, 6px); background: transparent; }
  .workspace.has-bottom .dock-bottom { display: block; }
  .dock-bottom-window { min-height: 0; position: relative; overflow: visible; }
  .dock-shell-surface { width: 100%; height: min-content; }
  .dock-shell-content { width: 100%; min-width: 0; min-height: 0; display: grid; grid-template-rows: 32px auto; }
  .dock-bottom-bar, .pane-menubar {
    min-width: 0; height: 32px; display: flex; align-items: center; justify-content: space-between;
    padding: 0 7px 0 9px; background: color-mix(in srgb, var(--panel) 86%, transparent); border-bottom: 1px solid var(--line);
    position: relative; z-index: 2;
  }
  #bottom-tabs { min-height: 34px; --bg-btn-group-underlay: rgba(228,228,224,.88); --bg-btn-group-selected: white; }
  .dock-actions { display: flex; align-items: center; gap: 2px; }
  .dock-action { width: 24px; height: 22px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #858581; cursor: pointer; font-size: 12px; }
  .dock-action > svg { width: 14px; height: 14px; }
  .dock-action:hover, .dock-action.active { color: var(--ink); background: #e7e7e2; }
  .dock-bottom-body { min-height: 0; position: relative; }
  .dock-bottom-body > .dock-pane { display: none; width: 100%; height: auto; }
  .dock-bottom-body > .dock-pane.active { display: grid; }
  .pane-frame { min-width: 0; min-height: 0; width: 100%; height: 100%; }
  .pane-frame > .dock-pane { width: 100%; height: 100%; }
  .dock-pane { min-width: 0; min-height: 0; position: relative; display: grid; background: transparent; grid-template-rows: 32px minmax(0, 1fr); }
  .dock-pane > .pane-menubar { display: flex; position: relative; z-index: 2; }
  .dock-pane > :not(.pane-menubar) { position: relative; z-index: 1; }
  .dock-bottom-body > .dock-pane > .pane-menubar { display: none; }
  .dock-bottom-body > .dock-pane { grid-template-rows: minmax(0, 1fr); }
  .pane-title { display: flex; align-items: center; gap: 7px; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; font-weight: 720; color: #6f6f6b; white-space: nowrap; }
  .pane-title::before { content: "⠿"; color: #aaa9a4; font-size: 12px; line-height: 1; letter-spacing: 0; }
  #float-layer { position: absolute; inset: 0; z-index: 100; pointer-events: none; }
  #float-layer > std-mini-window { pointer-events: auto; --mini-window-detached-width: clamp(360px, 46vw, 420px); --mini-window-detached-height: min(360px, 65vh); }
  #float-layer > std-mini-window > .pane-frame { width: 100%; height: 100%; }
  #pane-source { display: none; }
`;
