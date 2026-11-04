/**
 * One calendar hour height. Every calendar surface lays its day out at the
 * same height per hour: the day column and its hour grid, the legend's hour
 * labels, grid lines and cursor, the indicator line, the weekly schedule,
 * the drag gesture's time resolution, the days strip's current-time line, a
 * span cell's height and offset, and a partial day's hour-line inset.
 * Each reads `PIXELS_PER_HOUR` (tento-ui-js calendar, the lower layer) rather
 * than repeating 48, so the surfaces cannot drift apart.
 *
 * No visual change: each site, with the constant's value substituted, renders
 * exactly the text it had as a literal, and the value stays 48.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { PIXELS_PER_HOUR } from "./calendar-hour.ts";

const TENTO = new URL("../../../", import.meta.url);
const UI = "tento-ui-js/components/calendar/";
const STRIP = "tento-lona-js/sheets-ui/src/plugins/layout/timeline-column/components/calendar-days-strip-current-time.ts";

/** Each hour-height site and the text it renders (the literal it replaced). */
const SITES: readonly { readonly file: string; readonly renders: string; readonly count?: number }[] = [
  { file: STRIP, renders: "transform: `translateY(calc(48px * ${offset.toHrsF}))`," },
  { file: `${UI}calendar-column.ts`, renders: "const positioning = windowed.getPositioning(48);" },
  { file: `${UI}calendar-legend.ts`, renders: "transform: `translateY(${MathUtils.roundToDecimals(hr * 48) + 2}px)`," },
  { file: `${UI}calendar-legend.ts`, renders: "height: 48px;" },
  { file: `${UI}calendar-legend.ts`, renders: "background-size: 100% 48px;" },
  { file: `${UI}weekly-schedule.ts`, renders: 'this.$("legend").style.height = 48 * 24 + "px";' },
  { file: `${UI}weekly-schedule.ts`, renders: "height: calc(48px * 24 - 1px);" },
  { file: `${UI}weekly-schedule.ts`, renders: "--std-calendar-column-layout-width: 48px;" },
  { file: `${UI}calendar-indicator-line.ts`, renders: "top: calc(48px * var(--p-start-time-hrs));" },
  { file: `${UI}calendar-gesture.ts`, renders: "const offset = position.resolve(info.windowed, 48);" },
  { file: `${UI}calendar-gesture.ts`, renders: "const currentOffset = position.resolve(info.windowed, 48);", count: 3 },
  { file: `${UI}calendar-column-cell-light.ts`, renders: "48px * var(--p-duration-mins) / 60 +" },
  { file: `${UI}calendar-column-cell-light.ts`, renders: "48px *" },
  { file: `${UI}calendar-column.ts`, renders: "top: 48px;" },
  { file: `${UI}calendar-column.ts`, renders: "bottom: 48px;" },
];

/** A source line as it renders: the constant (bare, or interpolated into a template) replaced by its value. */
function rendered(line: string): string {
  return line.trim().replaceAll("${PIXELS_PER_HOUR}", String(PIXELS_PER_HOUR)).replaceAll("PIXELS_PER_HOUR", String(PIXELS_PER_HOUR));
}

Deno.test("calendar hour height: one value, 48 px per hour", () => {
  assertEquals(PIXELS_PER_HOUR, 48, "changing it moves every calendar surface: a visual change");
});

Deno.test("calendar hour height: every site reads PIXELS_PER_HOUR and renders what its literal did", () => {
  const problems: string[] = [];
  for (const site of SITES) {
    const lines = Deno.readTextFileSync(new URL(site.file, TENTO)).split("\n");
    const reading = lines.filter((line) => line.includes("PIXELS_PER_HOUR") && rendered(line) === site.renders).length;
    const literal = lines.filter((line) => line.trim() === site.renders).length;
    if (reading !== (site.count ?? 1)) problems.push(`${site.file}: ${reading} line(s) read the constant and render ${site.renders}`);
    if (literal > 0) problems.push(`${site.file}: ${literal} literal copy(ies) of ${site.renders}`);
  }
  assertEquals(problems, []);
});

Deno.test("calendar hour height: no other module defines an hour height", () => {
  const skeleton = Deno.readTextFileSync(new URL(
    "tento-lona-js/sheets-ui/src/plugins/layout/timeline-column/components/calendar-column-skeleton.ts",
    TENTO,
  ));
  assert(!/PIXELS_PER_HOUR\s*=/.test(skeleton), "timeline-column imports the calendar's constant");
});
