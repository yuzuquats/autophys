import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { pageScrollbarEnabled, thumbGeometry } from "./page-scrollbar.ts";

Deno.test("the page scrollbar mounts only on Lona's hosted sites", () => {
  assert(pageScrollbarEnabled("autophys.lona.so"));
  assert(pageScrollbarEnabled("dev--autophys.lona.so"));
  assert(pageScrollbarEnabled("DEV--autophys.lona.so."));
  for (const host of ["localhost", "127.0.0.1", "x.dev--autophys.lona.so", "autophys.lona.so.evil.example", ""]) {
    assertFalse(pageScrollbarEnabled(host), host);
  }
});

Deno.test("the thumb is sized by the visible fraction and placed by scroll progress", () => {
  assertEquals(thumbGeometry(800, 800, 4000, 0), { length: 160, offset: 0 });
  assertEquals(thumbGeometry(800, 800, 4000, 3200), { length: 160, offset: 640 });
  assertEquals(thumbGeometry(800, 800, 4000, 1600), { length: 160, offset: 320 });
  assertEquals(thumbGeometry(800, 800, 100000, 0)?.length, 32); // never thinner than the minimum
  assertEquals(thumbGeometry(800, 800, 4000, 9999)?.offset, 640); // overscroll clamps
  assertEquals(thumbGeometry(800, 800, 800, 0), null); // nothing to scroll
});
