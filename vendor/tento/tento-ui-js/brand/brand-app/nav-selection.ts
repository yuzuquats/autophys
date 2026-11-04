import { Router } from "../../router";
import type { BrandApp } from "./brand-app";

export type NavSelection = {
  // The top-level item that owns the current page (renders .nav-current).
  itemHref: Option<string>;
  // The current page path, so the matching dropdown child renders .selected.
  childHref: Option<string>;
};

type NavItem = BrandApp.NavConfig["items"][number];

// Pure: resolve the current route to the nav selection a controlled nav renders.
// Ownership is section-weighted — each top-level item scores how many of its own +
// descendant links sit in the page's section; the highest wins. That is what lets
// a shared section (e.g. /for/* appears under both Product and Solutions) go to
// whichever item carries more of it. Home / sectionless paths own nothing.
export function selectionForRoute(
  navConfig: BrandApp.NavConfig,
  pathname: string,
): NavSelection {
  const section = Router.sectionOf(pathname);
  let itemHref: Option<string> = null;
  let bestScore = 0;
  if (section !== "") {
    for (const item of navConfig.items) {
      if (item.href == null) continue;
      let score = 0;
      for (const href of linkHrefs(item)) {
        if (Router.sectionOf(href) === section) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        itemHref = item.href;
      }
    }
  }
  return { itemHref, childHref: pathname };
}

// An item's own path plus every descendant link path (children + dropdown columns
// + footer) — the link set scored for section ownership.
function linkHrefs(item: NavItem): string[] {
  const hrefs: string[] = [];
  if (item.href) hrefs.push(item.href);
  for (const child of item.children ?? []) {
    if (child.href) hrefs.push(child.href);
  }
  for (const column of item.details?.columns ?? []) {
    for (const child of column.items) {
      if (child.href) hrefs.push(child.href);
    }
  }
  if (item.details?.footer?.href) hrefs.push(item.details.footer.href);
  return hrefs;
}
