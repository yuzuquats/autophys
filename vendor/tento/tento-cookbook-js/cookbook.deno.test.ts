import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { readRoute, routeUrl } from "./src/route.ts";
import { arrowStage, closePanel, initialPanels, Stepper, togglePanel, visiblePanels } from "./src/model.ts";
import { clampSlide, dragOffset, swipeTarget } from "./src/deck-data.ts";
import { describeHealth, parseHealth, readHealthz } from "./src/status.ts";
import { invert } from "./src/flip.ts";
import { cookbookClasses, placeholderDeck } from "./src/shell.ts";
import { shellSteps } from "./src/tutorial.ts";

Deno.test("routes: landing and app paths round-trip under any base", () => {
  assertEquals(readRoute("/"), { app: false });
  assertEquals(readRoute("/elsewhere"), { app: false });
  assertEquals(readRoute("/app"), { app: true, item: null });
  assertEquals(readRoute("/app/"), { app: true, item: null });
  assertEquals(readRoute("/app/x-2"), { app: true, item: "x-2" });
  assertEquals(readRoute("/app/a/b"), { app: false });
  assertEquals(readRoute("/apple"), { app: false });
  assertEquals(readRoute("/app/%E0%A4%A"), { app: true, item: null });
  assertEquals(readRoute("/w/x", "/w"), { app: true, item: "x" });
  assertEquals(routeUrl({ app: false }), "/");
  assertEquals(routeUrl({ app: true, item: null }), "/app");
  assertEquals(routeUrl({ app: true, item: "a b" }, "/w"), "/w/a%20b");
  assertEquals(readRoute(routeUrl({ app: true, item: "a b" })), { app: true, item: "a b" });
});

Deno.test("panels: desktop flags are independent; phones show one pane", () => {
  const s1 = togglePanel(initialPanels, "sidebar", false);
  assertEquals(visiblePanels(s1, false), { sidebar: false, details: true });
  assertEquals(visiblePanels(togglePanel(s1, "details", false), false), { sidebar: false, details: false });
  assertEquals(visiblePanels(initialPanels, true), { sidebar: false, details: false });
  const phone = togglePanel(initialPanels, "details", true);
  assertEquals(visiblePanels(phone, true), { sidebar: false, details: true });
  assertEquals(visiblePanels(togglePanel(phone, "sidebar", true), true), { sidebar: true, details: false });
  assertEquals(togglePanel(phone, "details", true).mobile, "main");
  assertEquals(closePanel(phone, "details", true).mobile, "main");
  assertEquals(closePanel(initialPanels, "details", false).details, false);
});

Deno.test("drawer: arrow keys move one stop at a time", () => {
  assertEquals(arrowStage("landing", "ArrowDown"), "tour");
  assertEquals(arrowStage("tour", "ArrowDown"), "app");
  assertEquals(arrowStage("app", "ArrowDown"), null);
  assertEquals(arrowStage("app", "ArrowUp"), "tour");
  assertEquals(arrowStage("tour", "ArrowUp"), "landing");
  assertEquals(arrowStage("landing", "ArrowUp"), null);
});

Deno.test("tutorial: stepper advances to the last step, then reports done", () => {
  const stepper = new Stepper(["a", "b", "c"]);
  assertEquals([stepper.step, stepper.last], ["a", false]);
  assertEquals(stepper.advance(), true);
  assertEquals(stepper.advance(), true);
  assertEquals([stepper.step, stepper.last], ["c", true]);
  assertEquals(stepper.advance(), false);
  stepper.restart();
  assertEquals(stepper.index, 0);
  assertThrows(() => new Stepper([]));
  for (const step of shellSteps) {
    for (const selector of step.target ?? []) assertEquals(selector.includes(".ck-"), true, selector);
  }
});

Deno.test("deck: clamping, swipes and edge resistance", () => {
  assertEquals(clampSlide(-1, 6), 0);
  assertEquals(clampSlide(9, 6), 5);
  assertEquals(swipeTarget(2, -300, 1000, 0, 6), 3, "past a fifth goes forward");
  assertEquals(swipeTarget(2, 300, 1000, 0, 6), 1, "past a fifth goes back");
  assertEquals(swipeTarget(2, -100, 1000, 0.1, 6), 2, "short slow drag springs back");
  assertEquals(swipeTarget(2, -40, 1000, -0.9, 6), 3, "flick goes forward");
  assertEquals(swipeTarget(5, -400, 1000, 0, 6), 5, "no slide after the last");
  assertEquals(dragOffset(0, 100, 6), 35);
  assertEquals(dragOffset(0, -100, 6), -100);
  assertEquals(dragOffset(5, -100, 6), -35);
});

