/// <reference lib="deno.ns" />
/**
 * daemon(): the /api/v1 source against a fake fetch and a fake EventSource. Load maps the
 * daemon's workspace onto the domain; the stream resumes from its last gseq after a drop;
 * a refused POST (409) becomes the details panel's "Not saved" notice; pairings are listed
 * and decided; connection failures stay visible.
 */
Deno.test("wire: optional curves map record ids and preserve downsampled times; reveal preserves evaluator results", async () => {
  const { WireModel } = await import("./wire.ts");
  const raw = workspace(), run = raw.records.find((r) => r.kind === "run")!;
  const ms = raw.records.filter((r) => r.kind === "measurement");
  const before = new WireModel(raw).workspace().projects[0].investigations[0];
  assertEquals(before.fits[0].curves, {});
  assertEquals(before.reveal, undefined);
  run.payload.curves = {
    [ms[0].id]: { t: [0, 1, 2], fit: { x: [.09, .01, 0], unused: [9] }, initial: { x: [.1, .02, .01] } },
    [ms[1].id]: { fit: { x: [.1, 0, .01] }, initial: { x: [.11, .01, .02] } },
    unknown: { fit: { x: [9] }, initial: { x: [9] } },
  };
  const reveal = { source: "synthetic", tolerance: .1, truth: { m: 1, k: 10 }, estimate: { m: 1.2, k: 10 },
    fit_id: 1, quantities: [
      { name: "m", truth: 1, estimate: 1.2, ratio: 1.2, sigma_ratio: .04, within: false, identifiable: true },
      { name: "k", truth: 10, estimate: 10, ratio: 1, sigma_ratio: null, within: true, identifiable: true },
    ] };
  raw.records.push(rec("reveal", reveal));
  const inv = new WireModel(raw).workspace().projects[0].investigations[0];
  assertEquals(inv.fits[0].curves, {
    "free_response@1": { t: [0, 1, 2], fit: [.09, .01, 0], initial: [.1, .02, .01] },
    "free_response@2": { fit: [.1, 0, .01], initial: [.11, .01, .02] },
  });
  assertEquals(inv.reveal, reveal);
});

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { ApiError, daemon, type Cursor, type DaemonOptions, type EventStream } from "./api.ts";
import { Controller } from "./controller.ts";
import { fixtures } from "./fixtures/source.ts";
import { Store } from "./store.ts";
import type { WireRecord, WireWorkspace } from "./wire.ts";

const settle = () => new Promise((r) => setTimeout(r, 0));

const CONFIG = {
  name: "bench",
  simulator: { name: "oscillator", source_hash: "abc123def", outputs: ["x"] },
  params: { m: { unit: "kg", lo: 0.1, hi: 10, initial: 1, fixed: false }, k: { unit: "N/m", lo: 1, hi: 100, initial: 10, fixed: false }, b: { unit: "m", lo: -1, hi: 1, initial: null, fixed: true } },
  catalog: { free_response: { settings: { x0: 0.1, duration: 2 }, max_runs: 1 }, sine: { settings: { amplitude: 1, frequency: 0.4, duration: 2 }, max_runs: null, edit: { amplitude: [0.5, 2], frequency: [0.1, 1] } } },
  noise: { sigma: { x: 0.01 }, estimate: false, bias: "off" },
  budgets: { max_steps: 24, max_simulations: 20000, max_experiments: 2 },
  stop: {}, policy: { kind: "scripted", effort: "low", max_tokens: 2400 }, n_starts: 4,
};
const OUTLOOK = { axes: [{ name: "amplitude", values: [0.5, 1, 2] }, { name: "frequency", values: [0.1, 0.4, 1] }], score: [1, 2, 3, 4, 5, 6, 7, 8, 9], after: { m: [0.5, 0.4, 0.3, 0.3, 0.2, 0.1, 0.2, 0.1, 0.05], k: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1] } };
const T0 = Date.UTC(2026, 10, 4, 10, 0) / 1000;
let seq = 0;
const rec = (kind: string, payload: Record<string, unknown>, inv = "inv_1"): WireRecord =>
  ({ id: `r${seq}`, investigation: inv, seq: seq, kind, ts: T0 + 60 * seq++, payload, prev_hash: "", hash: "" });

