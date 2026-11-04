import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { readRoute, routeUrl } from "./src/route.ts";
import { arrowStage, closePanel, initialPanels, Stepper, togglePanel, visiblePanels } from "./src/model.ts";
import { clampSlide, dragOffset, swipeTarget } from "./src/deck-data.ts";
import { deckPull, deckTransforms } from "./src/deck.ts";
import { describeHealth, parseHealth, readHealthz } from "./src/status.ts";
import { invert } from "./src/flip.ts";
import { cookbookClasses, placeholderDeck } from "./src/shell.ts";
import { shellSteps } from "./src/tutorial.ts";
import { cookbookCss } from "./src/styles.ts";
import source0 from "./src/cookbook.ts" with { type: "text" };
import source1 from "./src/deck-data.ts" with { type: "text" };
import source2 from "./src/deck.ts" with { type: "text" };
import source3 from "./src/dom.ts" with { type: "text" };
import source4 from "./src/drawer.ts" with { type: "text" };
import source5 from "./src/flip.ts" with { type: "text" };
import source6 from "./src/header.ts" with { type: "text" };
import source7 from "./src/model.ts" with { type: "text" };
import source8 from "./src/motion.ts" with { type: "text" };
import source9 from "./src/panels.ts" with { type: "text" };
import source10 from "./src/route.ts" with { type: "text" };
import source11 from "./src/shell.ts" with { type: "text" };
import source12 from "./src/status.ts" with { type: "text" };
import source13 from "./src/styles.ts" with { type: "text" };
import source14 from "./src/tutorial.ts" with { type: "text" };
import source15 from "./src/types.ts" with { type: "text" };
import source16 from "./src/view.ts" with { type: "text" };
import source17 from "./demo/placeholder-app.ts" with { type: "text" };
import source18 from "./demo/routes/index.root.ts" with { type: "text" };

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

Deno.test("deck: interrupted swipes settle relative to the displayed start", () => {
  assertEquals(swipeTarget(.3, -500, 1000, 0, 6), 1, "a grab during 0 to 1 must not skip to slide 2");
  assertEquals(swipeTarget(.3, -100, 1000, 0.1, 6), 0, "a short drag returns to the nearest starting slide");
  assertEquals(swipeTarget(.7, 500, 1000, 0, 6), 0, "the reverse swipe uses the rounded start too");
  assertEquals(swipeTarget(.7, -40, 1000, -0.9, 6), 2, "a flick advances from the rounded start");
  assertEquals(swipeTarget(.3, -200, 1000, -0.4, 6), 0, "distance and velocity thresholds stay strict");
});

Deno.test("deck: page scale follows proximity to the fractional center", () => {
  const centered = deckTransforms(1, 3);
  assertEquals(centered.map((p) => p.translate), [-1, 0, 1]);
  assertEquals(centered.map((p) => p.scale), [.95, 1, .95]);
  const halfway = deckTransforms(.5, 3);
  const scale = .95 + .05 * (1 - Math.cos(Math.PI / 4));
  assertEquals(halfway.map((p) => p.translate), [-.5, .5, 1.5]);
  for (const page of halfway.slice(0, 2)) {
    assertEquals(page.progress, .5);
    assertAlmostEquals(page.scale, scale);
  }
  assertEquals(halfway[2].scale, .95);
  const scales = [0, .25, .5, .75, 1].map((idx) => deckTransforms(idx, 2)[1].scale);
  assertEquals(
    scales.every((scale, i) => i === 0 || scale > scales[i - 1]),
    true,
  );
});

