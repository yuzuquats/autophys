import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { $$ } from "../../fastdom.ts";
import { initHtmlElement } from "../../init/html-element.global.ts";
import { ScrollHorizontal } from "./scroll-horizontal.ts";
import { ScrollEngine } from "@tento-scroll/engine/scroll-engine.ts";
import type { Scrollable } from "@tento-scroll/engine/scrollable.ts";

class Scroller implements Scrollable {
  contentOffset = 0;
  delegate: Option<Scrollable.Delegate> = null;
  scrollTo(offset: number): void { this.contentOffset = offset; }
  adjustContentOffset(delta: number): void { this.contentOffset += delta; }
}

Deno.test("layout-and-index adapter: supplied width survives a late equal-width ResizeObserver delivery", () => {
  // Hydration is the only constructor seam replaced: the actual constructor
  // installs private fields, listeners and the actual onSizeChange closure.
  const inflate = Object.getOwnPropertyDescriptor(ScrollHorizontal, "inflate");
  const mutate = $$.mutate;
  const raf = window.requestAnimationFrame;
  const writes: EmptyFunction[] = [], frames: FrameRequestCallback[] = [];
  const styles = new Map<string, string>();
  const shieldStyles = new Map<string, string>();
  const element: HTMLElement = Object.create(HTMLElement.prototype);
  const shield: HTMLElement = Object.create(HTMLElement.prototype);
  element.addEventListener = () => {};
  Object.defineProperty(element, "style", { value: { width: "" } });
  Object.defineProperty(shield, "style", { value: {
    setProperty: (name: string, value: string) => { shieldStyles.set(name, value); },
    getPropertyValue: (name: string) => shieldStyles.get(name) ?? "",
  } });
  Object.defineProperty(ScrollHorizontal, "inflate", { configurable: true,
    value: (_constructor: typeof ScrollHorizontal, instance: ScrollHorizontal<HTMLElement, HTMLElement>) => {
      Object.defineProperties(instance, {
        shadowRoot: { value: { querySelector: (selector: string) =>
          selector === "#wheel-shield" ? shield : element } },
        style: { value: {
          getPropertyValue: (name: string) => styles.get(name) ?? "",
          setProperty: (name: string, value: string) => { styles.set(name, value); },
          removeProperty: (name: string) => { const prior = styles.get(name) ?? ""; styles.delete(name); return prior; },
        } },
      });
    },
  });
  $$.mutate = (fn) => { writes.push(fn); return fn; };
  window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  try {
    initHtmlElement();
    const host = new ScrollHorizontal<HTMLElement, HTMLElement>();
    host._scrollEngine = new ScrollEngine(new Scroller(), {
      onCreate: () => ({ $header: element, $body: element }),
      onBind: () => {}, onRecycle: () => {},
    });
    const props: ScrollEngine.LayoutProps = {
      length: 1460, cellWidthPx: 1460 / 7, startOccludedPx: 120, endOccludedPx: 40,
    };
    assertEquals(host["size"], undefined);
    host.bindLayoutAt(props, ScrollEngine.IndexSpace.identity(), 0, "test-collection", false);
    while (writes.length) writes.shift()?.();
    assertEquals(element.style.width, "1300px");
    assertEquals(styles.has("--visible-width"), false);
    assertEquals(styles.get("--sidebar-width"), "120px");
    const installedViewport = host.scrollEngine.viewport;
    host.onSizeChange?.({ width: 1460, height: 700 });
    while (writes.length) writes.shift()?.();
    assertEquals(shieldStyles.get("--wheel-shield-width"), "1460px");
    assertEquals(shieldStyles.get("--wheel-shield-height"), "700px");
    assertEquals(styles.has("--wheel-shield-width"), false,
      "shield geometry must not be inherited through the host");
    assertEquals(styles.has("--wheel-shield-height"), false);
    assertEquals(host.scrollEngine.viewport, installedViewport);
    assertEquals(element.style.width, "1300px");
    assertEquals(styles.has("--visible-width"), false);
    for (let i = 0; i < 100 && frames.length; i++) frames.shift()?.(performance.now());
    assertEquals(frames.length, 0);
    assertEquals(host.scrollEngine.hasPendingBinds, false);
  } finally {
    $$.mutate = mutate;
    window.requestAnimationFrame = raf;
    if (inflate) Object.defineProperty(ScrollHorizontal, "inflate", inflate);
    else Reflect.deleteProperty(ScrollHorizontal, "inflate");
  }
});