function workspace(): WireWorkspace {
  seq = 0;
  const records = [
    rec("investigation", { project_id: "p_bench", config_version: "v1hash", title: "bench A", seed: 7, overrides: { free: ["m", "k"] } }),
    rec("measurement", { observation: { experiment: "free_response", settings: { x0: 0.1, duration: 2 }, t: [0, 0.5, 1, 1.5, 2], y: { x: [0.1, 0.05, null, -0.02, 0.01] }, sigma: { x: 0.01 }, split: "train", source: "bench", meta: {} } }),
    rec("measurement", { observation: { experiment: "free_response", settings: { x0: 0.1, duration: 2 }, t: [0, 1, 2], y: { x: [0.1, 0, 0.01] }, sigma: { x: 0.01 }, split: "validation", source: "bench", meta: {} } }),
    rec("run", { fit_id: 1, model: "base", simulator: "oscillator", params: { m: 1.1, k: 9.5 }, loss: 3.2, chi2_per_n: 1.04, n: 5, nfev: 40, status: 1, message: "", success: true, loss_kind: "linear", at_bounds: [], starts: [{}, {}, {}], seed: 7 }),
    rec("step", { index: 1, fit_id: 1, decision: { action: "analyze_sensitivity" }, result: { condition_number: 1.5e7, identified: ["k"], non_identified: ["m"], non_identifiable: ["m·k"] }, simulations: 12 }),
    rec("step", { index: 2, fit_id: 1, decision: { action: "rank_experiments" }, result: { criterion: "min_eig", ranking: [["sine", 40, 900], ["free_response", 0, 10]] }, simulations: 30 }),
    rec("proposal", { proposal_id: "prop_1", event: "proposed", experiment: "sine", settings: { amplitude: 1, frequency: 0.4, duration: 2 }, rationale: "a sine pins m", criterion: "min_eig", score: 5, outlook: OUTLOOK }),
    rec("outcome", { status: "awaiting_data", validation: null, simulations: 42 }),
  ];
  return { cursor: records.length, projects: [{ id: "p_bench", name: "Bench" }], config_versions: [{ project_id: "p_bench", version: "v1hash", config: CONFIG }], records };
}

type Call = { url: string; init: RequestInit };
function fakeDaemon(answer: (c: Call) => Response | undefined = () => undefined) {
  const calls: Call[] = [], streams: { url: string; fire: Record<string, ((e: { data: string; lastEventId: string }) => void)[]>; closed: boolean }[] = [];
  const ws = workspace();
  const opts: DaemonOptions = {
    user: "james",
    newId: () => `ui-${calls.length}`,
    setTimer: (fn) => { queueMicrotask(fn); return 0; },
    clearTimer: () => {},
    fetch: (input, init) => {
      const c = { url: String(input), init: init ?? {} };
      calls.push(c);
      const own = answer(c);
      if (own) return Promise.resolve(own);
      if (c.url === "/api/v1/workspace") return Promise.resolve(Response.json(ws));
      if (c.url === "/api/v1/pairings") return Promise.resolve(Response.json({ pairings: [] }));
      return Promise.resolve(Response.json({ error: "not_found", message: "unknown route" }, { status: 404 }));
    },
    openStream: (url) => {
      const s = { url, fire: {} as Record<string, ((e: { data: string; lastEventId: string }) => void)[]>, closed: false };
      streams.push(s);
      return {
        addEventListener: (type: string, fn: (e: { data: string; lastEventId: string }) => void) => { (s.fire[type] ??= []).push(fn); },
        close: () => { s.closed = true; },
      } as EventStream;
    },
  };
  const emit = (gseq: Cursor, r: WireRecord) => streams.at(-1)!.fire.record?.forEach((fn) => fn({ data: JSON.stringify(r), lastEventId: String(gseq) }));
  const drop = () => streams.at(-1)!.fire.error?.forEach((fn) => (fn as () => void)());
  return { calls, streams, opts, emit, drop, ws };
}

