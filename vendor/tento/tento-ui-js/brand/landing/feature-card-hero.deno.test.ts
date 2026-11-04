import "../../../tento-lona-js/sheets-ui/src/plugins/renderer/_dom-test-shim.ts";
import { assert, assertEquals } from "jsr:@std/assert";

import { FeatureCardHero } from "./feature-card-hero.ts";

const QUICK_ADD_SIZE: Size = { width: 520, height: 280 };
const QUICK_ADD_ITEM: FeatureCardHero.Item = {
  id: "quick-add",
  nativeSize: QUICK_ADD_SIZE,
  layout: "contain-center",
  tile: "adaptive-center-bottom-right",
  render: () => {
    throw new Error("frame math test does not render content");
  },
};

function placementFor(stage: Size): FeatureCardHero.Placement {
  return FeatureCardHero.frameFor(
    QUICK_ADD_ITEM,
    QUICK_ADD_SIZE,
    0,
    1,
    stage,
    1,
    "desktop",
  );
}

Deno.test("adaptive quick-add tile centers in a roomy slot", () => {
  const { frame, trace } = placementFor({ width: 620, height: 360 });

  assertEquals(trace.chosen, "anchor");
  assertEquals(trace.clean, true);
  assertEquals(trace.anchor, "adaptive-center-bottom-right");
  assert(trace.overhang.right < 0, "right edge stays inside");
  assert(trace.overhang.bottom < 0, "bottom edge stays inside");
  assert(frame.top > FeatureCardHero.safeAreaFor({ width: 620, height: 360 }).top);
});

Deno.test("adaptive quick-add tile bleeds bottom/right when the slot is short", () => {
  const stage = { width: 420, height: 150 };
  const safe = FeatureCardHero.safeAreaFor(stage);
  const { frame, trace } = placementFor(stage);

  assertEquals(trace.chosen, "anchor");
  assertEquals(trace.clean, true);
  assertEquals(frame.left, safe.left);
  assertEquals(frame.top, safe.top);
  assert(
    trace.overhang.right >= safe.left,
    `right bleed ${trace.overhang.right}px should commit past inset ${safe.left}px`,
  );
  assert(
    trace.overhang.bottom >= safe.left,
    `bottom bleed ${trace.overhang.bottom}px should commit past inset ${safe.left}px`,
  );
});

Deno.test("adaptive quick-add tile stays centered in a narrow tall slot", () => {
  const { frame, trace } = placementFor({ width: 260, height: 360 });

  assertEquals(trace.chosen, "anchor");
  assertEquals(trace.clean, true);
  assert(trace.overhang.right < 0, "right edge stays inside");
  assert(trace.overhang.bottom < 0, "bottom edge stays inside");
  assert(frame.top > FeatureCardHero.safeAreaFor({ width: 260, height: 360 }).top);
});

Deno.test("adaptive quick-add tile avoids flush edges in very small slots", () => {
  const stage = { width: 80, height: 24 };
  const safe = FeatureCardHero.safeAreaFor(stage);
  const { trace } = placementFor(stage);

  assertEquals(trace.chosen, "anchor");
  assertEquals(trace.clean, true);
  assert(
    trace.overhang.right >= safe.left,
    `right bleed ${trace.overhang.right}px should commit past inset ${safe.left}px`,
  );
  assert(
    trace.overhang.bottom >= safe.left,
    `bottom bleed ${trace.overhang.bottom}px should commit past inset ${safe.left}px`,
  );
});
