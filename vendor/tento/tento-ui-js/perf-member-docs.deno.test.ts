import { assertEquals } from "jsr:@std/assert";

/**
 * The DOM layer's modules document what their members do, not which lane, window or review round added or measured them:
 * that history is in the lona-dom project docs (perf-policy-history.md). A doc that names a dom-perf lane, a perf window,
 * a DOM lane or a judge round reads as a changelog (judge r15 N9, r18 N3, r19 N4).
 *
 * The scan covers every non-test source file of the DOM layer: the ui-js root modules (frame budget, frame marks, idle
 * lane, DOM flags), the scroll, sheet, calendar and event-details components, the scroll engine package and the sheet UI
 * package's sources.
 */
const ROOTS: { dir: string; recursive: boolean }[] = [
  { dir: "./", recursive: false },
  { dir: "./components/scroll/", recursive: true },
  { dir: "./components/sheet/", recursive: true },
  { dir: "./components/calendar/", recursive: true },
  { dir: "./components/event-details/", recursive: true },
  { dir: "../tento-scroll-js/", recursive: true },
  { dir: "../tento-lona-js/sheets-ui/src/", recursive: true },
];
const LANE = /\bdom-perf \d+|\bW\d{2,3}\b|\bDOM \d+\b|\bjudge r\d+|\bp\d{2}:/;

function sources(dir: URL, recursive: boolean): URL[] {
  const found: URL[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isDirectory) {
      if (recursive && entry.name !== "tests" && entry.name !== "node_modules") {
        found.push(...sources(new URL(`${entry.name}/`, dir), recursive));
      }
    } else if (entry.isFile && entry.name.endsWith(".ts") && !/\.test\.ts$|\.bench\.ts$/.test(entry.name)) {
      found.push(new URL(entry.name, dir));
    }
  }
  return found;
}

Deno.test("perf member docs: the DOM layer's sources name no lane, window or review round", () => {
  const root = new URL("../", import.meta.url).pathname;
  const files = ROOTS.flatMap(({ dir, recursive }) => sources(new URL(dir, import.meta.url), recursive));
  const named: string[] = [];
  for (const file of files) {
    Deno.readTextFileSync(file).split("\n").forEach((line, index) => {
      if (LANE.test(line)) named.push(`${file.pathname.slice(root.length)}:${index + 1}: ${line.trim()}`);
    });
  }
  assertEquals(named, []);
});

Deno.test("perf member docs: the scan reads the modules that carried lane history", () => {
  const files = ROOTS.flatMap(({ dir, recursive }) => sources(new URL(dir, import.meta.url), recursive))
    .map((file) => file.pathname);
  for (
    const module of [
      "tento-ui-js/frame-budget.ts",
      "tento-ui-js/idle-lane.ts",
      "tento-ui-js/components/scroll/scroll-horizontal.ts",
      "tento-scroll-js/engine/scroll-engine.ts",
      "tento-lona-js/sheets-ui/src/sheet/fixed-children-queue.ts",
      "tento-lona-js/sheets-ui/src/sheet/sheet-element.ts",
      "tento-lona-js/sheets-ui/src/plugins/layout/timeline-column/components/calendar-strip-work.ts",
      "tento-lona-js/sheets-ui/src/plugins/layout/timeline-column/components/calendar-days-strip-paint.ts",
    ]
  ) {
    assertEquals(files.some((file) => file.endsWith(`/${module}`)), true, module);
  }
});