Deno.test("daemon: load maps projects, config versions and every record kind onto the domain", async () => {
  const d = fakeDaemon(), snap = await daemon(d.opts).load();
  assertEquals([snap.source, snap.gseq, snap.events], ["daemon", 8, ["approved", "edited", "rejected"]]);
  const [project] = snap.workspace.projects;
  assertEquals([project.id, project.name, project.configs.map((c) => [c.version, c.hash])], ["p_bench", "Bench", [[1, "v1hash"]]]);
  const c = project.configs[0];
  assertEquals(c.params.map((p) => [p.name, p.coord, p.fixed]), [["m", "log", false], ["k", "log", false], ["b", "linear", true]]);
  assert(Number.isNaN(c.params[2].initial), "a missing initial stays NaN, it is not invented");
  assertEquals(c.catalog.map((e) => [e.id, e.label, e.maxRuns]), [["free_response", "Free response", 1], ["sine", "Sine", null]]);
  assertEquals(c.catalog[1].settings.find((s) => s.name === "frequency"), { name: "frequency", label: "frequency", unit: "", lo: 0.1, hi: 1, default: 0.4 });
  const inv = project.investigations[0];
  assertEquals([inv.id, inv.name, inv.configVersion, inv.free, inv.seed, inv.updated], ["inv_1", "bench A", 1, ["m", "k"], 7, "Nov 4 10:07 UTC"]);
  assertEquals(inv.measurements.map((m) => [m.id, m.split, m.output.length]), [["free_response@1", "train", 5], ["free_response@2", "test", 3]]);
  assert(Number.isNaN(inv.measurements[0].output[2]), "a null sample is NaN");
  assertEquals(inv.measurements[0].rate, 2);
  const fit = inv.fits[0];
  assertEquals([fit.n, fit.chi2N, fit.evals, fit.starts, fit.basins, fit.measurements, fit.curves], [1, 1.04, 40, 3, null, ["free_response@1"], {}]);
  assertEquals(fit.identification, { identified: ["k"], nonIdentified: ["m"], condition: 1.5e7 });
  const p = inv.proposals[0];
  assertEquals([p.id, p.status, p.atFit, p.hypothesis, p.fixedSettings], ["prop_1", "proposed", 1, "a sine pins m", { duration: 2 }]);
  assertEquals(p.fields.map((f) => [f.name, f.value, f.lo, f.hi]), [["amplitude", 1, 0.5, 2], ["frequency", 0.4, 0.1, 1]]);
  assertEquals(p.ranking, [{ label: "sine", score: 40, proposal: true }, { label: "free_response", score: 0, proposal: false }]);
  assertEquals(p.expected, [{ param: "m", after: null }], "only what was not identified");
  assertEquals(inv.budget, { steps: 2, simulations: 42, experiments: 2 });
});

Deno.test("daemon: the workbench renders the seeded investigation, with gaps said, not invented", async () => {
  const d = fakeDaemon(), store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "james", now: () => "10:46" });
  await store.start();
  const side = ctl.view().sidebar;
  assertEquals(side.nodes[0].label, "Bench");
  assertStringIncludes(side.nodes[0].children![1].label, "Investigation 1");
  assertEquals(side.nodes[0].children![1].children!.map((n) => n.label), ["Data", "Fit #1", "Sensitivity", "Sine 0.4 Hz", "Validate"]);
  ctl.handle({ kind: "select", id: "inv_1/fit-1/fit" });
  assertStringIncludes(JSON.stringify(ctl.view().main.body), "fit curve not recorded");
  ctl.handle({ kind: "select", id: "inv_1/fit-1/residuals" });
  assertEquals(ctl.view().main.body.kind, "investigation");
  ctl.handle({ kind: "select", id: "inv_1/prop/prop_1" });
  const details = ctl.view().details;
  assertEquals(details.status.text, "Awaiting approval");
  assertEquals(details.decision?.map((a) => a.name), ["approve", "reject"]);
  assertStringIncludes(JSON.stringify(details), "No preview recorded");
  assertEquals(ctl.view().main.body.kind, "investigation");
});

Deno.test("daemon: the stream resumes with after=<last gseq> after a drop and skips what it saw", async () => {
  const d = fakeDaemon(), src = daemon(d.opts), store = new Store(src);
  await store.start();
  assertEquals(d.streams[0].url, "/api/v1/stream?after=8");
  seq = 8;
  d.emit(9, rec("proposal", { proposal_id: "prop_1", event: "approved", by: "sdk" }));
  assertEquals(store.snapshot()!.workspace.projects[0].investigations[0].proposals[0].status, "approved");
  d.drop();
  await settle();
  assert(d.streams[0].closed, "the dropped stream is closed");
  assertEquals(d.streams.map((s) => s.url), ["/api/v1/stream?after=8", "/api/v1/stream?after=9"]);
  d.emit(9, rec("proposal", { proposal_id: "prop_1", event: "approved", by: "sdk" }));
  seq = 10;
  d.emit(10, rec("measurement", { observation: { experiment: "sine", settings: { amplitude: 1, frequency: 0.4 }, t: [0, 1], y: { x: [0, 1] }, sigma: { x: 0.01 }, split: "train" } }));
  assertEquals(store.applied.map((r) => r.gseq), [9, 10], "the replayed 9 applies once");
  assertEquals(store.snapshot()!.gseq, 10);
  assertEquals(store.snapshot()!.workspace.projects[0].investigations[0].measurements.at(-1)!.id, "sine@1");
});

