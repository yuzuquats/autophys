/**
 * A calendar column's hour-line period (`--std-calendar-column-layout-width`,
 * the `background-size` of its hour grid) is one hour row. The column and its
 * layout declare it from `PIXELS_PER_HOUR`, the one hour height every
 * calendar surface reads (calendar-hour.deno.test.ts), not as a second `48px`.
 *
 * Under Deno `css` yields nothing, so the declarations are read as data from
 * the components' own sheets (`CalendarColumn.SHADOW_CSS`,
 * `CalendarColumnLayout.HOST_CSS`). The sources are read as text too: a
 * literal `48px` renders the same value, so only the source tells a copy from
 * a read of the constant.
 */
import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { CalendarColumn } from "./calendar-column.ts";
import { CalendarColumnLayout } from "./calendar-column-layout.ts";
import { PIXELS_PER_HOUR } from "./calendar-hour.ts";

const NAME = "--std-calendar-column-layout-width";

/** Every value `sheet` declares for `name`. */
function declared(sheet: string, name: string): string[] {
  return [...sheet.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());
}

Deno.test("calendar column: the hour-line period is one hour row in the column and its layout", () => {
  assertEquals(declared(CalendarColumn.SHADOW_CSS, NAME), [`${PIXELS_PER_HOUR}px`], "CalendarColumn");
  assertEquals(declared(CalendarColumnLayout.HOST_CSS, NAME), [`${PIXELS_PER_HOUR}px`], "CalendarColumnLayout");
});

Deno.test("calendar column: the hour-line period reads PIXELS_PER_HOUR, never a literal", () => {
  const problems: string[] = [];
  for (const file of ["calendar-column.ts", "calendar-column-layout.ts"]) {
    const text = Deno.readTextFileSync(new URL(`./${file}`, import.meta.url));
    for (const value of declared(text, NAME)) {
      if (value !== "${PIXELS_PER_HOUR}px") problems.push(`${file}: ${NAME}: ${value}`);
    }
  }
  assertEquals(problems, []);
});
