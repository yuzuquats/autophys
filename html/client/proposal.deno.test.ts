/// <reference lib="deno.ns" />
/** The proposal state machine and the field parser. */
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Investigation, Proposal } from "./domain.ts";
import { applyDecision, awaiting, edited, expectedMeasurement, parseField, pendingDecisions, stateOf, transition } from "./proposal.ts";

const field = (name: string, value: number, lo: number, hi: number) => ({ name, label: name, unit: name === "amplitude" ? "N" : "Hz", value, original: value, lo, hi });
const base: Proposal = {
  id: "p1", experiment: "sine", atFit: 1, fields: [field("amplitude", 2, 0.1, 5), field("frequency", 0.44, 0.05, 5)], fixedSettings: {},
  status: "proposed", decidedBy: null, decidedAt: null, hypothesis: "", ranking: [], expected: [], dataFrom: "laptop",
  preview: { t: [], input: null, predicted: [] }, outlook: { axes: [], score: [], after: {} },
};
const inv = (p: Proposal, measurements: Investigation["measurements"] = []) =>
  ({ id: "bench-a", state: "awaiting-approval", measurements, proposals: [p] } as unknown as Investigation);

Deno.test("proposal: edit only while proposed, within limits", () => {
  const e = transition(base, { kind: "edit", name: "amplitude", value: 1.5 });
  assertEquals(e.fields[0].value, 1.5);
  assertEquals(edited(e).map((f) => f.name), ["amplitude"]);
  assert(transition(base, { kind: "edit", name: "amplitude", value: 9 }) === base, "out of range is refused");
  assert(transition(base, { kind: "edit", name: "nope", value: 1 }) === base);
  const approved = transition(e, { kind: "approve", by: "james", at: "10:46" });
  assert(transition(approved, { kind: "edit", name: "amplitude", value: 1 }) === approved, "an approved proposal is frozen");
});

Deno.test("proposal: approve, withdraw, reject, restore", () => {
  const a = transition(base, { kind: "approve", by: "james", at: "10:46" });
  assertEquals([a.status, a.decidedBy, a.decidedAt], ["approved", "james", "10:46"]);
  assert(transition(a, { kind: "reject", by: "james", at: "x" }) === a, "an approved proposal cannot be rejected; withdraw it first");
  const w = transition(a, { kind: "withdraw" });
  assertEquals([w.status, w.decidedBy], ["proposed", null]);
  const r = transition(w, { kind: "reject", by: "james", at: "10:47" });
  assertEquals(r.status, "rejected");
  assert(transition(r, { kind: "approve", by: "james", at: "x" }) === r);
  assertEquals(transition(r, { kind: "restore" }).status, "proposed");
  assert(transition(base, { kind: "withdraw" }) === base && transition(base, { kind: "restore" }) === base);
});

Deno.test("proposal: field text parses against the limits", () => {
  assertEquals(parseField(base.fields[0], " 1.5 "), { ok: true, value: 1.5 });
  assertEquals(parseField(base.fields[0], "1,000"), { ok: false, message: "0.1 to 5 N" });
  assertEquals(parseField(base.fields[0], "abc"), { ok: false, message: "Enter a number" });
  assertEquals(parseField(base.fields[0], ""), { ok: false, message: "Enter a number" });
});

Deno.test("proposal: pending count, awaiting data and the investigation state follow the decisions", () => {
  assertEquals([pendingDecisions(inv(base)), stateOf(inv(base))], [1, "awaiting-approval"]);
  const a = transition(base, { kind: "approve", by: "james", at: "10:46" });
  assertEquals([pendingDecisions(inv(a)), awaiting(inv(a)).length, stateOf(inv(a))], [0, 1, "awaiting-data"]);
  assertEquals(expectedMeasurement(inv(a), a), "sine_044@1");
  const r = transition(base, { kind: "reject", by: "james", at: "10:47" });
  assertEquals(stateOf(inv(r)), "awaiting-agent");
  const delivered = inv(a, [{ id: "sine_044@1", experiment: "sine", split: "train" } as Investigation["measurements"][number]]);
  assertEquals(awaiting(delivered).length, 0, "data that arrived is no longer awaited");
});

Deno.test("proposal: decision records apply only where the state allows (the daemon's 409)", () => {
  const e = applyDecision(base, { event: "edited", by: "james", at: "10:46", fields: { amplitude: 1.5 } })!;
  assertEquals([e.status, e.fields[0].value, e.fields[0].original], ["approved", 1.5, 2]);
  assertEquals(applyDecision(e, { event: "approved", by: "james", at: "x" }), null);
  assertEquals(applyDecision(e, { event: "unapproved" })!.status, "proposed");
  assertEquals(applyDecision(base, { event: "restored" }), null);
});