Deno.test("daemon: a 409 from the approval route shows as Not saved in details", async () => {
  const d = fakeDaemon((c) => c.url.endsWith("/approvals")
    ? Response.json({ error: "conflict", message: "proposal is approved; approved is not allowed" }, { status: 409 }) : undefined);
  const store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "james", now: () => "10:46" });
  await store.start();
  ctl.handle({ kind: "select", id: "inv_1/prop/prop_1" });
  ctl.handle({ kind: "action", name: "approve" });
  await settle(); await settle();
  const post = d.calls.find((c) => c.url.endsWith("/approvals"))!;
  assertEquals(post.url, "/api/v1/investigations/inv_1/proposals/prop_1/approvals");
  assertEquals([post.init.method, (post.init.headers as Record<string, string>)["content-type"]], ["POST", "application/json"]);
  assertEquals(post.init.credentials, "same-origin");
  assertEquals((post.init.headers as Record<string, string>).authorization, undefined);
  const env = JSON.parse(String(post.init.body));
  assertEquals({ ...env, id: env.id.startsWith("ui-") }, { id: true, kind: "proposal", payload: { proposal_id: "prop_1", event: "approved", by: "james" } });
  assertStringIncludes(ctl.error!, "409 conflict: proposal is approved");
  assertStringIncludes(JSON.stringify(ctl.view().details), "Not saved: 409 conflict: proposal is approved; approved is not allowed");
  ctl.handle({ kind: "select", id: "inv_1" });
  assert(!JSON.stringify(ctl.view().details).includes("409 conflict"), "the next pick clears it");
});

Deno.test("daemon: an edit posts every proposed setting, edited ones replaced, and applies the answer once", async () => {
  const d = fakeDaemon((c) => {
    if (!c.url.endsWith("/approvals")) return undefined;
    const env = JSON.parse(String(c.init.body));
    return Response.json({ record: { id: env.id, investigation: "inv_1", seq: 8, kind: "proposal", ts: T0 + 600, payload: env.payload, prev_hash: "", hash: "" }, gseq: 9 }, { status: 201 });
  });
  const store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "james", now: () => "10:46" });
  await store.start();
  ctl.handle({ kind: "select", id: "inv_1/prop/prop_1" });
  ctl.handle({ kind: "field", name: "amplitude", raw: "1.5", commit: true });
  ctl.handle({ kind: "action", name: "approve" });
  await settle(); await settle();
  const env = JSON.parse(String(d.calls.find((c) => c.url.endsWith("/approvals"))!.init.body));
  assertEquals(env.payload, { proposal_id: "prop_1", event: "edited", by: "james", settings: { amplitude: 1.5, frequency: 0.4, duration: 2 } });
  assertEquals((d.calls.find((c) => c.url.endsWith("/approvals"))!.init.headers as Record<string, string>)["idempotency-key"], env.id);
  const p = store.snapshot()!.workspace.projects[0].investigations[0].proposals[0];
  assertEquals([p.status, p.decidedBy, p.fields[0].value, p.fields[0].original], ["approved", "james", 1.5, 1]);
  d.emit(9, { id: env.id, investigation: "inv_1", seq: 8, kind: "proposal", ts: T0 + 600, payload: env.payload });
  assertEquals(store.applied.length, 1, "the stream echo of the POST's record applies once");
  assertEquals(ctl.view().details.actions?.map(a => a.name), ["report"], "the daemon records no withdraw, so only Report is offered");
});

Deno.test("daemon: records that arrive out of order still all apply", async () => {
  const d = fakeDaemon(), store = new Store(daemon(d.opts));
  await store.start();
  seq = 9;
  d.emit(10, rec("step", { index: 3, decision: { action: "inspect_data" }, simulations: 0 }));
  seq = 8;
  store.apply({ gseq: 9, id: "r8", investigation: "inv_1", seq: 8, kind: "record", ts: "", record: rec("proposal", { proposal_id: "prop_1", event: "rejected", by: "sdk" }) });
  const inv = store.snapshot()!.workspace.projects[0].investigations[0];
  assertEquals([inv.proposals[0].status, inv.budget.steps], ["rejected", 3]);
});

Deno.test("daemon: decisions it does not record are refused before any request", async () => {
  const d = fakeDaemon(), src = daemon(d.opts);
  await src.load();
  const n = d.calls.length;
  const err = await src.post("/investigations/inv_1/proposals/prop_1/approvals", { event: "unapproved" }).catch((e) => e);
  assert(err instanceof ApiError && err.code === "unsupported", String(err));
  assertEquals(d.calls.length, n);
});