Deno.test("deck: the placeholder deck is neutral, uses every body kind and fits the template", () => {
  const slides = placeholderDeck("Example", "/w");
  assertEquals(slides.length, 6);
  assertEquals(slides[0].title, "Example");
  assertEquals(new Set(slides.map((s) => s.body.kind)).size, 6);
  for (const slide of slides) {
    if (slide.title.length > 60) throw new Error(`title too long: ${slide.title}`);
    if (slide.description.length > 120) throw new Error(`description too long: ${slide.description}`);
  }
  const first = slides[0].body;
  assertEquals(first.kind === "actions" && first.primary?.href, "/w");
});

Deno.test("classes: every recipe the contract names is provided and ck- prefixed", () => {
  for (const key of ["toolbar", "button", "primary", "name", "status", "decision"] as const) {
    assertEquals(cookbookClasses[key].startsWith("ck-"), true, key);
  }
  assertEquals(cookbookClasses.cardNameAttribute, "data-card-name");
});

Deno.test("status: parse, describe and fetch healthz", async () => {
  assertEquals(parseHealth({ ok: true, version: "0.1.0", commit: "abcdef0123" }), {
    ok: true,
    version: "0.1.0",
    commit: "abcdef0123",
  });
  assertEquals(parseHealth({ ok: "yes" }), null);
  assertEquals(parseHealth(null), null);
  assertEquals(describeHealth({ ok: true, version: "0.1.0", commit: "abcdef0123" }), {
    tone: "ok",
    text: "Server ok · 0.1.0 · abcdef0",
  });
  assertEquals(describeHealth(null).tone, "down");
  assertEquals(describeHealth({ ok: false, version: "0.1.0", commit: "x" }).tone, "down");
  const okFetch = (() => Promise.resolve(Response.json({ ok: true, version: "0.1.0", commit: "dev" }))) as typeof fetch;
  assertEquals(await readHealthz("/api/healthz", okFetch), { tone: "ok", text: "Server ok · 0.1.0 · dev" });
  const failing = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
  assertEquals((await readHealthz("/api/healthz", failing)).text, "Server unreachable");
  const notFound = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
  assertEquals((await readHealthz("/api/healthz", notFound)).tone, "down");
});

Deno.test("flip: move translates only; box also scales; no-ops are null", () => {
  const a = { left: 0, top: 0, width: 100, height: 50 };
  const b = { left: 40, top: 10, width: 200, height: 50 };
  assertEquals(invert(a, b, "move"), "translate(-40px, -10px) scale(1, 1)");
  assertEquals(invert(a, b, "box"), "translate(-40px, -10px) scale(0.5, 1)");
  assertEquals(invert(a, a, "box"), null);
  assertEquals(invert({ ...a, width: 0 }, b, "move"), null);
});

Deno.test("namespace: lib exports only Cookbook, with the old names gone", async () => {
  const lib = await import("./lib.ts");
  assertEquals(Object.keys(lib), ["Cookbook"]);
  const { Cookbook } = lib;
  assertEquals(typeof Cookbook.mount, "function");
  assertEquals(typeof Cookbook.mount().run, "function");
  assertEquals(typeof Cookbook.View.mount, "function");
  assertEquals(Cookbook.classes.toolbar, "ck-toolbar");
  assertEquals(Cookbook.Deck.placeholderDeck("T").length, 6);
  assertEquals(Cookbook.Tutorial.shellSteps.length, 3);
  for (const gone of ["cookbook", "createCookbook", "cookbookClasses", "placeholderDeck", "PlaceholderApp"]) {
    assertEquals(gone in lib, false, gone);
  }
});

Deno.test("View.mount: draws once, redraws inside reflow from the current model, disposes once", async () => {
  const { Cookbook } = await import("./lib.ts");
  const renders: number[] = [];
  let destroyed = 0, reflows = 0, value = 1;
  const view = { render: (m: number) => void renders.push(m), destroy: () => void destroyed++ };
  const shell = {
    reflow: (change: () => void) => {
      reflows++;
      change();
    },
  };
  const handle = Cookbook.View.mount(shell, view, () => value);
  assertEquals([renders, reflows], [[1], 0], "first draw is immediate, outside reflow");
  value = 2;
  handle.redraw();
  value = 3;
  handle.redraw();
  assertEquals([renders, reflows], [[1, 2, 3], 2], "each redraw reads the model inside reflow");
  handle.dispose();
  handle.dispose();
  handle.redraw();
  assertEquals([renders, destroyed], [[1, 2, 3], 1], "dispose destroys once; redraw after dispose is a no-op");
  const plain: number[] = [];
  Cookbook.View.mount({}, { render: (m: number) => void plain.push(m), destroy() {} }, () => 7).redraw();
  assertEquals(plain, [7, 7], "a shell without reflow still redraws");
});

Deno.test("PlaceholderApp: neutral rows, model and export without a DOM", async () => {
  const { Cookbook } = await import("./lib.ts");
  const app = new Cookbook.PlaceholderApp("demo", "Demo");
  assertEquals([app.id, app.title], ["demo", "Demo"]);
  assertEquals(app.model(), { row: { id: "item-1", title: "Item 1" }, position: 1, count: 3, title: "Demo" });
  assertEquals((app.export() as { selected: string }).selected, "item-1");
});
