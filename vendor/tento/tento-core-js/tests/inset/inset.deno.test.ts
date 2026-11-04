import { assertEquals } from "jsr:@std/assert";

import { Inset } from "@tento-core/inset.ts";

Deno.test("Inset: constructors build expected edge values", () => {
  assertEquals(Inset.ZERO, { top: 0, right: 0, bottom: 0, left: 0 });
  assertEquals(Inset.all(4), { top: 4, right: 4, bottom: 4, left: 4 });
  assertEquals(Inset.top(3), { top: 3, right: 0, bottom: 0, left: 0 });
  assertEquals(Inset.right(3), { top: 0, right: 3, bottom: 0, left: 0 });
  assertEquals(Inset.bottom(3), { top: 0, right: 0, bottom: 3, left: 0 });
  assertEquals(Inset.left(3), { top: 0, right: 0, bottom: 0, left: 3 });
});

Deno.test("Inset: arithmetic combines edge-wise values", () => {
  assertEquals(
    Inset.add(
      { top: 1, right: 2, bottom: 3, left: 4 },
      { top: 4, right: 3, bottom: 2, left: 1 },
    ),
    { top: 5, right: 5, bottom: 5, left: 5 },
  );
  assertEquals(
    Inset.max(
      { top: 1, right: 6, bottom: 3, left: 8 },
      { top: 5, right: 2, bottom: 7, left: 4 },
    ),
    { top: 5, right: 6, bottom: 7, left: 8 },
  );
  assertEquals(
    Inset.ceil({ top: 1.2, right: 2, bottom: 3.8, left: 4.1 }),
    { top: 2, right: 2, bottom: 4, left: 5 },
  );
});

Deno.test("Inset: axis helpers sum opposite sides", () => {
  const inset = { top: 1, right: 2, bottom: 3, left: 4 };

  assertEquals(Inset.horizontal(inset), 6);
  assertEquals(Inset.vertical(inset), 4);
});