Deno.test("deck: edge rubber-band is symmetric, monotone and bounded", () => {
  let previous = 0;
  for (const pull of [.1, .5, 1, 2, 10, 1000]) {
    const first = deckTransforms(-pull, 3)[0];
    const last = deckTransforms(2 + pull, 3)[2];
    assertAlmostEquals(first.translate, -last.translate);
    assertEquals(first.translate >= previous && first.translate <= 1 / 3, true);
    assertEquals(first.scale >= .95 && first.scale <= 1, true);
    previous = first.translate;
  }
  assertEquals(deckTransforms(0, 0), []);
  assertThrows(() => deckTransforms(NaN, 2), RangeError);
  assertThrows(() => deckTransforms(0, -1), RangeError);
  assertThrows(() => deckTransforms(0, 1.5), RangeError);
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

// Raw imports keep this source audit usable with plain deno test (no read
// permission). Include new src/ and demo/ TS files in this source list.
Deno.test("classes: every assigned shell class has a stylesheet selector", () => {
  const sources = [
    ["src/cookbook.ts", source0],
    ["src/deck-data.ts", source1],
    ["src/deck.ts", source2],
    ["src/dom.ts", source3],
    ["src/drawer.ts", source4],
    ["src/flip.ts", source5],
    ["src/header.ts", source6],
    ["src/model.ts", source7],
    ["src/motion.ts", source8],
    ["src/panels.ts", source9],
    ["src/route.ts", source10],
    ["src/shell.ts", source11],
    ["src/status.ts", source12],
    ["src/styles.ts", source13],
    ["src/tutorial.ts", source14],
    ["src/types.ts", source15],
    ["src/view.ts", source16],
    ["demo/placeholder-app.ts", source17],
    ["demo/routes/index.root.ts", source18],
  ];
  const intentional: Record<string, string> = {
    "ck-stat": "Grouping hook for ck-stat-value and ck-stat-label; uses block flow.",
    "ck-queue": "Mount-slot hook; the containing ck-panel-body supplies layout.",
    "ck-details-slot": "Mount-slot hook; the containing ck-panel-body supplies layout.",
    "ph-title": "Demo-local heading recipe installed by PlaceholderApp.mount.",
    "ph-stage": "Demo-local stage recipe installed by PlaceholderApp.mount.",
    "ph-detail": "Demo-local details recipe installed by PlaceholderApp.mount.",
    "ph-facts": "Demo-local facts recipe installed by PlaceholderApp.mount.",
    "ph-label": "Demo text-update and settleIn hook; inherits the stage typography.",
  };
  const selectors = new Set([...cookbookCss.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]));
  const missing: string[] = [];
  const assigned = new Set<string>();
  for (const [file, raw] of sources) {
    const source = raw.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
    const add = (value: string) => {
      for (const token of value.trim().split(/\s+/)) {
        if (!token) continue;
        assigned.add(token);
        if (!selectors.has(token) && !intentional[token]) missing.push(`${file}: ${token}`);
      }
    };
    // All current class assignment forms: h's second argument, className,
    // class object properties and classList state changes.
    for (const match of source.matchAll(
      /\bh\(\s*["'][^"']+["']\s*,\s*((?:"[^"]*"|'[^']*'|[^,"')])*)[,)]|\.className\s*=\s*([^;]+)|\bclass(?:Name)?\s*:\s*([^,}]+)|\.classList\.(?:add|remove|toggle|replace)\(([^)]*)\)/g,
    )) {
      const expression = match.slice(1).find((part) => part !== undefined)!;
      for (const literal of expression.matchAll(/(["'])(.*?)\1/g)) {
        // "icon" in slide.eyebrow tests the slide variant; it is not a class.
        if (/^\s*in\b/.test(expression.slice(literal.index! + literal[0].length))) continue;
        add(literal[2]);
      }
    }
    // Remove interpolation before scanning HTML attributes, so quotes in an
    // expression such as classes.name ?? "" cannot end the attribute early.
    for (const match of source.replace(/\$\{[^}]*\}/g, "").matchAll(/\bclass=(["'])(.*?)\1/g)) add(match[2]);
    // The deck passes a conditional emphasis class through this variable.
    for (const match of source.matchAll(/const tone\s*=\s*([^;]+);/g)) {
      for (const literal of match[1].matchAll(/(["'])(.*?)\1/g)) add(literal[2]);
    }
  }
  for (const [key, value] of Object.entries(cookbookClasses)) {
    if (key !== "cardNameAttribute") assertEquals(selectors.has(value), true, value);
  }
  assertEquals(assigned.size > 60, true, "the audit must include templates and h calls");
  assertEquals(missing, [], "assigned classes need CSS or a documented nonvisual/demo hook");
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

Deno.test("deck: Hacks endpoint pulls are symmetric and bounded at 22 percent / 95 percent scale", () => {
  assertEquals(deckPull(0, 6), { offset: 0, scale: 1 });
  assertEquals(deckPull(2.5, 6), { offset: 0, scale: 1 });
  for (const amount of [.01, .2, 1, 10, 100]) {
    const first = deckPull(-amount, 6), last = deckPull(5 + amount, 6);
    assertAlmostEquals(first.offset, -last.offset);
    assertAlmostEquals(first.scale, last.scale);
    assertEquals(first.offset > 0 && first.offset <= .22, true);
    assertEquals(first.scale >= .95 && first.scale < 1, true);
  }
});
