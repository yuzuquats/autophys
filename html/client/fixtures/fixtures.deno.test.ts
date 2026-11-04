/// <reference lib="deno.ns" />
/** The fixture is deterministic, and its numbers say what the mocks say they should. */
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { buildWorkspace, configHash, proposalOutlook } from "./fixtures.ts";
import { gaussian, mulberry32 } from "./sim.ts";
import { CANNED, fixtures, replay } from "./source.ts";

const ws = buildWorkspace();
const inv = (id: string) => ws.projects.flatMap((p) => p.investigations).find((i) => i.id === id)!;

Deno.test("fixtures: two builds are identical, down to every sample", () => {
  assertEquals(JSON.stringify(buildWorkspace()), JSON.stringify(ws));
  const a = gaussian(mulberry32(42)), b = gaussian(mulberry32(42));
  assertEquals([a(), a(), a()], [b(), b(), b()]);
  assertEquals(configHash({ a: 1 }), configHash({ a: 1 }));
  assert(configHash({ a: 1 }) !== configHash({ a: 2 }));
});

Deno.test("fixtures: the projects and investigations the operator chose", () => {
  assertEquals(ws.projects.map((p) => [p.name, p.investigations.map((i) => [i.name, i.state])]), [
    ["Bench oscillators", [["bench A", "awaiting-approval"], ["bench B", "validated"]]],
    ["Cell pulse tests", [["cell A", "running"]]],
    ["Lab heaters", [["heater 1", "validated"]]],
  ]);
  assertEquals(inv("cell-a").progress, { done: 12, total: 40 });
  assertEquals(ws.projects[0].configs.map((c) => c.version), [1, 2]);
  assertEquals([inv("bench-a").configVersion, inv("bench-b").configVersion], [2, 1]);
});

Deno.test("fixtures: a free response pins k/m and c/m but leaves the scale on a ridge", () => {
  const fit = inv("bench-a").fits[0], s = fit.sensitivity!;
  assertEquals(s.nonIdentified, ["m", "c", "k"]);
  assertEquals(s.kinds, ["identifiable", "identifiable", "structural"]);
  const [km, cm] = s.combos;
  assertEquals([km.name, cm.name], ["k/m", "c/m"]);
  assertAlmostEquals(km.value, 7.5, 0.05);
  assertAlmostEquals(cm.value, 0.4, 0.01);
  assert(fit.chi2N > 0.8 && fit.chi2N < 1.2, `χ²/N ${fit.chi2N}`);
  assertEquals(fit.basins, 1);
  assert(fit.trail.length > 2, "the fit moved");
  assertAlmostEquals(fit.trail[0].m, 1, 1e-9, "the trail starts at the declared initial guess");
  assertAlmostEquals(fit.trail[0].k, 9, 1e-9);
});

Deno.test("fixtures: the ranking after a free response matches page.html's order", () => {
  const p = inv("bench-a").proposals[0];
  assertEquals(p.ranking.map((r) => r.label), ["Sine 0.44 Hz", "Step 2 N", "Sine 0.1 Hz", "Impulse 5 N", "Sine 2 Hz", "Repeat free response"]);
  assert(p.ranking.at(-1)!.score < 1e-3 * p.ranking[0].score, "repeating the free response adds nothing");
  assert(p.expected.every((e) => e.after != null && e.after < 0.1), "the sine pins every parameter");
});

Deno.test("fixtures: a second experiment identifies everything; a missing bias leaves structure", () => {
  assertEquals(inv("bench-b").fits[1].sensitivity!.identified, ["m", "c", "k"]);
  const [noBias, withBias] = inv("heater-1").fits;
  assert(Object.values(noBias.lag1).every((r) => r > 0.3) && noBias.chi2N > 2, "without a bias the residuals are structured");
  assert(Object.values(withBias.lag1).every((r) => Math.abs(r) < 0.3) && withBias.chi2N < 1.3, "with it they are white");
  assertAlmostEquals(withBias.params.bias, 0.4, 0.02);
  for (const id of ["bench-b", "heater-1"]) assertEquals(inv(id).validation.state, "passed");
  assertEquals(inv("heater-1").measurements[1].output.filter((y) => !Number.isFinite(y)).length, 3);
});

