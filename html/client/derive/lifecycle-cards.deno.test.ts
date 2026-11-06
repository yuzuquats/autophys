import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { initialSelection } from "../controller.ts";
import { fixtures, replay } from "../fixtures/source.ts";
import { detailsModel } from "./details.ts";
import type { ExperimentHeader } from "../../ui/view-model.ts";
const isExperimentDetails = (model: ReturnType<typeof detailsModel>): model is ReturnType<typeof detailsModel> & { experiment: { header?: ExperimentHeader; notice?: string } } => "experiment" in model;

const source = fixtures(), snapshot = await source.load(), workspace = replay(snapshot.workspace, source.log);
const select = (ws: typeof workspace, projectId: string, id: string) => ({
  ...initialSelection(ws), ws, projectId, selected: { [projectId]: id },
});

Deno.test("lifecycle derivation: investigation states share card metadata and Report", () => {
  for (const state of ["running", "validated", "inconclusive", "awaiting-agent"] as const) {
    const ws = structuredClone(workspace), project = ws.projects[0], inv = project.investigations[0];
    inv.state = state; inv.progress = state === "running" ? { done: 2, total: 5 } : null;
    if (state.startsWith("awaiting-")) inv.proposals = [];
    const model = detailsModel(select(ws, project.id, inv.id));
    assert(isExperimentDetails(model), state);
    assertEquals(model.experiment.header?.state, state);
    assertEquals(model.decision, undefined, "investigation status does not create a proposal decision");
    assertEquals(model.actions?.map(a => a.name), ["report"]);

  }
});

Deno.test("lifecycle cards: running progress takes precedence over an older proposal on investigation anchors", () => {
  const ws = structuredClone(workspace), project = ws.projects[0], inv = project.investigations[0];
  inv.state = "running"; inv.progress = { done: 3, total: 8 };
  for (const id of [inv.id, inv.id + "/fit-1", inv.id + "/data"]) {
    const model = detailsModel(select(ws, project.id, id));
    assert(isExperimentDetails(model));
    assertEquals(model.experiment.header?.state, "running");
    assertStringIncludes(JSON.stringify(model.sections), "3 / 8");
    assertEquals(model.decision, undefined);
  }
  // An explicit proposal still opens its own review record and its existing actions.
  const p = inv.proposals[0];
  const proposal = detailsModel(select(ws, project.id, inv.id + "/prop/" + p.id));
  assert(isExperimentDetails(proposal));
  assertEquals(proposal.experiment.header?.state, "pending");
  assertEquals(proposal.decision?.map(a => a.name), ["approve", "reject"]);
  inv.progress = null;
  assertStringIncludes(detailsModel(select(ws, project.id, inv.id)).status.text, "Running");
});

Deno.test("lifecycle cards: validation retains check scope and recorded scientific facts", () => {
  const ws = structuredClone(workspace), project = ws.projects[0], inv = project.investigations[1];
  assert(inv.validation.state === "passed" || inv.validation.state === "failed");
  const v = inv.validation;
  const model = detailsModel(select(ws, project.id, inv.id));
  assert(isExperimentDetails(model));
  assertEquals(model.experiment.header?.state, "validated");
  const check = model.sections.find(s => s.heading === "Validation")!;
  assertStringIncludes(check.caption!, "listed data");
  const facts = JSON.stringify(check);
  for (const text of [v.measurement, "Fit #" + v.fit, v.worst.param, "2σ relative", "Acceptance threshold", "χ²/N"]) assertStringIncludes(facts, text);
  assert(model.sections.some(s => s.heading === "Result"));
  assert(model.sections.some(s => s.heading === "Budget used"));
  inv.validation = { state: "summary", passed: false, chi2N: 3.5, threshold: 2, measurements: ["held-out@1"] };
  const summary = detailsModel(select(ws, project.id, inv.id)).sections.find(s => s.heading === "Validation")!;
  for (const text of ["Failed", "3.50", "held-out@1", "Not recorded"]) assertStringIncludes(JSON.stringify(summary), text);
});

Deno.test("lifecycle derivation: refused writes stay with card metadata; configuration stays separate", () => {
  const ws = structuredClone(workspace), project = ws.projects[0], inv = project.investigations[1];
  const state = select(ws, project.id, inv.id);
  const model = detailsModel({ ...state, notice: "Refused <write>" });
  assert(isExperimentDetails(model));
  assertEquals(model.experiment.notice, "Refused <write>");
  const config = detailsModel(select(ws, project.id, "config:" + project.id));
  assert(!isExperimentDetails(config));
});
