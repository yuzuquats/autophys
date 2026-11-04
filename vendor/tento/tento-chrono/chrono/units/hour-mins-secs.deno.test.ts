import { assertEquals } from "jsr:@std/assert";
import { Hms } from "./hour-mins-secs.ts";

// The boundaries are the whole test. A decomposition is only ever wrong at an
// exact multiple, which is also the only place a person checks it by hand.

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

Deno.test("Hms.fromMs - exact units do not fall through to zero", () => {
  // `3_600_000 * (1/3_600_000)` is 0.9999999999999999, so the reciprocal form
  // of this function reported one hour as {0, 0, 0} — the whole duration gone.
  assertEquals(Hms.fromMs(HOUR), { hrs: 1, mins: 0, secs: 0 });
  assertEquals(Hms.fromMs(MIN), { hrs: 0, mins: 1, secs: 0 });
  assertEquals(Hms.fromMs(SEC), { hrs: 0, mins: 0, secs: 1 });
  assertEquals(Hms.fromMs(24 * HOUR), { hrs: 24, mins: 0, secs: 0 });
});

Deno.test("Hms.fromMs - a mixed duration keeps each field in range", () => {
  assertEquals(Hms.fromMs(2 * HOUR + 5 * MIN + 44 * SEC), {
    hrs: 2,
    mins: 5,
    secs: 44,
  });
  assertEquals(Hms.fromMs(HOUR - 1), { hrs: 0, mins: 59, secs: 59 });
});

Deno.test("Hms.fromMs - zero and sub-second", () => {
  assertEquals(Hms.fromMs(0), { hrs: 0, mins: 0, secs: 0 });
  assertEquals(Hms.fromMs(999), { hrs: 0, mins: 0, secs: 0 });
});

Deno.test("Hms.fromMs round-trips through toMs", () => {
  for (const ms of [0, SEC, MIN, HOUR, 3 * HOUR + 17 * MIN + 8 * SEC]) {
    assertEquals(Hms.toMs(Hms.fromMs(ms)), ms);
  }
});
