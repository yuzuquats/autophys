import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { initialSelection } from "../controller.ts";
import { fixtures, replay } from "../fixtures/source.ts";
import { detailsModel } from "./details.ts";
import type { ExperimentHeader } from "../../ui/view-model.ts";

const src = fixtures(), snap = await src.load(), workspace = replay(snap.workspace, src.log);
Deno.test("approval identity: states and exact source fit derive from records", () => {
  for (const status of ["proposed", "approved", "rejected"] as const) {
    const ws = structuredClone(workspace), inv = ws.projects[0].investigations[0], p = inv.proposals[0];
    p.status = status; p.decidedBy = "A. Chen"; p.decidedAt = "2026-11-05";
    const s = { ...initialSelection(ws), ws, projectId: ws.projects[0].id, selected: { [ws.projects[0].id]: `${inv.id}/prop/${p.id}` } };
    for (const missing of [false, true]) {
      if (missing) inv.fits = [];
      const model = detailsModel(s) as ReturnType<typeof detailsModel> & { experiment: { header: ExperimentHeader } };
      assertEquals(model.experiment.header.investigation.id, inv.id);
      assertEquals(model.experiment.header.proposal, `Proposal ${p.id}`);
      assertEquals(model.experiment.header.state, status === "proposed" ? "pending" : status);
      assertEquals(model.experiment.header.sourceFit.id, missing ? undefined : `${inv.id}/fit-${p.atFit}`);
      assertStringIncludes(model.experiment.header.sourceFit.label, String(p.atFit));
      if (status !== "proposed") assert(model.status.text.includes("A. Chen") && model.status.text.includes("2026-11-05"));
    }
  }
});
