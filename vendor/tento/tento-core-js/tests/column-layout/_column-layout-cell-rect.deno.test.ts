import { assertEquals } from "jsr:@std/assert";
import { Fixtures } from "../fixture-runner.deno.ts";
import { ColumnLayout } from "../../column-layout.ts";

type Input = {
  layout: ColumnLayout.Result;
  startTimeHrs: number;
  durationMins: number;
  containerWidthPx: number;
};

type Expected = {
  x: number;
  y: number;
  width: number;
  height: number;
  border: boolean;
};

Fixtures.load<Input, Expected>(
  new URL(".", import.meta.url).pathname,
  "column-layout-cell-rect",
).run(
  (input) =>
    ColumnLayout.cellRect(
      input.layout,
      input.startTimeHrs,
      input.durationMins,
      input.containerWidthPx,
    ),
  (result, expected) => {
    assertEquals(result.x, expected.x, "x");
    assertEquals(result.y, expected.y, "y");
    assertEquals(result.width, expected.width, "width");
    assertEquals(result.height, expected.height, "height");
    assertEquals(result.border, expected.border, "border");
  },
);
