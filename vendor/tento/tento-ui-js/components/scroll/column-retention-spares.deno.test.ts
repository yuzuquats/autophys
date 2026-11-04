import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { DomFlags } from "../../dom-flags.ts";
import { ScrollHorizontal } from "./scroll-horizontal.ts";

/**
 * The retention pool's size is a tunable (dom-perf 35): every parked spare
 * keeps its column's shadow roots in the document, and each style update
 * that has active style to update walks them (p34: 2.3 ms per update with 19
 * parked spares, 0.9 ms with them removed). `scroll-column-retention-spares`
 * sets K; absent or malformed, K stays 20 (112 before dom-perf 49's flip). Retention off answers 0 whatever K.
 */
function withFlags(armed: { retention?: boolean; spares?: number }, body: () => void): void {
  DomFlags.armForHarness(ScrollHorizontal.COLUMN_RETENTION, armed.retention ?? null);
  DomFlags.armForHarness(ScrollHorizontal.COLUMN_RETENTION_SPARES_FLAG, armed.spares ?? null);
  try {
    body();
  } finally {
    DomFlags.armForHarness(ScrollHorizontal.COLUMN_RETENTION, null);
    DomFlags.armForHarness(ScrollHorizontal.COLUMN_RETENTION_SPARES_FLAG, null);
  }
}

Deno.test("retention spares: the pool keeps the armed number of spares", () => {
  withFlags({ retention: true, spares: 20 }, () => assertEquals(ScrollHorizontal.columnRetention(), 20));
  withFlags({ retention: true, spares: 0 }, () => assertEquals(ScrollHorizontal.columnRetention(), 0, "0 = the LIFO pool"));
});

Deno.test("retention spares: without a size the pool keeps 20 (dom-perf 49); retention off keeps none", () => {
  withFlags({ retention: true }, () => assertEquals(ScrollHorizontal.columnRetention(), 20));
  withFlags({ retention: false, spares: 20 }, () => assertEquals(ScrollHorizontal.columnRetention(), 0));
});

Deno.test("retention spares: a page value is a whole number of spares or the fallback", () => {
  assertEquals(DomFlags.parseCount("112", 20), 112);
  assertEquals(DomFlags.parseCount(" 7 ", 20), 7);
  for (const raw of [null, "", "true", "-3", "2.5", "1e9x"]) assertEquals(DomFlags.parseCount(raw, 20), 20, String(raw));
});
