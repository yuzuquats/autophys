import { assertEquals } from "jsr:@std/assert";
import type { BrandApp } from "./brand-app.ts";

// nav-selection imports the router, which touches window/history at module load.
Object.defineProperty(globalThis, "window", {
  value: { location: new URL("https://dev.lona.so/"), addEventListener: () => {} },
  configurable: true,
});
Object.defineProperty(globalThis, "document", {
  value: { location: new URL("https://dev.lona.so/") },
  configurable: true,
});
Object.defineProperty(globalThis, "history", {
  value: { pushState: () => {} },
  configurable: true,
});

const { selectionForRoute } = await import("./nav-selection.ts");

const noop = () => {};
const item = (
  label: string,
  href: string,
  childHrefs: string[],
): BrandApp.NavConfig["items"][number] => ({
  label,
  href,
  children: childHrefs.map((h) => ({ label: h, href: h })),
});

// Mirrors the real landing nav (nav.json): Product owns /features/* plus one
// /for/ link; Solutions owns /solutions/* plus all three /for/* persona links;
// Resources owns /blog + /docs; Pricing owns /pricing.
const NAV: BrandApp.NavConfig = {
  items: [
    item("Product", "/features/calendar", [
      "/features/stickers", "/features/sheets", "/features/integrations",
      "/features/ai-chat", "/for/knowledge-workers",
    ]),
    item("Solutions", "/solutions/timezone", [
      "/for/knowledge-workers", "/for/travelers", "/for/athletes",
      "/solutions/health-fitness", "/solutions/personal-analytics",
      "/solutions/team-scheduling",
    ]),
    item("Resources", "/blog", ["/docs"]),
    item("Pricing", "/pricing", []),
  ],
  cta: null,
  onNavigate: noop,
};

Deno.test("selectionForRoute owns a page by its section", () => {
  assertEquals(selectionForRoute(NAV, "/features/calendar").itemHref, "/features/calendar");
  assertEquals(selectionForRoute(NAV, "/solutions/health-fitness").itemHref, "/solutions/timezone");
  assertEquals(selectionForRoute(NAV, "/pricing").itemHref, "/pricing");
});

Deno.test("selectionForRoute resolves a shared section to the heavier owner", () => {
  // /for/* lives under BOTH Product and Solutions; Solutions carries more, so it wins.
  assertEquals(selectionForRoute(NAV, "/for/knowledge-workers").itemHref, "/solutions/timezone");
  assertEquals(selectionForRoute(NAV, "/for/athletes").itemHref, "/solutions/timezone");
});

Deno.test("selectionForRoute owns nothing for home / unowned routes; childHref is the path", () => {
  assertEquals(selectionForRoute(NAV, "/").itemHref, null);
  assertEquals(selectionForRoute(NAV, "/careers/openings").itemHref, null);
  assertEquals(selectionForRoute(NAV, "/features/calendar").childHref, "/features/calendar");
});
