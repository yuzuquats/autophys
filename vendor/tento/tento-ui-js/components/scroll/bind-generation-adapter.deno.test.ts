import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { ScrollHorizontal } from "./scroll-horizontal.ts";
import { BindGeneration, ScrollEngine } from "@tento-scroll/engine/scroll-engine.ts";
import type { Scrollable } from "@tento-scroll/engine/scrollable.ts";

class Scroller implements Scrollable {
  contentOffset = 0;
  delegate: Option<Scrollable.Delegate> = null;
  scrollTo(offset: number): void { this.contentOffset = offset; }
  adjustContentOffset(delta: number): void { this.contentOffset += delta; }
}

Deno.test("bind-generation adapter: current installation holds debt and obsolete commits cannot release it", () => {
  // This surface uses no DOM or JS-private host fields. Exercise the actual
  // host forwarding/reset methods and actual engine barrier without hydration.
  const host: ScrollHorizontal<HTMLElement, HTMLElement> = Object.create(ScrollHorizontal.prototype);
  host["headerSweepEpoch"] = 0;
  host["prevHeaderViolations"] = new Set(["old-strike"]);
  host["headerSweepTrailingTimer"] = null;
  const observations: string[] = [];
  host["scheduleHeaderInvariantSweep"] = (context) => { observations.push(context); };
  const third = BindGeneration.of(3), fourth = BindGeneration.of(4);
  host.beginBindGeneration(third);
  host.commitBindGeneration(third);
  const child: HTMLElement = Object.create(HTMLElement.prototype);
  host._scrollEngine = new ScrollEngine(new Scroller(), {
    onCreate: () => ({ $header: child, $body: child }),
    onBind: () => {}, onRecycle: () => {},
  });
  host.beginBindGeneration(third);
  assertEquals(host.scrollEngine.currentBindGeneration, third);
  assertEquals(host.scrollEngine.hasPendingBinds, true);
  assertEquals(host["prevHeaderViolations"].size, 0);
  assertEquals(observations, ["generation-changed"]);
  host["prevHeaderViolations"].add("current-strike");
  host.beginBindGeneration(fourth);
  assertEquals(host["prevHeaderViolations"].size, 0);
  assertEquals(host.scrollEngine.currentBindGeneration, fourth);
  host["prevHeaderViolations"].add("successor-strike");
  host.beginBindGeneration(third);
  host.commitBindGeneration(third);
  assertEquals(host.scrollEngine.hasPendingBinds, true);
  assertEquals([...host["prevHeaderViolations"]], ["successor-strike"]);
  assertEquals(observations, ["generation-changed", "generation-changed"]);
  host.commitBindGeneration(fourth);
  assertEquals(host.scrollEngine.hasPendingBinds, false);
  assertEquals(host.scrollEngine.currentBindGeneration, fourth);
});
