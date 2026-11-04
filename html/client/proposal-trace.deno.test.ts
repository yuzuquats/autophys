/** The step records that led to a proposal become its reasoning trace, whichever record comes first. */
import { assertEquals } from "jsr:@std/assert@1";
import { mapInvestigation, type WireRecord } from "./wire.ts";

const config = { simulator: { name: "sim", outputs: ["y"] }, params: { a: { lo: 1, hi: 2, initial: 1.5 } }, catalog: { pulse: { settings: { amp: 1 } } },
  noise: { sigma: { y: 0.1 } }, budgets: { max_steps: 9, max_simulations: 9, max_experiments: 2 }, policy: { kind: "scripted" } };
let seq = 0;
const rec = (kind: string, payload: Record<string, unknown>): WireRecord => ({ id: `r${++seq}`, investigation: "inv", seq, kind, ts: 1_700_000_000 + seq, payload });
const head = () => rec("investigation", { project_id: "prj", config_version: "v1", host: "laptop" });
const step = (action: string, extra: Record<string, unknown> = {}) =>
  rec("step", { decision: { action, hypothesis: `${action} because`, evidence: action === "propose_experiment" ? ["e1", "e2"] : [], expected_information: action === "propose_experiment" ? "a to 1%" : "", arguments: {} }, ...extra });
const proposal = (id: string) => rec("proposal", { proposal_id: id, event: "proposed", experiment: "pulse", settings: { amp: 1 }, score: 3 });

Deno.test("trace: the steps since the last proposal attach to the next one, proposal record first or second", () => {
  const records = [head(), step("inspect_data"), step("optimize_parameters"), proposal("p1"), step("propose_experiment"),
    step("rank_experiments"), rec("step", { error: "bad json" }), step("propose_experiment"), proposal("p2")];
  const inv = mapInvestigation(records, [{ version: "v1", config }])!.inv;
  const [p1, p2] = inv.proposals;
  assertEquals(p1.trace!.map((t) => [t.n, t.action]), [[1, "inspect_data"], [2, "optimize_parameters"], [3, "propose_experiment"]]);
  assertEquals([p1.trace!.at(-1)!.evidence, p1.trace!.at(-1)!.expected], [["e1", "e2"], "a to 1%"]);
  assertEquals(p2.trace!.map((t) => [t.n, t.action, t.error ?? ""]), [[4, "rank_experiments", ""], [5, "unusable decision", "bad json"], [6, "propose_experiment", ""]]);
});

Deno.test("trace: a proposal with no step records has no trace", () => {
  const inv = mapInvestigation([head(), proposal("p1")], [{ version: "v1", config }])!.inv;
  assertEquals(inv.proposals[0].trace, undefined);
});
