/**
 * The sidebar's pure parts, importable without a DOM: the switcher and section head markup,
 * and the conversion of view-model nodes into tree-list nodes (`$lead`/`$trail` build their
 * elements through the factories passed in, so tests can stand in for the document).
 */
import { ATTR, escapeHtml as esc } from "./intent.ts";
import { ICONS, spinnerSvg } from "./icons.ts";
import type { Action, SidebarModel, Trail, TreeNode } from "./view-model.ts";

export function switcherMarkup(model: SidebarModel): string {
  return ""; // Projects are roots in the workspace tree; there is no switcher.
}

export function actionAttrs(a: Action): string {
  return `${ATTR.role}="action" ${ATTR.name}="${esc(a.name)}" id="ap-action-${
    esc(a.name)
  }"${a.disabled ? " disabled" : ""}${
    a.title ? ` title="${esc(a.title)}"` : ""
  }`;
}

export function sectionMarkup(model: SidebarModel): string {
  const { label, count, add } = model.section;
  if (!label) return "";
  return `<div class="ap-section-head"><span>${
    esc(label)
  }<span class="ap-count">${esc(count)}</span></span>${
    add
      ? `<button type="button" class="ap-add" ${actionAttrs(add)} aria-label="${
        esc(add.label)
      }">${ICONS.plus}</button>`
      : ""
  }</div>`;
}

/** The trail's inner markup: a badge, or an optional spinner then the text. */
export function trailMarkup(t: Trail & { label?: string }): string {
  if (t.badge != null) {
    return `<span class="ap-badge ap-badge-${t.tone ?? "muted"}"${t.label ? ` aria-label="${esc(t.label)}"` : ""} style="display:inline-block;padding:0 6px;border-radius:999px;background:${t.tone === "danger" ? "var(--ap-danger)" : t.tone === "warn" ? "var(--ap-approval-bg,#fff0d4)" : "var(--ck-n200)"};color:${t.tone === "danger" ? "var(--bg)" : t.tone === "warn" ? "var(--ap-warn)" : "var(--ap-sec)"};font:600 10.5px/16px var(--ap-font)">${
      esc(t.badge)
    }</span>`;
  }
  return `${t.spinner ? spinnerSvg(10) : ""}${
    t.text != null ? `<span>${esc(t.text)}</span>` : ""
  }`;
}

/** What the tree-list draws per row, built lazily through the caller's factories. */
export type RowFactories = {
  lead: (svg: string, dim: boolean) => unknown;
  trail: (html: string, tone: string) => unknown;
};

export type ListNode = {
  id: string;
  label: string;
  icon: null;
  selectable: boolean;
  children: ListNode[] | null;
  $lead: () => unknown;
  $trail: (() => unknown) | null;
};

export type RowCache = Map<string, { lead?: { key: string; value: unknown }; trail?: { key: string; value: unknown } }>;
export function listNodes(nodes: TreeNode[], make: RowFactories, cache?: RowCache): ListNode[] {
  const content = (n: TreeNode, kind: "lead" | "trail", key: string, build: () => unknown) => {
    if (!cache) return build();
    const row = cache.get(n.id) ?? {};
    cache.set(n.id, row);
    if (row[kind]?.key !== key) row[kind] = { key, value: build() };
    return row[kind]!.value;
  };
  return nodes.map((n) => ({
    id: n.id,
    label: n.label,
    icon: null,
    selectable: n.selectable,
    $lead: () => content(n, "lead", JSON.stringify([n.icon, !!n.dim]), () => make.lead(ICONS[n.icon], !!n.dim)),
    $trail: n.trail &&
        (n.trail.text != null || n.trail.badge != null || n.trail.spinner)
      ? () => content(n, "trail", JSON.stringify(n.trail), () => make.trail(trailMarkup(n.trail!), n.trail!.tone ?? "muted"))
      : null,
    children: n.children ? listNodes(n.children, make, cache) : null,
  }));
}

/** Changes whenever anything a row draws changes, so a rebind happens only then (spinners keep turning). */
export function treeKey(
  nodes: TreeNode[],
  selectedId: string | null,
  expandedIds: string[],
): string {
  return JSON.stringify([selectedId, expandedIds, nodes]);
}