Deno.test("layout-and-index adapter: hide and reveal set viewport opacity immediately without inherited style writes", () => {
  const inflate = Object.getOwnPropertyDescriptor(ScrollHorizontal, "inflate");
  const mutate = $$.mutate;
  const writes: EmptyFunction[] = [];
  const styles = new Map<string, string>([
    ["--content-viewport-visibility", "legacy-sentinel"],
    ["--visible-width", "1300px"],
  ]);
  const originalStyles = [...styles];
  const element: HTMLElement = Object.create(HTMLElement.prototype);
  element.addEventListener = () => {};
  Object.defineProperty(element, "style", { value: { opacity: "1", width: "1460px" } });
  Object.defineProperty(ScrollHorizontal, "inflate", { configurable: true,
    value: (_constructor: typeof ScrollHorizontal, instance: ScrollHorizontal<HTMLElement, HTMLElement>) => {
      Object.defineProperties(instance, {
        shadowRoot: { value: { querySelector: () => element } },
        style: { value: {
          getPropertyValue: (name: string) => styles.get(name) ?? "",
          setProperty: (name: string, value: string) => { styles.set(name, value); },
        } },
      });
    },
  });
  $$.mutate = (fn) => { writes.push(fn); return fn; };
  try {
    initHtmlElement();
    const host = new ScrollHorizontal<HTMLElement, HTMLElement>();
    for (const [force, animate, opacity] of [
      [false, true, "0"], [true, true, "1"],
      [null, false, "0"], [true, false, "1"],
    ] satisfies [Option<boolean>, boolean, string][]) {
      host.toggleContentVisibility(force, animate);
      assertEquals(element.style.opacity, opacity, "conceal/reveal is committed synchronously");
      assertEquals(element.style.width, "1460px");
      assertEquals([...styles], originalStyles, "host custom properties remain untouched");
      assertEquals(writes.length, 0, "no deferred opacity write can reveal a superseded owner later");
    }
  } finally {
    $$.mutate = mutate;
    if (inflate) Object.defineProperty(ScrollHorizontal, "inflate", inflate);
    else Reflect.deleteProperty(ScrollHorizontal, "inflate");
  }
});

Deno.test("layout-and-index adapter: a reentrant successor owns queued geometry styles and collection", () => {
  const inflate = Object.getOwnPropertyDescriptor(ScrollHorizontal, "inflate");
  const mutate = $$.mutate;
  const raf = window.requestAnimationFrame;
  const writes: EmptyFunction[] = [], frames: FrameRequestCallback[] = [];
  const styles = new Map<string, string>();
  const shieldStyles = new Map<string, string>();
  const element: HTMLElement = Object.create(HTMLElement.prototype);
  const shield: HTMLElement = Object.create(HTMLElement.prototype);
  element.addEventListener = () => {};
  Object.defineProperty(element, "style", { value: { width: "" } });
  Object.defineProperty(shield, "style", { value: {
    setProperty: (name: string, value: string) => { shieldStyles.set(name, value); },
    getPropertyValue: (name: string) => shieldStyles.get(name) ?? "",
  } });
  Object.defineProperty(ScrollHorizontal, "inflate", { configurable: true,
    value: (_constructor: typeof ScrollHorizontal, instance: ScrollHorizontal<HTMLElement, HTMLElement>) => {
      Object.defineProperties(instance, {
        shadowRoot: { value: { querySelector: (selector: string) =>
          selector === "#wheel-shield" ? shield : element } },
        style: { value: {
          getPropertyValue: (name: string) => styles.get(name) ?? "",
          setProperty: (name: string, value: string) => { styles.set(name, value); },
        } },
      });
    },
  });
  $$.mutate = (fn) => { writes.push(fn); return fn; };
  window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  try {
    initHtmlElement();
    const host = new ScrollHorizontal<HTMLElement, HTMLElement>();
    const successor: ScrollEngine.LayoutProps = {
      length: 940, cellWidthPx: 940 / 7, startOccludedPx: 180, endOccludedPx: 60,
    };
    const successorSpace = ScrollEngine.IndexSpace.identity();
    let reenter = true;
    host._scrollEngine = new ScrollEngine(new Scroller(), {
      onCreate: () => ({ $header: element, $body: element }),
      onBind: () => {}, onRecycle: () => {},
      options: { onRenderedIndiciesChanged: () => {
        if (!reenter) return;
        reenter = false;
        host.bindLayoutAt(successor, successorSpace, 41, "next-collection", false);
      } },
    });
    host.bindLayoutAt({
      length: 1460, cellWidthPx: 1460 / 3, startOccludedPx: 120, endOccludedPx: 40,
    }, ScrollEngine.IndexSpace.identity(), 0, "old-collection", false);
    assertEquals(writes.length, 2, "successor queues first; abandoned outer unwinds and queues last");
    while (writes.length) writes.shift()?.();
    assertEquals(host["layoutProps"], successor);
    assertEquals(host.scrollEngine.space, successorSpace);
    assertEquals(host.scrollEngine.viewport.props.length, 940);
    assertEquals(host.scrollEngine.viewport.visible.indexStartOptimistic, 41);
    assertEquals(host["collectionId"], "next");
    assertEquals(element.style.width, "700px");
    assertEquals(styles.has("--visible-width"), false);
    assertEquals(styles.get("--sidebar-width"), "180px");
    for (let i = 0; i < 100 && frames.length; i++) frames.shift()?.(performance.now());
    assertEquals(frames.length, 0);
    assertEquals(host.scrollEngine.hasPendingBinds, false);
    assertEquals(element.style.width, "700px");
    assertEquals(styles.has("--visible-width"), false);
    assertEquals(host["collectionId"], "next");
  } finally {
    $$.mutate = mutate;
    window.requestAnimationFrame = raf;
    if (inflate) Object.defineProperty(ScrollHorizontal, "inflate", inflate);
    else Reflect.deleteProperty(ScrollHorizontal, "inflate");
  }
});
