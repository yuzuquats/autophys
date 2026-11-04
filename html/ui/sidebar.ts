/// <reference lib="dom" />
/**
 * The sidebar surface: a switcher, one pinned row, a section head and the tree (tento-ui's
 * std-tree-list). It renders the model it is given and reports intents; it keeps no
 * selection or expansion of its own (the tree runs with caller-owned expansion).
 */
import "@tento-ui/components/tree-list/tree-list";
import { TreeList } from "@tento-ui/components/tree-list/tree-list";
import { hydrateComponents, chevronIcon } from "./components.ts";
import { emptyMarkup, skeletonMarkup } from "./state-markup.ts";
import { ICONS } from "./icons.ts";
import { intentOf, type IntentHandler } from "./intent.ts";
import { listNodes, type RowFactories, sectionMarkup, switcherMarkup, treeKey } from "./sidebar-markup.ts";
import type { SidebarModel } from "./view-model.ts";

const TONE_VAR: Record<string, string> = {
  default: "var(--ap-ink)", muted: "var(--ap-ter)", ok: "var(--ap-ok)", warn: "var(--ap-warn)", run: "var(--ap-run)", danger: "var(--ap-danger)",
};

const factories: RowFactories = {
  lead: (svg, dim) => {
    const el = document.createElement("span");
    el.className = "ap-lead";
    el.style.cssText = "display:inline-flex;width:14px;height:14px;flex:none";
    el.style.color = dim ? "var(--ap-ter)" : "currentColor";
    el.innerHTML = svg;
    hydrateComponents(el, () => {});
    return el;
  },
  trail: (html, tone) => {
    const el = document.createElement("span");
    el.className = "ap-trail";
    el.style.color = TONE_VAR[tone] ?? TONE_VAR.muted;
    el.innerHTML = html;
    return el;
  },
};

export class AutophysSidebar {
  private head = document.createElement("div");
  private pinned = TreeList.make() as TreeList;
  private section = document.createElement("div");
  private tree = TreeList.make() as TreeList;
  private keys = { head: "", pinned: "", tree: "" };
  private abort = new AbortController();

  constructor(host: HTMLElement, private onIntent: IntentHandler) {
    this.pinned.classList.add("ap-tree", "ap-pinned");
    this.tree.classList.add("ap-tree");
    this.head.className = "ap-side-head";
    host.replaceChildren(this.head, this.pinned, this.section, this.tree);
    const { signal } = this.abort;
    for (const type of ["click", "change"] as const) {
      host.addEventListener(type, (e) => {
        const el = (e.target as Element).closest?.<HTMLElement>("[data-ap]");
        const intent = el && host.contains(el) ? intentOf(el as HTMLInputElement, type) : null;
        if (intent) onIntent(intent);
      }, { signal });
    }
  }

  render(model: SidebarModel): void {
    const head = JSON.stringify([model.switcher, model.section, model.notice]);
    if (head !== this.keys.head) {
      this.keys.head = head;
      this.head.innerHTML = switcherMarkup(model);
      this.section.innerHTML = sectionMarkup(model) + (model.notice ? `<div class="ap-side-notice"${model.notice.kind === "loading" ? ' aria-busy="true"' : ""}>${emptyMarkup(model.notice.title, model.notice.description)}${model.notice.kind === "loading" ? skeletonMarkup() : ""}</div>` : "");
      hydrateComponents(this.head, this.onIntent);
      hydrateComponents(this.section, this.onIntent);
    }
    this.pinned.hidden = model.switcher.kind === "loading" || model.switcher.kind === "unavailable";
    const twisty = { icon: chevronIcon };
    const pinnedSelected = model.selectedId === model.pinned.id ? model.pinned.id : null;
    const pk = treeKey([model.pinned], pinnedSelected, []);
    if (pk !== this.keys.pinned) {
      this.keys.pinned = pk;
      this.pinned.bind({
        nodes: listNodes([model.pinned], factories) as unknown as TreeList.Node[], selectedId: pinnedSelected, label: model.pinned.label,
        expansion: { kind: "caller", expandedIds: [], onToggle: () => {} },
        onSelect: (id) => this.onIntent({ kind: "select", id }), twisty,
      });
    }
    const tk = treeKey(model.nodes, model.selectedId, model.expandedIds);
    if (tk !== this.keys.tree) {
      this.keys.tree = tk;
      this.tree.bind({
        nodes: listNodes(model.nodes, factories) as unknown as TreeList.Node[], selectedId: model.selectedId, label: model.treeLabel,
        expansion: { kind: "caller", expandedIds: model.expandedIds, onToggle: (id, open) => this.onIntent({ kind: "toggle", id, open }) },
        onSelect: (id) => this.onIntent({ kind: "select", id }), twisty,
      });
    }
  }

  /** Stop listening; the host keeps its last rendering until the caller clears it. */
  destroy(): void {
    this.abort.abort();
  }
}