Deno.test("fixtures: the running fit has no diagnosis yet; converged fits carry a landscape", () => {
  const running = inv("cell-a").fits[1];
  assertEquals([running.state, running.sensitivity, running.landscape], ["running", null, null]);
  for (const p of ws.projects) for (const i of p.investigations) for (const f of i.fits) {
    if (f.state === "converged") assertEquals(f.landscape!.chi2.length, (f.landscape!.xs.length - 1) * (f.landscape!.ys.length - 1));
  }
});

Deno.test("fixtures: the Source loads, replays its canned records, and refuses a decision the state forbids", async () => {
  const src = fixtures(), snap = await src.load();
  assertEquals([snap.source, snap.gseq], ["fixture", 0]);
  assertEquals(snap.workspace.projects[0].investigations[1].proposals[0].status, "proposed", "the snapshot is the base");
  const seen: number[] = [];
  const stop = src.stream(0, (r) => seen.push(r.gseq));
  await Promise.resolve();
  assertEquals(seen, CANNED.map((_, i) => i + 1));
  assertEquals(replay(snap.workspace, src.log).projects[0].investigations[1].proposals[0].status, "approved");
  const rec = await src.post("/investigations/bench-a/proposals/p1/approvals", { event: "rejected", by: "james", at: "10:47" });
  assertEquals([rec.gseq, rec.seq, rec.investigation, rec.payload.event], [2, 1, "bench-a", "rejected"]);
  await Promise.resolve();
  assertEquals(seen, [1, 2], "the live record streams too");
  let refused = "";
  await src.post("/investigations/bench-a/proposals/p1/approvals", { event: "approved", by: "james", at: "10:48" }).catch((e) => { refused = e.message; });
  assert(refused.startsWith("409"), "a rejected proposal cannot be approved");
  stop();
  const fit = snap.workspace.projects[0].investigations[0].fits[0], m = snap.workspace.projects[0].investigations[0].measurements[0];
  const r = m.output.map((y, k) => y - fit.curves[m.id].fit[k]);
  assertAlmostEquals(Math.sqrt(r.reduce((s, x) => s + x * x, 0) / r.length), 0.01, 0.002, "the uploaded curve is the fit");
});

Deno.test("fixtures: the outlook grid covers the proposal's own settings and agrees with its ranking", () => {
  const p = inv("bench-a").proposals[0], o = p.outlook;
  assertEquals(o.axes.map((a) => a.name), ["amplitude", "frequency", "duration"]);
  assertEquals(o.score.length, o.axes.reduce((n, a) => n * a.values.length, 1));
  const node = o.axes.map((a) => a.values.indexOf(p.fields.find((f) => f.name === a.name)!.value));
  assert(node.every((i) => i >= 0), "the proposed settings are grid nodes");
  const idx = (node[0] * o.axes[1].values.length + node[1]) * o.axes[2].values.length + node[2];
  const own = p.ranking.find((r) => r.proposal)!.score;
  assertAlmostEquals(o.score[idx], own, own * 1e-3, "A²-scaled information matches the direct evaluation");
  assertEquals(Object.keys(o.after), ["m", "c", "k"]);
});

Deno.test("fixtures: a smaller drive is a weaker experiment", () => {
  const p = ws.projects[0], i = p.investigations[0], base = i.proposals[0];
  const at = (a: number) => proposalOutlook(p.configs[1], i, { ...base, fields: base.fields.map((f) => (f.name === "amplitude" ? { ...f, value: a } : f)) });
  const [two, one] = [at(2), at(1)];
  assert(one.score < two.score, `${one.score} < ${two.score}`);
  assert(one.expected.every((e, k) => e.after! > two.expected[k].after!), "and leaves wider uncertainties");
});
