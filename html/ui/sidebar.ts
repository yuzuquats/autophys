/// <reference lib="dom" />
/**
 * A frame-hosted rail: creation and devices, then one project tree. It renders the model it is given and reports intents; it keeps no
 * selection or expansion of its own (the tree runs with caller-owned expansion).
 */
import "@tento-ui/components/tree-list/tree-list";
import { Rail } from "@tento-ui/components/rail/rail";
import { RailSection } from "@tento-ui/components/rail/rail-section";
import { TreeList } from "@tento-ui/components/tree-list/tree-list";
import { chevronIcon, hydrateComponents } from "./components.ts";
import { DEVICE_GLYPH, PROJECT_GLYPH } from "./sidebar-glyphs.ts";
import { sidebarStyles } from "./sidebar-styles.ts";
import { emptyMarkup, skeletonMarkup } from "./state-markup.ts";
import { ICONS } from "./icons.ts";
import { type IntentHandler, intentOf } from "./intent.ts";
import {
  listNodes,
  type RowFactories,
  trailMarkup,
  treeKey,
} from "./sidebar-markup.ts";
import type { SidebarExtras } from "./sidebar-model.ts";
import { escapeHtml as esc } from "./intent.ts";
import type { SidebarModel } from "./view-model.ts";

const TONE_VAR: Record<string, string> = {
  default: "var(--ap-ink)",
  muted: "var(--ap-ter)",
  ok: "var(--ap-ok)",
  warn: "var(--ap-warn)",
  run: "var(--ap-run)",
  danger: "var(--ap-danger)",
};

const factories: RowFactories = {
  lead: (svg, dim) => {
    const el = document.createElement("span");
    el.className = "ap-lead";
    el.style.cssText = "display:inline-flex;width:13px;height:13px;flex:none";
    el.style.color = dim ? "var(--ap-ter)" : "currentColor";
    el.innerHTML = svg === ICONS.device ? DEVICE_GLYPH : svg === ICONS.workspace ? PROJECT_GLYPH : svg;
    hydrateComponents(el, () => {});
    for (const marker of el.querySelectorAll<HTMLElement>("[data-ap-icon]")) marker.style.cssText = "display:inline-flex;width:13px;height:13px;flex:none";
    for (const svg of el.querySelectorAll("svg")) { svg.setAttribute("width", "13"); svg.setAttribute("height", "13"); }
    return el;
  },
  trail: (html, tone) => {
    const el = document.createElement("span");
    el.className = "ap-trail";
    el.style.cssText = "display:inline-flex;align-items:center;gap:4px;white-space:nowrap;font:11px/16px var(--ap-font);font-variant-numeric:tabular-nums";
    el.style.color = TONE_VAR[tone] ?? TONE_VAR.muted;
    el.innerHTML = html;
    return el;
  },
};

export class AutophysSidebar {
  private rail = Rail.make() as Rail;
  private pinned = document.createElement("button");
  private section = RailSection.make() as RailSection;
  private notice = document.createElement("div");
  private tree = TreeList.make() as TreeList;
  private footer = document.createElement("div");
  private keys = { head: "", pinned: "", tree: "" };
  private abort = new AbortController();

  constructor(host: HTMLElement, private onIntent: IntentHandler) {
    this.pinned.classList.add("ap-nav-row", "ap-devices");
    this.pinned.type = "button";
    this.pinned.dataset.ap = "select";
    this.pinned.dataset.apId = "devices";
    this.tree.classList.add("ap-tree");
    this.rail.bind({ title: null, count: null, width: { kind: "frame" }, onCollapsedChange: null, onWidthChange: null });
    host.classList.add("ap-sidebar");
    const style = document.createElement("style");
    style.textContent = sidebarStyles(".ck-app[data-cookbook] .ap-sidebar");
    this.section.className = "ap-projects";
    this.footer.className = "ap-new-project";
    this.footer.innerHTML =
      `<button class="ap-nav-row" type="button" data-ap="action" data-ap-name="new-project">${ICONS.plus}<span>New project</span></button>`;
    hydrateComponents(this.footer, this.onIntent);
    this.section.append(this.tree, this.notice);
    this.rail.append(this.footer, this.pinned, this.section);
    host.replaceChildren(style, this.rail);
    const { signal } = this.abort;
    for (const type of ["click", "change"] as const) {
      host.addEventListener(type, (e) => {
        const el = (e.target as Element).closest?.("[data-ap]") as HTMLElement | null;
        const intent = el && host.contains(el)
          ? intentOf(el as HTMLInputElement, type)
          : null;
        if (intent) onIntent(intent);
      }, { signal });
    }
  }