Deno.test("daemon: pairings are listed and approved from the configuration panel (O-3)", async () => {
  let pending = [{ user_code: "WXYZ-1234", device_name: "laptop", client: "autophys-py 0.1", expires: "2026-11-04T10:10:00Z" }];
  const d = fakeDaemon((c) => {
    if (c.url === "/api/v1/pairings") return Response.json({ pairings: pending });
    if (c.url === "/api/v1/pairings/WXYZ-1234/approve") { pending = []; return Response.json({ pairing: {} }); }
  });
  const store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "james", now: () => "10:46" });
  await store.start();
  await settle();
  assertEquals(store.snapshot()!.pairings, [{ code: "WXYZ-1234", device: "laptop", client: "autophys-py 0.1", expires: "2026-11-04T10:10:00Z" }]);
  assertEquals(ctl.view().sidebar.pinned.trail, { badge: "1", tone: "danger", label: "1 device waiting to approve" });
  ctl.handle({ kind: "select", id: ctl.view().sidebar.nodes[0].children![0].id });
  assertEquals(ctl.view().details.sections.flatMap((s) => s.blocks.flatMap((b) => b.kind === "pairing" ? b.decision.map((a) => a.name) : [])), ["pair-approve:WXYZ-1234", "pair-deny:WXYZ-1234"]);
  ctl.handle({ kind: "action", name: "pair-approve:WXYZ-1234" });
  await settle(); await settle(); await settle();
  const post = d.calls.find((c) => c.url.endsWith("/approve"))!;
  assertEquals([post.init.method, (post.init.headers as Record<string, string>)["content-type"], post.init.body], ["POST", "application/json", "{}"]);
  assertEquals(store.snapshot()!.pairings, []);
  assertEquals(ctl.view().details.actions?.length ?? 0, 0);
});


Deno.test("daemon: an empty daemon shows an empty workspace, not a crash", async () => {
  const d = fakeDaemon((c) => c.url === "/api/v1/workspace" ? Response.json({ cursor: 0, projects: [], config_versions: [], investigations: [], proposals: [], records: [] }) : undefined);
  const store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "james", now: () => "10:46" });
  await store.start();
  assertEquals(ctl.view().main.crumb, [{ label: "Getting started" }]);
  ctl.handle({ kind: "select", id: "anything" });
});

Deno.test("daemon: collection cursor survives a drop; workbook gseq collisions and POST echoes apply once", async () => {
  const d = fakeDaemon();
  d.ws.cursor = "prj_bench:8,prj_other:8";
  const src = daemon(d.opts), store = new Store(src);
  await store.start();
  assertEquals(d.streams[0].url, "/api/v1/stream?after=prj_bench%3A8%2Cprj_other%3A8");
  seq = 8;
  const approved = rec("proposal", { proposal_id: "prop_1", event: "approved", by: "browser" });
  // A POST returns a workbook-local integer, before the stream catches up.
  store.apply({ gseq: 9, id: approved.id, investigation: approved.investigation, seq: approved.seq, kind: "record", ts: "", record: approved });
  assertEquals(store.snapshot()!.gseq, "prj_bench:8,prj_other:8");
  d.emit("prj_bench:9,prj_other:8", approved);
  d.emit("prj_bench:9,prj_other:9", { ...approved, id: "other-r8", investigation: "inv_other", seq: 0, kind: "investigation", payload: { project_id: "p_bench", config_version: "v1hash", title: "second" } });
  assertEquals(store.applied.length, 2);
  assertEquals(store.snapshot()!.workspace.projects[0].investigations.length, 2);
  d.drop();
  await settle();
  assertEquals(d.streams.at(-1)!.url, "/api/v1/stream?after=prj_bench%3A9%2Cprj_other%3A9");
  const n = d.streams.length;
  store.close();
  d.drop();
  await settle();
  assertEquals(d.streams.length, n, "closing the store cancels reconnects");
});

Deno.test("daemon: no outlook retains all proposed settings read-only and makes no curves or residual claims", async () => {
  const d = fakeDaemon();
  delete d.ws.records.find((r) => r.kind === "proposal")!.payload.outlook;
  const store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "james", now: () => "10:46" });
  await store.start();
  ctl.handle({ kind: "select", id: "inv_1/prop/prop_1" });
  assertStringIncludes(JSON.stringify(ctl.view().details), "This proposal has no outlook grid");
  assertStringIncludes(JSON.stringify(ctl.view().details), "frequency");
  assertStringIncludes(JSON.stringify(ctl.view().main), "Sine 0.4 Hz");
  ctl.handle({ kind: "select", id: "inv_1/fit-1" });
  assertStringIncludes(JSON.stringify(ctl.view().main), "not recorded");
  const main = JSON.stringify(ctl.view().main);
  assert(!main.includes("force · none"), "missing input is not a zero-force chart");
  store.close();
});

