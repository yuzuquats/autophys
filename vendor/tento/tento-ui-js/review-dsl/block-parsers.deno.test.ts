import { assert, assertEquals } from "jsr:@std/assert";

import {
  CalloutParser,
  CompareParser,
  StepsParser,
  TableParser,
} from "./block-parsers.ts";

Deno.test("callout: kind aliases, title, body lines", () => {
  const r = CalloutParser.parse(
    "caution unwrap on the hot path",
    "line one\n\nline two",
  );
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.kind, "risk");
    assertEquals(r.value.title, "unwrap on the hot path");
    assertEquals(r.value.body, ["line one", "", "line two"]);
  }
  const bare = CalloutParser.parse("", "just a note");
  assert(bare.ok);
  if (bare.ok) assertEquals(bare.value.kind, "note");
  const bad = CalloutParser.parse("sparkle", "x");
  assert(!bad.ok);
});

Deno.test("compare: section markers with labels, either order", () => {
  const r = CompareParser.parse(
    "== before: LonaApi\nfetchRows(cb)\n== after: RowClient\nawait rows.list()",
  );
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.before.label, "LonaApi");
    assertEquals(r.value.before.text, "fetchRows(cb)");
    assertEquals(r.value.after.text, "await rows.list()");
  }
  const flipped = CompareParser.parse("== after\nnew\n== before\nold");
  assert(flipped.ok);
  if (flipped.ok) assertEquals(flipped.value.before.text, "old");
});

Deno.test("compare: --- divider shorthand; neither form errors", () => {
  const r = CompareParser.parse("a: 1\n---\na: 2");
  assert(r.ok);
  if (r.ok) assertEquals(r.value.after.text, "a: 2");
  assert(!CompareParser.parse("no markers here").ok);
});

Deno.test("table: header, separator ignored, chosen row star", () => {
  const r = TableParser.parse(
    "| option | size | verdict |\n|---|---|---|\n| tags | small | lossy |\n| * fences | small | chosen |",
  );
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.header.length, 3);
    assertEquals(r.value.rows.length, 2);
    assertEquals(r.value.rows[1].chosen, true);
    assertEquals(r.value.rows[1].cells[0], "fences");
  }
});

Deno.test("steps: numbered prefixes stripped, path anchors detected", () => {
  const r = StepsParser.parse(
    "1. tento-ui-js/review-dsl/dsl.ts — shared Result shape\n2. start at the fence dispatch\n- components/review-notes/review-fence.ts:12 | the entry point",
  );
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.steps[0].anchor, "tento-ui-js/review-dsl/dsl.ts");
    assertEquals(r.value.steps[0].body, "shared Result shape");
    assertEquals(r.value.steps[1].anchor, null);
    assertEquals(
      r.value.steps[2].anchor,
      "components/review-notes/review-fence.ts:12",
    );
  }
});