  render(model: SidebarModel & SidebarExtras): void {
    const scrollTop = this.rail.bodyScrollTop;
    const create = this.footer.querySelector("button")!;
    create.setAttribute("aria-pressed", String(!!model.creatingProject && model.selectedId !== "devices"));
    create.disabled = model.switcher.kind === "loading" || model.switcher.kind === "unavailable";
    const head = JSON.stringify([model.section, model.notice]);
    if (head !== this.keys.head) {
      this.keys.head = head;
      this.section.bind({ title: "Projects", count: model.nodes.length });
      // The workspace total remains explicit even when there are no projects.
      const count = this.section.shadowRoot?.querySelector<HTMLElement>("#count");
      if (count && model.nodes.length === 0) { count.textContent = "0"; count.hidden = false; }
      this.notice.innerHTML = (model.notice
          ? `<div class="ap-side-notice"${
            model.notice.kind === "loading" ? ' aria-busy="true"' : ""
          }>${emptyMarkup(model.notice.title, model.notice.description)}${
            model.notice.kind === "loading" ? skeletonMarkup() : ""
          }</div>`
          : "");
      hydrateComponents(this.notice, this.onIntent);
    }
    this.pinned.hidden = false;
    const twisty = { icon: chevronIcon };
    const pinnedSelected = model.selectedId === model.pinned.id
      ? model.pinned.id
      : null;
    const pk = treeKey([model.pinned], pinnedSelected, []);
    if (pk !== this.keys.pinned) {
      this.keys.pinned = pk;
      this.pinned.innerHTML = `${DEVICE_GLYPH}<span>${esc(model.pinned.label)}</span>${model.pinned.trail ? trailMarkup(model.pinned.trail) : ""}`;
      this.pinned.setAttribute("aria-pressed", String(pinnedSelected != null));
    }
    const treeSelected = model.creatingProject ? null : model.selectedId;
    const tk = treeKey(model.nodes, treeSelected, model.expandedIds);
    if (tk !== this.keys.tree) {
      this.keys.tree = tk;
      this.tree.bind({
        nodes: listNodes(model.nodes, factories) as unknown as TreeList.Node[],
        selectedId: treeSelected,
        label: model.treeLabel,
        expansion: {
          kind: "caller",
          expandedIds: model.expandedIds,
          onToggle: (id, open) => this.onIntent({ kind: "toggle", id, open }),
        },
        onSelect: (id) => this.onIntent({ kind: "select", id }),
        twisty,
      });
      const labels = new Map<string, string>();
      const visit = (nodes: SidebarModel["nodes"]) => { for (const n of nodes) { labels.set(n.id, `${n.label} · ${n.id}`); if (n.children) visit(n.children); } };
      visit(model.nodes);
      for (const row of this.tree.shadowRoot?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? []) {
        row.title = labels.get(row.dataset.id ?? "") ?? "";
        const name = row.querySelector<HTMLElement>(":scope > .line .name");
        if (name && row.dataset.id?.startsWith("hint:")) { name.style.fontFamily = "var(--ck-mono)"; name.style.setProperty("--font-size", "var(--text-8px)"); }
      }
    }
    // The kit clips names to a flexible column. Reserve the intrinsic label
    // width when its accessory would shorten it; the surrounding tree region
    // can scroll horizontally for unusually long SDK names.
    this.tree.style.width = "100%";
    this.tree.style.minWidth = "100%";
    const names = [...this.tree.shadowRoot?.querySelectorAll<HTMLElement>(".name") ?? []];
    const required = Math.max(this.rail.clientWidth, ...names.map((name) => {
      const line = name.closest(".line") as HTMLElement;
      return line.getBoundingClientRect().width + Math.max(0, name.scrollWidth - name.clientWidth);
    }));
    this.tree.style.minWidth = `${Math.ceil(required)}px`;
    this.rail.bodyScrollTop = scrollTop;
  }

  /** Stop listening; the host keeps its last rendering until the caller clears it. */
  destroy(): void {
    this.abort.abort();
  }
}
