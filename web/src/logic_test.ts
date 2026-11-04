import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { readRoute, routeUrl } from "./route.ts";
import {
  arrowStage,
  closePanel,
  findItem,
  initialPanels,
  items,
  Stepper,
  togglePanel,
  visiblePanels,
} from "./model.ts";
import { clampSlide, dragOffset, slides, swipeTarget } from "./deck-data.ts";
import { describeHealth, parseHealth, readHealth } from "./health.ts";
import { invert } from "./flip.ts";

Deno.test("routes: landing and app paths round-trip", () => {
  assertEquals(readRoute("/"), { app: false });
  assertEquals(readRoute("/elsewhere"), { app: false });
  assertEquals(readRoute("/app"), { app: true, item: null });
  assertEquals(readRoute("/app/"), { app: true, item: null });
  assertEquals(readRoute("/app/untitled-2"), { app: true, item: "untitled-2" });
  assertEquals(readRoute("/app/a/b"), { app: false });
  assertEquals(readRoute("/app/%E0%A4%A"), { app: true, item: null });
  assertEquals(routeUrl({ app: false }), "/");
  assertEquals(routeUrl({ app: true, item: null }), "/app");
  assertEquals(routeUrl({ app: true, item: "a b" }), "/app/a%20b");
  assertEquals(readRoute(routeUrl({ app: true, item: "a b" })), { app: true, item: "a b" });
});

Deno.test("items: unknown ids fall back to the first", () => {
  assertEquals(findItem("untitled-3").title, "Untitled 3");
  assertEquals(findItem("nope"), items[0]);
  assertEquals(findItem(null), items[0]);
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

Deno.test("tutorial stepper advances to the last step, then reports done", () => {
  const stepper = new Stepper(["a", "b", "c"]);
  assertEquals([stepper.step, stepper.last], ["a", false]);
  assertEquals(stepper.advance(), true);
  assertEquals(stepper.advance(), true);
  assertEquals([stepper.step, stepper.last], ["c", true]);
  assertEquals(stepper.advance(), false);
  stepper.restart();
  assertEquals(stepper.index, 0);
  assertThrows(() => new Stepper([]));
});

Deno.test("deck: clamping, swipes and edge resistance", () => {
  assertEquals(slides.length, 6);
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

Deno.test("deck: placeholder copy stays inside the template's budget", () => {
  for (const slide of slides) {
    if (slide.title.length > 60) throw new Error(`title too long: ${slide.title}`);
    if (slide.description.length > 120) throw new Error(`description too long: ${slide.description}`);
  }
});

Deno.test("health: parse, describe and fetch", async () => {
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
  const okFetch =
    (() => Promise.resolve(Response.json({ ok: true, version: "0.1.0", commit: "dev" }))) as typeof fetch;
  assertEquals(await readHealth(okFetch), { tone: "ok", text: "Server ok · 0.1.0 · dev" });
  const failing = (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
  assertEquals((await readHealth(failing)).text, "Server unreachable");
  const notFound = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
  assertEquals((await readHealth(notFound)).tone, "down");
});

Deno.test("flip: move translates only; box also scales; no-ops are null", () => {
  const a = { left: 0, top: 0, width: 100, height: 50 };
  const b = { left: 40, top: 10, width: 200, height: 50 };
  assertEquals(invert(a, b, "move"), "translate(-40px, -10px) scale(1, 1)");
  assertEquals(invert(a, b, "box"), "translate(-40px, -10px) scale(0.5, 1)");
  assertEquals(invert(a, a, "box"), null);
  assertEquals(invert({ ...a, width: 0 }, b, "move"), null);
});