Deno.test("daemon: the first device can pair before any project exists, and a refusal stays visible", async () => {
  let approved = false;
  const d = fakeDaemon((c) => {
    if (c.url === "/api/v1/workspace") return Response.json({ cursor: "", projects: [], config_versions: [], records: [] });
    if (c.url === "/api/v1/pairings") return Response.json({ pairings: approved ? [] : [{ user_code: "FIRST", device_name: "first device", client: "test", expires: "soon" }] });
    if (c.url.endsWith("/FIRST/deny")) return Response.json({ error: "expired_token", message: "code expired; start pairing again" }, { status: 409 });
    if (c.url.endsWith("/FIRST/approve")) { approved = true; return Response.json({ pairing: {} }); }
  });
  const store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "james", now: () => "" });
  await store.start();
  await settle();
  assertEquals(ctl.view().details.sections.flatMap((s) => s.blocks.flatMap((b) => b.kind === "pairing" ? b.decision.map((a) => a.name) : [])), ["pair-approve:FIRST", "pair-deny:FIRST"]);
  ctl.handle({ kind: "action", name: "pair-deny:FIRST" });
  await settle(); await settle();
  assertStringIncludes(JSON.stringify(ctl.view().details), "code expired; start pairing again");
  ctl.handle({ kind: "action", name: "pair-approve:FIRST" });
  await settle(); await settle();
  assertEquals(approved, true);
  assertEquals(store.snapshot()!.pairings, []);
  assert(!JSON.stringify(ctl.view().details).includes("Not saved"));
  store.close();
});

Deno.test("daemon: reference refresh brings the first streamed project into an initially empty workspace", async () => {
  const d = fakeDaemon();
  const full = structuredClone(d.ws);
  d.ws.projects = [];
  d.ws.config_versions = [];
  d.ws.records = [];
  d.ws.cursor = "";
  const store = new Store(daemon(d.opts));
  await store.start();
  Object.assign(d.ws, full, { cursor: "prj_bench:8" });
  d.emit("prj_bench:1", full.records[0]);
  await settle(); await settle();
  assertEquals(store.snapshot()!.workspace.projects[0].investigations[0].name, "bench A");
  store.close();
});

Deno.test("daemon: reject posts a rejected envelope and does not offer fixture-only restore", async () => {
  const d = fakeDaemon((c) => {
    if (!c.url.endsWith("/approvals")) return undefined;
    const env = JSON.parse(String(c.init.body));
    return Response.json({ record: { id: env.id, investigation: "inv_1", seq: 8, kind: "proposal", ts: T0, payload: env.payload }, gseq: 9 });
  });
  const store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "james", now: () => "" });
  await store.start();
  ctl.handle({ kind: "select", id: "inv_1/prop/prop_1" });
  ctl.handle({ kind: "action", name: "reject" });
  await settle(); await settle();
  assertEquals(store.snapshot()!.workspace.projects[0].investigations[0].proposals[0].status, "rejected");
  assertEquals(ctl.view().details.actions?.map(a => a.name), ["report"]);
  store.close();
});


Deno.test("daemon: a 401 during load asks the host to reauthenticate, stays visible", async () => {
  let reauth = 0;
  const src = daemon({ reauth: () => { reauth++; }, fetch: () => Promise.resolve(Response.json({ error: "unauthorized", message: "session expired" }, { status: 401 })) });
  const store = new Store(src), ctl = new Controller(store, { user: "james", now: () => "" });
  await store.start().catch(() => {});
  assertEquals(reauth, 1);
  assertEquals(store.snapshot(), null);
  assertStringIncludes(JSON.stringify(ctl.view()), "Browser session expired");
  store.close();
});

Deno.test("daemon: a 401 POST asks for reauth and preserves the recorded proposal", async () => {
  let reauth = 0;
  const d = fakeDaemon((c) => c.url.endsWith("/approvals") ? Response.json({ error: "unauthorized", message: "session expired" }, { status: 401 }) : undefined);
  const store = new Store(daemon({ ...d.opts, reauth: () => { reauth++; } })), ctl = new Controller(store, { user: "james", now: () => "" });
  await store.start();
  ctl.handle({ kind: "select", id: "inv_1/prop/prop_1" });
  ctl.handle({ kind: "action", name: "approve" });
  await settle(); await settle();
  assertEquals(reauth, 1);
  assertStringIncludes(ctl.view().main.connectionError!, "Browser session expired");
  assertEquals(store.snapshot()!.workspace.projects[0].investigations[0].proposals[0].status, "proposed");
  store.close();
});

Deno.test("daemon: SSE auth failure probes the cookie, reauthenticates once and stops reconnecting", async () => {
  let expired = false, reauth = 0;
  const d = fakeDaemon((c) => expired && (c.url === "/api/v1/context" || c.url === "/api/v1/pairings") ? Response.json({ error: "unauthorized" }, { status: 401 }) : undefined);
  const store = new Store(daemon({ ...d.opts, reauth: () => { reauth++; } }));
  await store.start();
  await settle();
  expired = true;
  d.drop();
  await settle(); await settle();
  assertEquals(reauth, 1);
  assertEquals(d.streams.length, 1);
  assert(d.streams[0].closed);
  assertStringIncludes(store.error!, "Browser session expired");
  await store.refreshPairings();
  assertEquals(reauth, 1, "overlapping failed calls cannot create a reload storm");
  store.close();
});

