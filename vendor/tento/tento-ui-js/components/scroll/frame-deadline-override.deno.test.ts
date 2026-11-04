import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { DomFlags } from "../../dom-flags.ts";
import { ScrollHorizontal } from "./scroll-horizontal.ts";

/**
 * The content deadline per motion frame is FRAME_DEADLINE_MS (6) unless a
 * whole number is stored for `scroll-frame-deadline-ms`: the perf windows
 * sweep 6, 8 and 10 ms on one bundle and read the value back from the page
 * (`frameDeadlineMs`). With the deadline off there is no deadline whatever
 * the number.
 */
function withFlags(armed: { deadline?: boolean; ms?: number }, body: () => void): void {
  DomFlags.armForHarness(ScrollHorizontal.FRAME_DEADLINE, armed.deadline ?? null);
  DomFlags.armForHarness(ScrollHorizontal.FRAME_DEADLINE_MS_FLAG, armed.ms ?? null);
  try {
    body();
  } finally {
    DomFlags.armForHarness(ScrollHorizontal.FRAME_DEADLINE, null);
    DomFlags.armForHarness(ScrollHorizontal.FRAME_DEADLINE_MS_FLAG, null);
  }
}

Deno.test("frame deadline: without a number the content deadline is FRAME_DEADLINE_MS", () => {
  withFlags({ deadline: true }, () => assertEquals(ScrollHorizontal.frameDeadlineMs(), ScrollHorizontal.FRAME_DEADLINE_MS));
  assertEquals(ScrollHorizontal.FRAME_DEADLINE_MS, 6);
});

Deno.test("frame deadline: a stored number of milliseconds is the content deadline", () => {
  withFlags({ deadline: true, ms: 8 }, () => assertEquals(ScrollHorizontal.frameDeadlineMs(), 8));
  withFlags({ deadline: true, ms: 10 }, () => assertEquals(ScrollHorizontal.frameDeadlineMs(), 10));
});

Deno.test("frame deadline: off means no deadline, whatever the number", () => {
  withFlags({ deadline: false, ms: 8 }, () => assertEquals(ScrollHorizontal.frameDeadlineMs(), null));
});
