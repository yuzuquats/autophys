import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { experimentDetailsMarkup, type ExperimentDetailsModel } from "./details-experiment.ts";

const base: ExperimentDetailsModel = {
  icon: "proposal", cardName: true, title: "Sine <force>", status: { text: "Awaiting approval · invalid settings" },
  experiment: { key: "p1", caption: "legacy identity", header: {
    investigation: { label: "bench <A>", id: 'bench-"a' }, proposal: "Proposal p1",
    sourceFit: { label: "Fit #1", id: "bench-a/fit-1" }, state: "pending",
  } }, sections: [{ heading: "Experiment", blocks: [] }],
  decision: [{ name: "approve", label: "Approve" }, { name: "reject", label: "Reject" }],
};
Deno.test("review header: identity precedes title; ranking links to a separate record", () => {
  const html = experimentDetailsMarkup(base, {}, {});
  assert(html.indexOf('aria-label="Proposal location"') < html.indexOf('<h3'));
  assertStringIncludes(html, 'data-ap-id="bench-&quot;a"');
  assertStringIncludes(html, 'aria-current="page">Proposal p1');
  assertStringIncludes(html, "bench &lt;A&gt;");
  assertStringIncludes(html, "Sine &lt;force&gt;");
  const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
  assert(!nav.includes("Fit #1"));
  assertStringIncludes(html, 'data-ap-id="bench-a/fit-1"');
  assertStringIncludes(html, 'aria-label="Awaiting approval · invalid settings"');
  assertStringIncludes(html, '<input type="button" class="ap-review-status"');
  assertStringIncludes(html, 'popovertarget="ap-review-status-popover"');
  assertStringIncludes(html, 'id="ap-review-status-popover" popover');
  assertStringIncludes(html, 'id="ap-status" role="status">Awaiting approval · invalid settings');
  assertEquals((html.match(/id="ap-status"/g) ?? []).length, 1);
});
Deno.test("review header: a missing source fit is text; decided status keeps its full receipt", () => {
  for (const state of ["approved", "rejected"] as const) {
    const status = `${state} by A. <Chen> · 2026-11-05 · edited`;
    const html = experimentDetailsMarkup({ ...base, status: { text: status }, decision: undefined,
      experiment: { ...base.experiment, header: { ...base.experiment.header!, state, sourceFit: { label: "Fit #9" } }, notice: "Refused <write>" } }, {}, { Experiment: false });
    assertStringIncludes(html, `data-state="${state}"`);
    assertStringIncludes(html, 'Ranked at <span>Fit #9</span>');
    const footer = html.slice(html.indexOf("<footer"));
    assertStringIncludes(footer, `${state} by A. &lt;Chen&gt; · 2026-11-05 · edited`);
    assertStringIncludes(footer, 'role="alert"');
    assertStringIncludes(footer, "Refused &lt;write&gt;");
    assert(!footer.includes("<details"));
  }
});
Deno.test("review header: legacy presentation retains caption and status", () => {
  const html = experimentDetailsMarkup({ ...base, experiment: { key: "legacy", caption: "Legacy <record>" } }, {}, {});
  assertStringIncludes(html, "Legacy &lt;record&gt;");
  assertStringIncludes(html, 'id="ap-status" role="status">Awaiting approval · invalid settings');
});
