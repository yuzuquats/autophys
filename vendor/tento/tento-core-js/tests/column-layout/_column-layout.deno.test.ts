import { assertEquals } from "jsr:@std/assert";
import { Fixtures } from "../fixture-runner.deno.ts";
import { ColumnLayout } from "../../column-layout.ts";

const HOUR = 3600_000;

type EventDef = {
  id: string;
  startHrs?: number;
  startMins?: number;
  endHrs?: number;
  endMins?: number;
};

type Input = {
  events: EventDef[];
  expandThresholdMins?: number;
};

type ExpectedItem = {
  id?: string;
  columnIndex?: number;
  numColumns?: number;
  canExpand?: boolean;
};

function toInput(def: EventDef): ColumnLayout.Input {
  const startMs = def.startMins != null
    ? def.startMins * 60_000
    : (def.startHrs ?? 0) * HOUR;
  const endMs = def.endMins != null
    ? def.endMins * 60_000
    : (def.endHrs ?? 0) * HOUR;
  return { id: def.id, startMs, endMs };
}

Fixtures.load<Input, ExpectedItem[]>(
  new URL(".", import.meta.url).pathname,
  "column-layout",
).run(
  (input) => {
    const events = input.events.map(toInput);
    const thresholdMs = input.expandThresholdMins != null
      ? input.expandThresholdMins * 60_000
      : undefined;
    return ColumnLayout.compute(events, thresholdMs);
  },
  (result, expected) => {
    assertEquals(result.layouts.length, expected.length, "result count");
    for (let i = 0; i < expected.length; i++) {
      const exp = expected[i];
      const layout = result.layouts[i];
      const sorted = result.sorted[i];
      if (exp.id != null) {
        assertEquals(sorted.id, exp.id, `[${i}] id`);
      }
      if (exp.columnIndex != null) {
        assertEquals(layout.columnIndex, exp.columnIndex, `[${i}] columnIndex`);
      }
      if (exp.numColumns != null) {
        assertEquals(layout.numColumns, exp.numColumns, `[${i}] numColumns`);
      }
      if (exp.canExpand != null) {
        assertEquals(layout.canExpand, exp.canExpand, `[${i}] canExpand`);
      }
    }
  },
);
