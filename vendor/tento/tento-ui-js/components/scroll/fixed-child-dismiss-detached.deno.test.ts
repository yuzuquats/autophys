import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { ScrollHorizontal } from "./scroll-horizontal.ts";
import { ScrollEngine } from "@tento-scroll/engine/scroll-engine.ts";
import type { Scrollable } from "@tento-scroll/engine/scrollable.ts";

class Scroller implements Scrollable {
  contentOffset = 0;
  delegate: Option<Scrollable.Delegate> = null;
  scrollTo(offset: number): void { this.contentOffset = offset; }
  adjustContentOffset(delta: number): void { this.contentOffset += delta; }
}

/** A fixed child under a parent; records whether it was attached at each `state` write. */
function child(): { $c: HTMLElement; writes: string[] } {
  const writes: string[] = [];
  const attributes = new Map<string, string>();
  const $c: HTMLElement = Object.create(HTMLElement.prototype);
  let $parent: Option<{ removeChild(node: unknown): void }> = {
    removeChild: (node) => {
      if (node === $c) $parent = null;
    },
  };
  Object.defineProperties($c, {
    parentElement: { get: () => $parent },
    setAttribute: {
      value: (name: string, value: string) => {
        if (name === "state") writes.push(`${value}:${$parent != null ? "attached" : "detached"}`);
        attributes.set(name, value);
      },
    },
    getAttribute: { value: (name: string) => attributes.get(name) ?? null },
  });
  return { $c, writes };
}

function host(): ScrollHorizontal<HTMLElement, HTMLElement> {
  const $h: ScrollHorizontal<HTMLElement, HTMLElement> = Object.create(ScrollHorizontal.prototype);
  Object.assign($h, { fixedChildBindings: new WeakMap(), _pendingFixedChildAppends: new Set() });
  const $e: HTMLElement = Object.create(HTMLElement.prototype);
  $h._scrollEngine = new ScrollEngine(new Scroller(), {
    onCreate: () => ({ $header: $e, $body: $e }),
    onBind: () => {}, onRecycle: () => {},
  });
  return $h;
}

Deno.test("fixed child dismiss: without the fade the child is detached before its state is written", () => {
  const { $c, writes } = child();
  host().dismissFixedChildElement($c, false, false);
  assertEquals(writes, ["dismissed:detached"], "a state write on an attached node is a style invalidation");
  assertEquals($c.parentElement, null);
});
