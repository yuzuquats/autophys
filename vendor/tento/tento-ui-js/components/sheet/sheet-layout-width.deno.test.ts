import { assertEquals } from "jsr:@std/assert";

import { SheetLayoutWidth } from "./sheet-layout-width.ts";

Deno.test("SheetLayoutWidth.resolveCellWidth weak count respects preferred column width", () => {
  const semantic = SheetLayoutWidth.fromCount(3);
  const constraints: SheetLayoutWidth.Constraints = {
    weak: true,
    preferredWidthPx: 300,
    minWidthPx: 20,
  };

  assertEquals(
    SheetLayoutWidth.resolveCellWidth(1_000, semantic, constraints)?.semantic.dbg(),
    "3 count",
  );
  assertEquals(
    SheetLayoutWidth.resolveCellWidth(700, semantic, constraints)?.semantic.dbg(),
    "2 count",
  );
  assertEquals(
    SheetLayoutWidth.resolveCellWidth(290, semantic, constraints)?.semantic.dbg(),
    "1 count",
  );
});

Deno.test("SheetLayoutWidth.resolveCellWidth strict count uses minimum width", () => {
  const semantic = SheetLayoutWidth.fromCount(3);
  const constraints: SheetLayoutWidth.Constraints = {
    weak: false,
    preferredWidthPx: 300,
    minWidthPx: 120,
  };

  assertEquals(
    SheetLayoutWidth.resolveCellWidth(700, semantic, constraints)?.semantic.dbg(),
    "3 count",
  );
  assertEquals(
    SheetLayoutWidth.resolveCellWidth(230, semantic, constraints)?.semantic.dbg(),
    "1 count",
  );
});
