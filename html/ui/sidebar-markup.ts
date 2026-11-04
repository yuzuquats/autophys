/**
 * The sidebar's pure parts, importable without a DOM: the switcher and section head markup,
 * and the conversion of view-model nodes into tree-list nodes (`$lead`/`$trail` build their
 * elements through the factories passed in, so tests can stand in for the document).
 */
import { ATTR, escapeHtml as esc } from "./intent.ts";
import { ICONS, spinnerSvg } from "./icons.ts";
import type { Action, SidebarModel, Trail, TreeNode } from "./view-model.ts";

export function switcherMarkup(model: SidebarModel): string {
  const s = model.switcher;
  if (s.kind === "none" || s.kind === "loading" || s.kind === "unavailable") return "";
  if (s.kind === "single") return `<div class="ap-project-label"><span>Project</span><b>${esc(s.options[0]?.label ?? "")}</b></div>`;
  return `<div id="ap-switch" data-ap-switcher data-options="${esc(JSON.stringify(s.options))}" data-value="${esc(s.value)}"></div>`;
}

export function actionAttrs(a: Action): string {
  return `${ATTR.role}="action" ${ATTR.name}="${esc(a.name)}" id="ap-action-${esc(a.name)}"${a.disabled ? " disabled" : ""}${a.title ? ` title="${esc(a.title)}"` : ""}`;
}

export function sectionMarkup(model: SidebarModel): string {
  const { label, count, add } = model.section;
  if (!label) return "";
  return `<div class="ap-section-head"><span>${esc(label)}<span class="ap-count">${esc(count)}</span></span>${add
    ? `<button type="button" class="ap-add" ${actionAttrs(add)} aria-label="${esc(add.label)}">${ICONS.plus}</button>` : ""}</div>`;
}

/** The trail's inner markup: a badge, or an optional spinner then the text. */
export function trailMarkup(t: Trail): string {
  if (t.badge != null) return `<span class="ap-badge">${esc(t.badge)}</span>`;
  return `${t.spinner ? spinnerSvg(10) : ""}${t.text != null ? `<span>${esc(t.text)}</span>` : ""}`;
}

/** What the tree-list draws per row, built lazily through the caller's factories. */
export type RowFactories = {
  lead: (svg: string, dim: boolean) => unknown;
  trail: (html: string, tone: string) => unknown;
};

export type ListNode = {
  id: string; label: string; icon: null; selectable: boolean; children: ListNode[] | null;
  $lead: () => unknown; $trail: (() => unknown) | null;
};

export function listNodes(nodes: TreeNode[], make: RowFactories): ListNode[] {
  return nodes.map((n) => ({
    id: n.id,
    label: n.label,
    icon: null,
    selectable: n.selectable,
    $lead: () => make.lead(ICONS[n.icon], !!n.dim),
    $trail: n.trail && (n.trail.text != null || n.trail.badge != null || n.trail.spinner) ? () => make.trail(trailMarkup(n.trail!), n.trail!.tone ?? "muted") : null,
    children: n.children ? listNodes(n.children, make) : null,
  }));
}

/** Changes whenever anything a row draws changes, so a rebind happens only then (spinners keep turning). */
export function treeKey(nodes: TreeNode[], selectedId: string | null, expandedIds: string[]): string {
  return JSON.stringify([selectedId, expandedIds, nodes]);
}