Deno.test("daemon: a registered project remains visible before its first configuration", async () => {
  const d = fakeDaemon((c) => c.url === "/api/v1/workspace" ? Response.json({ cursor: 0, projects: [{ id: "new-project", name: "New simulator" }], config_versions: [], investigations: [], proposals: [], records: [] }) : undefined);
  const store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "reviewer", now: () => "10:46" });
  await store.start();
  assertEquals(ctl.view().sidebar.switcher.kind, "none");
  assertEquals(ctl.view().sidebar.nodes[0].label, "New simulator");
  assertEquals(ctl.view().main.body.kind, "onboarding");
  assertStringIncludes(JSON.stringify(ctl.view().details), "This project is registered");
});

Deno.test("daemon: first investigation refreshes a registered project's missing configuration", async () => {
  let loads = 0;
  const d = fakeDaemon((c) => c.url === "/api/v1/workspace" && loads++ === 0 ? Response.json({ cursor: 0, projects: [{ id: "p_bench", name: "Bench" }], config_versions: [], records: [] }) : undefined);
  const store = new Store(daemon(d.opts)), ctl = new Controller(store, { user: "reviewer", now: () => "10:46" });
  await store.start();
  assertEquals(ctl.view().main.body.kind, "onboarding");
  for (const fire of d.streams[0].fire.record) fire({ data: JSON.stringify(d.ws.records[0]), lastEventId: "1" });
  await settle(); await settle();
  assertEquals(store.snapshot()!.workspace.projects[0].investigations.length, 1);
  assertEquals(ctl.view().sidebar.nodes.length, 1);
});

Deno.test("daemon: display events redraw an open store without advancing or duplicating records", async () => {
  const d = fakeDaemon(), store = new Store(daemon(d.opts));
  await store.start();
  let redraws = 0;
  store.subscribe(() => redraws++);
  const cursor = store.snapshot()!.gseq, before = store.snapshot()!.workspace.projects[0];
  const display = { format: 1, channels: { x: { label: "Displacement", unit: "mm" } }, settings: { frequency: { label: "Drive frequency", unit: "Hz", role: "drive" } }, experiments: { sine: { label: "Driven sine", views: ["spectrum"] } } };
  const fire = (event: unknown) => d.streams.at(-1)!.fire.display?.forEach((fn) => fn({ data: JSON.stringify(event), lastEventId: "" }));
  for (const invalid of [null, {}, { project_id: "p_bench", digest: "bad", display }, { project_id: "p_bench", digest: "a".repeat(64), display: { format: 9 } }]) fire(invalid);
  assertEquals(redraws, 0);
  const event = { project_id: "p_bench", digest: "a".repeat(64), display };
  fire(event); fire(event);
  const p = store.snapshot()!.workspace.projects[0], c = p.configs[0], sine = c.catalog.find((e) => e.id === "sine")!;
  assertEquals([redraws, store.snapshot()!.gseq, store.applied.length], [1, cursor, 0]);
  assertEquals([c.hash, p.investigations], [before.configs[0].hash, before.investigations]);
  assertEquals([sine.label, sine.output.label, sine.output.unit, sine.viewHints], ["Driven sine", "Displacement", "mm", ["frequency"]]);
  assertEquals(sine.settings.find((s) => s.name === "frequency")?.role, "drive");
  d.emit(9, rec("proposal", { proposal_id: "prop_1", event: "approved", by: "writer" }));
  assertEquals(store.applied.length, 1);
  const old = d.streams[0]; d.drop(); await settle();
  assert(old.closed);
  // A queued callback belonging to the old connection may not repaint or append.
  old.fire.display.forEach((fn) => fn({ data: JSON.stringify({ ...event, digest: "b".repeat(64), display: { format: 1 } }), lastEventId: "" }));
  old.fire.record.forEach((fn) => fn({ data: JSON.stringify(rec("outcome", { status: "failed" })), lastEventId: "10" }));
  assertEquals([store.snapshot()!.gseq, store.applied.length, redraws], [9, 1, 2]);
  fire({ ...event, digest: "c".repeat(64), display: { ...display, experiments: { sine: { label: "Reconnected sine", views: ["edges"] } } } });
  assertEquals(store.snapshot()!.workspace.projects[0].configs[0].catalog[1].label, "Reconnected sine");
  store.close();
  assert(d.streams.every((s) => s.closed));
});

