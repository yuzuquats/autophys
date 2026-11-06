import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { detailsMarkup } from "./details.ts";
import type { ExperimentDetailsModel } from "./details-experiment.ts";

Deno.test("lifecycle renderer: all states share a card, independent rows and an anchored Report action", () => {
  for (const state of ["pending", "approved", "rejected", "running", "validated", "inconclusive", "awaiting-data", "awaiting-agent"] as const) {
    const model: ExperimentDetailsModel = {
      icon: "investigation", cardName: true, title: "bench <A>", status: { text: state + " <details>" },
      experiment: { key: "record", caption: "record", header: {
        investigation: { label: "bench A", id: "bench-a" }, project: "Bench <oscillators>",
        sourceFit: { label: "Fit #2", id: "bench-a/fit-2" }, state,
      }, notice: "Refused <write>" },
      sections: [
        { heading: "Result", blocks: [{ kind: "text", text: "Recorded result" }] },
        { heading: "Run", blocks: [{ kind: "text", text: "Recorded configuration" }] },
      ], actions: [{ name: "report", label: "Report" }],
    };
    const html = detailsMarkup(model, {}, { Result: false });
    assertStringIncludes(html, 'class="ap-experiment-card"');
    assertStringIncludes(html, 'aria-label="Investigation location"');
    assertStringIncludes(html, "bench &lt;A&gt;");
    assertStringIncludes(html, "Bench &lt;oscillators&gt;");
    assertStringIncludes(html, 'data-state="' + state + '"');
    assertStringIncludes(html, 'data-ap-experiment-row="Result">');
    assertStringIncludes(html, 'data-ap-experiment-row="Run">');
    assertStringIncludes(html, 'data-ap-id="bench-a/fit-2"');
    const footer = html.slice(html.indexOf("<footer"));
    assertStringIncludes(footer, 'data-ap-name="report"');
    assertStringIncludes(footer, 'role="alert"');
    assertStringIncludes(footer, "Refused &lt;write&gt;");
    assert(!footer.includes("<details"));
    assertEquals((html.match(/id="ap-status"/g) ?? []).length, 1);
  }
});
