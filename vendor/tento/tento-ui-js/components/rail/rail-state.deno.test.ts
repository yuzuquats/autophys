import { assertEquals } from "jsr:@std/assert";

import { Fixtures } from "../../../tento-core-js/tests/fixture-runner.deno.ts";
import { RailState } from "./rail-state.ts";

type Input =
  | { fn: "keys"; prefix: string }
  | { fn: "restoreWidth"; raw: Option<string>; bounds: RailState.Bounds }
  | { fn: "dragWidth"; startPx: number; deltaPx: number; bounds: RailState.Bounds }
  | { fn: "resolvedWidthPx"; state: RailState.State; width: RailState.Width };

Fixtures.load<Input, UntypedJson>(
  new URL(".", import.meta.url).pathname,
  "rail-state",
).run(
  (input) => {
    switch (input.fn) {
      case "keys":
        return RailState.keys(input.prefix);
      case "restoreWidth":
        return RailState.restoreWidth(input.raw, input.bounds);
      case "dragWidth":
        return RailState.dragWidth(input.startPx, input.deltaPx, input.bounds);
      case "resolvedWidthPx":
        return RailState.resolvedWidthPx(input.state, input.width);
    }
  },
  (result, expected) => assertEquals(result, expected),
);
