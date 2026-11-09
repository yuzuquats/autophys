import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { mountPageScrollbar, thumbGeometry } from "./page-scrollbar.ts";

Deno.test("the page scrollbar mounts on every host: no host gate, mounted unconditionally at startup", async () => {
  assertEquals(mountPageScrollbar.length, 0); // takes no hostname
  const module = await Deno.readTextFile(new URL("./page-scrollbar.ts", import.meta.url));
  assertFalse(/hostname/.test(module), "page-scrollbar.ts checks a host");
  const root = await Deno.readTextFile(new URL("./index.root.ts", import.meta.url));
  assert(/^mountPageScrollbar\(\);/m.test(root), "index.root.ts does not mount the scrollbar at top level");
});

Deno.test("the thumb is sized by the visible fraction and placed by scroll progress", () => {
  assertEquals(thumbGeometry(800, 800, 4000, 0), { length: 160, offset: 0 });
  assertEquals(thumbGeometry(800, 800, 4000, 3200), { length: 160, offset: 640 });
  assertEquals(thumbGeometry(800, 800, 4000, 1600), { length: 160, offset: 320 });
  assertEquals(thumbGeometry(800, 800, 100000, 0)?.length, 32); // never thinner than the minimum
  assertEquals(thumbGeometry(800, 800, 4000, 9999)?.offset, 640); // overscroll clamps
  assertEquals(thumbGeometry(800, 800, 800, 0), null); // nothing to scroll
});
