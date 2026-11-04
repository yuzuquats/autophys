import { assertEquals } from "jsr:@std/assert";

import { LayoutShiftDetector } from "./layout-shift-detector.ts";

function elementNode(tag: string, id: string): LayoutShiftDetector.NodeInfo {
  return { tagName: tag, id: id.length > 0 ? id : null, nodeName: tag };
}

function textNode(): LayoutShiftDetector.NodeInfo {
  return { tagName: null, id: null, nodeName: "#text" };
}

const RECT: LayoutShiftDetector.Rect = { x: 0, y: 0, width: 0, height: 0 };

function shift(
  value: number,
  hadRecentInput: boolean,
  sources: readonly LayoutShiftDetector.Attribution[],
): LayoutShiftDetector.Entry {
  return { value, hadRecentInput, sources };
}

Deno.test("describeNode formats element id, nodeName fallback, and unknown", () => {
  assertEquals(
    LayoutShiftDetector.describeNode(elementNode("DIV", "sidebar")),
    "div#sidebar",
  );
  // Element with no id falls back to its (uppercase) nodeName.
  assertEquals(
    LayoutShiftDetector.describeNode(elementNode("SECTION", "")),
    "SECTION",
  );
  assertEquals(LayoutShiftDetector.describeNode(textNode()), "#text");
  assertEquals(
    LayoutShiftDetector.describeNode({
      tagName: null,
      id: null,
      nodeName: null,
    }),
    "?",
  );
});

Deno.test("describeRect rounds coordinates to `x,y WxH`", () => {
  assertEquals(
    LayoutShiftDetector.describeRect({
      x: 12.4,
      y: 7.6,
      width: 100.2,
      height: 49.9,
    }),
    "12,8 100x50",
  );
});

Deno.test("ingest accumulates CLS and emits described sources", () => {
  const detector = new LayoutShiftDetector({ onShift: () => {} });

  const first = detector.ingest(
    shift(0.1, false, [
      {
        node: elementNode("DIV", "sheet"),
        previousRect: RECT,
        currentRect: { x: 0, y: 20, width: 300, height: 40 },
      },
    ]),
  );
  assertEquals(first?.value, 0.1);
  assertEquals(first?.cumulative, 0.1);
  assertEquals(first?.sources, [
    { node: "div#sheet", from: "0,0 0x0", to: "0,20 300x40" },
  ]);

  const second = detector.ingest(shift(0.25, false, []));
  assertEquals(second?.cumulative, 0.35);
  assertEquals(detector.cumulativeLayoutShift, 0.35);
});

Deno.test("ingest excludes shifts that followed recent input", () => {
  const detector = new LayoutShiftDetector({ onShift: () => {} });
  assertEquals(detector.ingest(shift(0.5, true, [])), null);
  assertEquals(detector.cumulativeLayoutShift, 0);
});

Deno.test("ingest caps attributed sources at maxSources", () => {
  const detector = new LayoutShiftDetector({ onShift: () => {}, maxSources: 2 });
  const sources: LayoutShiftDetector.Attribution[] = Array.from(
    { length: 5 },
    (_v, i) => ({
      node: elementNode("SPAN", `s${i}`),
      previousRect: RECT,
      currentRect: RECT,
    }),
  );
  const record = detector.ingest(shift(0.01, false, sources));
  assertEquals(record?.sources.length, 2);
  assertEquals(record?.sources.map((s) => s.node), ["span#s0", "span#s1"]);
});
