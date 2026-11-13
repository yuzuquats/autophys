import { assert, assertEquals } from "jsr:@std/assert@1";
import { investigationSummary } from "./investigation-summary.ts";
import { buildWorkspace } from "../fixtures/fixtures.ts";
import type { Investigation, Project } from "../domain.ts";

const ws = buildWorkspace();
const project = ws.projects[0], source = project.investigations[1];
const summarize = (change: Partial<Investigation> = {}) => {
  const inv = { ...source, ...change };
  return investigationSummary({ ...project, investigations: [inv] }, inv);
};

Deno.test("document investigation links point to recorded outputs and distinguish completion", () => {
  const result = summarize();
  assertEquals(result.status, "Complete · validated");
  assertEquals(result.tone, "ok");
  assert(result.outputs.some(o => o.id === source.id + "/validate"));
  assert(result.outputs.some(o => o.id === source.id + "/fit-" + source.fits.at(-1)!.n));
  for (const measurement of source.measurements) assert(result.outputs.some(o => o.id === source.id + "/data/" + measurement.id));
  const pending = project.investigations[0];
  const partial = investigationSummary(project, pending);
  assertEquals(partial.status, "Awaiting approval");
  assert(!partial.outputs.some(o => o.label === "Validation result"));
});

Deno.test("a failed held-out check never gets a validated card", () => {
  assert(source.validation.state === "passed" || source.validation.state === "failed");
  const result = summarize({ validation: { ...source.validation, state: "failed", chi2N: 4 } });
  assertEquals(result.status, "Complete · failed validation");
  assertEquals(result.tone, "warn");
  assert(result.check.startsWith("Prediction check failed"));
  assert(result.evidence.includes("4.00") && result.evidence.includes("failed"));
});

Deno.test("missing diagnosis and missing validation remain explicit", () => {
  const result = summarize({ fits: source.fits.map(f => ({ ...f, sensitivity: null, identification: null })), validation: { state: "needs-data" } });
  assertEquals(result.finding, "Parameter identification not recorded.");
  assertEquals(result.status, "Complete · validation not recorded");
  assertEquals(result.evidence, "Held-out validation not recorded.");
  assertEquals(result.check, "Prediction check not yet recorded.");
  assertEquals(summarize({ fits: [] }).finding, "No converged fit recorded.");
});

Deno.test("a check for an older fit is labelled and cannot validate the latest parameters", () => {
  assert(source.validation.state === "passed" || source.validation.state === "failed");
  const result = summarize({ validation: { ...source.validation, fit: -1 } });
  assertEquals(result.status, "Complete · validation out of date");
  assertEquals(result.tone, "warn");
  assert(result.evidence.includes("Fit #-1"));
  assertEquals(result.check, "Prediction check belongs to an earlier model.");
});

Deno.test("completed unresolved work preserves its diagnosis", () => {
  const pending = project.investigations[0];
  const inv = { ...pending, state: "inconclusive" as const };
  const result = investigationSummary({ ...project, investigations: [inv] }, inv);
  assertEquals(result.status, "Complete · unresolved");
  assert(result.finding.includes("unresolved"));
  assertEquals(result.tone, "warn");
});

Deno.test("technical parameter values keep unresolved estimates explicit", () => {
  const pending = project.investigations[0];
  const result = investigationSummary(project, pending);
  for (const name of pending.fits.at(-1)!.sensitivity!.nonIdentified) {
    assertEquals(result.parameters.find(p => p.label === name)?.value, "Unresolved");
  }
  assertEquals(summarize({ fits: [] }).parameters, []);
});

Deno.test("small parameter values keep their significant digits in the technical details", () => {
  const name = source.free[0];
  const result = summarize({ fits: source.fits.map(f => ({ ...f, params: { ...f.params, [name]: 0.0249439438 } })) });
  assert(result.parameters.find(p => p.label === name)?.value.startsWith("0.024944"));
});
