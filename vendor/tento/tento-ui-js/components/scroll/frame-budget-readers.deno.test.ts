import "../../deno-noop.ts";

import { assert } from "jsr:@std/assert";
import { FrameBudget } from "../../frame-budget.ts";
import { ScrollHorizontal } from "./scroll-horizontal.ts";

Deno.test("frame budget readers: the trim-follows-script lever is gone from the frame budget and the scroll element", () => {
  // Measured in W71/W75/W76 and not adopted (judge r18 N1): removed with its lona row, so neither side reads it.
  for (const [owner, member] of [
    [FrameBudget, "TRIM_FOLLOWS_SCRIPT"],
    [FrameBudget, "trimFollowsScript"],
    [FrameBudget.prototype, "noteFlushEnd"],
    [ScrollHorizontal, "frameTrimFollowsScript"],
  ] as const) assert(!Reflect.has(owner, member), `${member} is still there`);
});