Deno.test("daemon: reference fetch merges concurrent display metadata and records", async () => {
  const d = fakeDaemon(), rawFetch = d.opts.fetch!;
  let resolve!: (r: Response) => void, refresh = false;
  d.opts.fetch = (input, init) => refresh && String(input).endsWith("/workspace")
    ? new Promise<Response>((r) => { resolve = r; }) : rawFetch(input, init);
  const store = new Store(daemon(d.opts)); await store.start(); refresh = true;
  const newer = rec("investigation", { project_id: "p_bench", config_version: "v2hash", title: "new config", seed: 1 }, "inv_2");
  d.emit(9, newer); // Starts a reference request containing an older display snapshot.
  await settle();
  const live = { project_id: "p_bench", digest: "d".repeat(64), display: { format: 1, experiments: { sine: { label: "Latest display" } } } };
  d.streams.at(-1)!.fire.display.forEach((fn) => fn({ data: JSON.stringify(live), lastEventId: "" }));
  const decision = rec("proposal", { proposal_id: "prop_1", event: "approved", by: "concurrent" });
  d.emit(10, decision);
  resolve(Response.json({ ...d.ws, config_versions: [...d.ws.config_versions, { ...d.ws.config_versions[0], version: "v2hash" }] }));
  await settle(); await settle();
  const snap = store.snapshot()!, p = snap.workspace.projects[0];
  assertEquals([snap.gseq, store.applied.length, p.configs[0].catalog[1].label], [10, 2, "Latest display"]);
  assertEquals(p.investigations.length, 2);
  assertEquals(p.investigations[0].proposals[0].status, "approved");
  assertEquals(p.configs.map(c => c.hash), ["v1hash", "v2hash"]);
  let redraws = 0; store.subscribe(() => redraws++);
  d.streams.at(-1)!.fire.display.forEach(fn => fn({ data: JSON.stringify(live), lastEventId: "" }));
  assertEquals([redraws, store.snapshot()!.gseq, store.applied.length], [0, 10, 2]);
  store.close();
});

Deno.test("daemon: A event, snapshot B, reconnect A reconciles display identity", async () => {
  const d = fakeDaemon(), store = new Store(daemon(d.opts));
  await store.start();
  const display = (label: string) => ({ format: 1, channels: { x: { label, unit: "mm" } }, settings: { frequency: { label, role: "drive" } }, experiments: { sine: { label, views: ["spectrum"] } } });
  const a = { project_id: "p_bench", digest: "a".repeat(64), display: display("A") };
  const fire = () => d.streams.at(-1)!.fire.display.forEach(fn => fn({ data: JSON.stringify(a), lastEventId: "" }));
  const before = store.snapshot()!, cursor = before.gseq, hash = before.workspace.projects[0].configs[0].hash;
  fire();
  d.ws.projects[0].display = display("B");
  await store.refreshWorkspace();
  assertEquals(store.snapshot()!.workspace.projects[0].configs[0].catalog[1].label, "B");
  let redraws = 0; store.subscribe(() => redraws++);
  fire();
  const current = store.snapshot()!, config = current.workspace.projects[0].configs[0], sine = config.catalog[1];
  assertEquals([sine.label, sine.output.label, sine.output.unit, sine.viewHints], ["A", "A", "mm", ["frequency"]]);
  assertEquals(sine.settings.find(s => s.name === "frequency")?.role, "drive");
  assertEquals([current.gseq, store.applied.length, config.hash], [cursor, 0, hash]);
  assertEquals(current.workspace.projects[0].investigations, before.workspace.projects[0].investigations);
  fire(); assertEquals(redraws, 1);
  // A snapshot with the same JSON body in a different key order preserves dedup.
  d.ws.projects[0].display = { experiments: a.display.experiments, settings: a.display.settings, channels: a.display.channels, format: 1 };
  await store.refreshWorkspace();
  const afterRefresh = redraws; fire(); assertEquals(redraws, afterRefresh);
  store.close();
});

Deno.test("wire: duplicate display receipt protects an in-flight reference without redrawing", async () => {
  const { WireModel } = await import("./wire.ts");
  const raw = workspace(), model = new WireModel(raw);
  const event = { project_id: "p_bench", digest: "e".repeat(64), display: { format: 1, experiments: { sine: { label: "Current" } } } };
  assert(model.display(event)); model.takeChanged();
  const started = model.displayRevision;
  assertEquals(model.display(event), false); assertEquals(model.takeChanged(), false);
  raw.projects[0].display = { format: 1, experiments: { sine: { label: "Older snapshot" } } };
  model.reference(raw, started);
  assertEquals(model.workspace().projects[0].configs[0].catalog[1].label, "Current");
  model.takeChanged(); assertEquals(model.display(event), false); assertEquals(model.takeChanged(), false);
});
