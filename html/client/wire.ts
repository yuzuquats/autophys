/**
 * The daemon's wire format (`GET /workspace`, the record stream) mapped onto the domain.
 * `WireModel` holds the reference data (projects, config versions) and every record it has
 * seen, keyed by record id, so records may arrive in any order and more than once; the
 * domain workspace is re-derived from that log, one investigation at a time. Pure: no
 * network (api.ts fetches), no numerics (AX-2). Where the records do not carry something
 * the domain has a place for (fit curves, landscapes, singular vectors, previews), the
 * field stays empty and derive says "not recorded".
 */
import type {
  Channel, ExperimentKind, ExperimentSpec, Fit, Investigation, Measurement, ParamSpec, Project, ProjectConfig, Proposal, ProposalField, ProposalOutlook,
  RankedCandidate, SettingRole, SimulatorKind, TraceStep, Validation, ViewHint, Workspace,
} from "./domain.ts";

/** A record exactly as the daemon serves it (the SDK's 8 fields). */
export type WireRecord = { id: string; investigation: string; seq: number; kind: string; ts: number; payload: Record<string, unknown>; prev_hash?: string; hash?: string };
/** `display` is the project's latest display manifest (format 1), or null when none was uploaded. */
export type WireProject = { id: string; name: string; display?: unknown };
export type WireConfig = { project_id: string; version: string; config: unknown };
/** `GET /workspace`: one consistent snapshot; resume the stream from `cursor`. */
export type WireWorkspace = { workspace_id?: string; principal_id?: string; cursor: number | string; projects: WireProject[]; config_versions: WireConfig[]; records: WireRecord[] };
/** `GET /pairings` rows. */
export type WirePairing = { user_code: string; device_name: string; client: string; expires: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** A JSON number, or NaN for null (the SDK writes NaN as null) and anything else. */
const num = (v: unknown): number => (typeof v === "number" ? v : NaN);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(num) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const numeric = (v: unknown): Record<string, number> => Object.fromEntries(Object.entries(obj(v)).filter(([, x]) => typeof x === "number")) as Record<string, number>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
/** A record's epoch-seconds `ts` as "Nov 4 10:05 UTC". */
export function when(ts: number): string {
  const d = new Date(ts * 1000);
  if (!Number.isFinite(d.getTime())) return "–";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** "free_response" → "Free response". */
const humanize = (id: string) => (id.charAt(0).toUpperCase() + id.slice(1)).replace(/_/g, " ");

// ------------------------------------------------------------------------ configuration

function experimentSpec(id: string, entry: unknown, output: Channel): ExperimentSpec {
  const e = obj(entry), edit = obj(e.edit);
  const settings = Object.entries(numeric(e.settings)).map(([name, value]) => {
    const lim = nums(edit[name]);
    return { name, label: name, unit: "", lo: lim.length === 2 ? lim[0] : value, hi: lim.length === 2 ? lim[1] : value, default: value };
  });
  return { id: id as ExperimentKind, label: humanize(id), input: null, output, settings, maxRuns: typeof e.max_runs === "number" ? e.max_runs : null, viewHints: [] };
}

const VIEWS = new Map<string, ViewHint>([["envelope", "envelope"], ["spectrum", "frequency"], ["edges", "zoom:edges"]]);
/** Manifest keys are data: only own properties count, so a name such as "constructor" is never mistaken for a declaration. */
const has = (o: Obj, key: string) => Object.hasOwn(o, key);
const ROLES = new Set(["drive", "sampling", "known", "other"]);

/**
 * A display manifest (format 1, display-manifest.md) applied to a config: channel, setting and
 * parameter labels, units and roles, experiment labels, descriptions, views and input previews.
 * The manifest is presentation only; it never changes values, ranges or the config hash. With no
 * manifest (or another format) the config is returned unchanged and renders generically.
 */
export function applyDisplay(c: ProjectConfig, display: unknown): ProjectConfig {
  const d = obj(display);
  if (d.format !== 1) return c;
  const channels = obj(d.channels), settings = obj(d.settings), params = obj(d.params), experiments = obj(d.experiments);
  const channel = (name: string, fallback: Channel): Channel => {
    const ch = obj(channels[name]);
    return has(channels, name) ? { name, label: str(ch.label) || name, unit: str(ch.unit) } : fallback;
  };
  const inputName = Object.keys(channels).find((k) => obj(channels[k]).role === "input");
  return {
    ...c,
    params: c.params.map((p) => {
      const m = obj(params[p.name]);
      return { ...p, ...(str(m.label) ? { label: str(m.label) } : {}), ...(str(m.description) ? { description: str(m.description) } : {}) };
    }),
    catalog: c.catalog.map((e) => {
      const m = obj(experiments[e.id]), declared = has(experiments, e.id), views = strs(m.views), preview = obj(m.preview);
      // An experiment drives the input channel when its preview of that channel is not all zero (free decay records zeros).
      const u = inputName ? nums(obj(preview.u)[inputName]) : [], t = nums(preview.t), drives = u.length > 1 && u.length === t.length && u.some((v) => v !== 0);
      return {
        ...e,
        label: str(m.label) || e.label,
        input: inputName && drives ? channel(inputName, { name: inputName, label: inputName, unit: "" }) : e.input && channel(e.input.name, e.input),
        output: channel(e.output.name, e.output),
        settings: e.settings.map((s) => {
          const sd = obj(settings[s.name]), role = str(sd.role);
          return has(settings, s.name)
            ? { ...s, label: str(sd.label) || s.name, unit: typeof sd.unit === "string" ? sd.unit : s.unit, role: (ROLES.has(role) ? role : "other") as SettingRole }
            : { ...s, label: s.name, role: "other" as const };
        }),
        ...(declared ? {
          viewHints: views.filter((v) => VIEWS.has(v)).map((v) => VIEWS.get(v)!),
          unsupportedViews: views.filter((v) => !VIEWS.has(v)),
          description: str(m.description),
          preview: drives ? { t, u } : null,
        } : {}),
      };
    }),
  };
}

/** The SDK's `Project.config()` (sdks/python project.py) as a domain config version, with the project's display manifest applied. */
export function mapConfig(config: unknown, version: number, hash: string, display?: unknown): ProjectConfig {
  return applyDisplay(baseConfig(config, version, hash), display);
}

function baseConfig(config: unknown, version: number, hash: string): ProjectConfig {
  const c = obj(config), sim = obj(c.simulator), noise = obj(c.noise), budgets = obj(c.budgets), policy = obj(c.policy);
  const params: ParamSpec[] = Object.entries(obj(c.params)).map(([name, raw]) => {
    const p = obj(raw), lo = num(p.lo), hi = num(p.hi);
    // The SDK's rule (simulator.py ParamSpec.log): strictly positive parameters are fitted in log space.
    return { name, unit: str(p.unit), lo, hi, initial: num(p.initial), fixed: p.fixed === true, coord: lo > 0 ? "log" : "linear" };
  });
  const outName = strs(sim.outputs)[0] ?? "y";
  const output: Channel = { name: outName, label: outName, unit: "" };
  const kind = str(policy.kind) || "scripted";
  const free = params.filter((p) => !p.fixed).map((p) => p.name);
  return {
    version, hash,
    simulator: { kind: (str(sim.name) || "simulator") as SimulatorKind, name: str(sim.name) || "simulator", version: "", sourceHash: str(sim.source_hash) },
    params,
    catalog: Object.entries(obj(c.catalog)).map(([id, e]) => experimentSpec(id, e, output)),
    noise: { sigma: numeric(noise.sigma), estimate: noise.estimate === true, bias: (str(noise.bias) || "off") as ProjectConfig["noise"]["bias"] },
    budgets: { maxSteps: num(budgets.max_steps), maxSimulations: num(budgets.max_simulations), maxExperiments: num(budgets.max_experiments) },
    policy: { kind: kind === "scripted" ? "scripted" : "reason-lane", effort: str(policy.effort) || null, label: [kind.replace(/_/g, " "), str(policy.effort)].filter(Boolean).join(" · ") },
    combinations: [],
    landscape: { x: free[0] ?? "", y: free[1] ?? "", held: free.slice(2).join(", ") },
  };
}

/** Make sure every experiment a record names has a catalog entry, so derive can look it up. */
function ensureSpecs(c: ProjectConfig, experiments: Iterable<string>): ProjectConfig {
  const missing = [...new Set(experiments)].filter((id) => !c.catalog.some((e) => e.id === id));
  if (!missing.length) return c;
  const output = c.catalog[0]?.output ?? { name: "y", label: "y", unit: "" };
  return { ...c, catalog: [...c.catalog, ...missing.map((id) => experimentSpec(id, {}, output))] };
}

// ------------------------------------------------------------------------ one investigation

type Raw = { proposal: Proposal; settings: Obj };

function outlookOf(payload: Obj): ProposalOutlook {
  const o = obj(payload.outlook);
  if (!Array.isArray(o.axes)) return { axes: [], score: [num(payload.score)], after: {} };
  return {
    axes: o.axes.map((a) => ({ name: str(obj(a).name), values: nums(obj(a).values) })),
    score: nums(o.score),
    after: Object.fromEntries(Object.entries(obj(o.after)).map(([k, v]) => [k, nums(v)])),
  };
}

/** The investigation as its records describe it, or null when its head or its config is unknown. */
export function mapInvestigation(records: WireRecord[], configs: { version: string; config: unknown }[]): { inv: Investigation; experiments: string[] } | null {
  const head = records[0];
  if (!head || head.kind !== "investigation") return null;
  const meta = head.payload, at = configs.findIndex((c) => c.version === str(meta.config_version));
  if (at < 0) return null;
  const rawConfig = obj(configs[at].config), catalog = obj(rawConfig.catalog);
  const overrides = obj(meta.overrides);
  const declaredFree = Object.entries(obj(rawConfig.params)).filter(([, p]) => obj(p).fixed !== true).map(([k]) => k);
  const free = Array.isArray(overrides.free) ? strs(overrides.free) : declaredFree;
  const host = str(meta.host) || "the SDK";

  const measurements: Measurement[] = [], fits: Fit[] = [], proposals = new Map<string, Raw>(), runs: Record<string, number> = {};
  const measurementIds = new Map<string, { id: string; channel: string }>();
  let reveal: Investigation["reveal"];
  let ranking: { criterion: string; rows: unknown[] } | null = null;
  let nonIdentified: string[] | null = null;
  let steps = 0, simulations = 0, state: Investigation["state"] = "awaiting-agent", validation: Validation = { state: "needs-data", recorded: false };
  // Steps since the last proposing step. The proposal record is written while its step runs, so it
  // usually precedes that step's record; either order attaches the same trail.
  let trail: TraceStep[] = [], untraced: Raw | null = null, orphan: TraceStep[] | null = null;

  for (const r of records.slice(1)) {
    const p = r.payload;
    if (r.kind === "measurement") {
      const o = obj(p.observation), experiment = str(o.experiment) || "measurement", ys = obj(o.y), channel = Object.keys(ys)[0] ?? "";
      const t = nums(o.t), n = (runs[experiment] ?? 0) + 1;
      runs[experiment] = n;
      measurementIds.set(r.id, { id: `${experiment}@${n}`, channel });
      measurements.push({
        id: `${experiment}@${n}`, experiment: experiment as ExperimentKind, settings: numeric(o.settings),
        split: o.split === "train" ? "train" : "test", uploadedAt: when(r.ts), source: str(o.source) || host,
        inputRecorded: false, sigmaSource: "declared",
        rate: t.length > 1 ? (t.length - 1) / (t[t.length - 1] - t[0]) : NaN, t, input: null, output: nums(ys[channel]),
        sigmaEstimate: num(obj(o.sigma)[channel]),
      });
      if (state === "validated" || state === "inconclusive") state = "awaiting-agent";
      validation = { state: "needs-data", recorded: false };
    } else if (r.kind === "run") {
      state = "awaiting-agent";
      validation = { state: "needs-data", recorded: false };
      const params = numeric(p.params);
      const curves: Fit["curves"] = {};
      for (const [recordId, raw] of Object.entries(obj(p.curves))) {
        const measurement = measurementIds.get(recordId);
        if (!measurement) continue;
        const c = obj(raw), fitted = obj(c.fit), initial = obj(c.initial);
        if (!Array.isArray(fitted[measurement.channel])) continue;
        curves[measurement.id] = {
          ...(Array.isArray(c.t) ? { t: nums(c.t) } : {}),
          fit: nums(fitted[measurement.channel]), initial: nums(initial[measurement.channel]),
        };
      }
      fits.push({
        n: Number.isFinite(num(p.fit_id)) ? num(p.fit_id) : fits.length + 1, state: p.success === false ? "failed" : "converged", variant: str(p.model) || null,
        measurements: measurements.filter((m) => m.split === "train").map((m) => m.id),
        free: Object.keys(params).filter((k) => free.includes(k) || !declaredFree.length), fixed: {}, initial: {}, params,
        chi2N: num(p.chi2_per_n), evals: num(p.nfev), starts: Array.isArray(p.starts) ? p.starts.length : 0, basins: null,
        loss: p.loss_kind === "soft_l1" ? "soft_l1" : "linear", lag1: {}, trail: [], sensitivity: null, landscape: null, curves, frequency: null,
        seed: Number.isFinite(num(p.seed)) ? num(p.seed) : NaN, identification: null,
      });
    } else if (r.kind === "step") {
      steps++;
      if (Number.isFinite(num(p.simulations))) simulations += num(p.simulations);
      const decision = obj(p.decision), action = str(decision.action), result = obj(p.result);
      trail.push({ n: steps, action: action || "unusable decision", hypothesis: str(decision.hypothesis), evidence: strs(decision.evidence),
        expected: str(decision.expected_information), ...(str(p.error) ? { error: str(p.error) } : {}) });
      if (action === "propose_experiment") {
        if (untraced) untraced.proposal.trace = trail;
        else orphan = trail;
        untraced = null;
        trail = [];
      }
      // An identifiability check: an analyze_sensitivity result for the step's fit, or the
      // identification a fitting step carries for the fit it just recorded (identify_every_fit).
      const checked = action === "analyze_sensitivity" ? result : obj(result.identification);
      if (Array.isArray(checked.identified)) {
        nonIdentified = strs(checked.non_identified);
        const fit = (action === "analyze_sensitivity" ? fits.find((f) => f.n === num(p.fit_id)) : undefined) ?? fits[fits.length - 1];
        if (fit) fit.identification = { identified: strs(checked.identified), nonIdentified, condition: Number.isFinite(num(checked.condition_number)) ? num(checked.condition_number) : null,
          ...(checked.marginal_log_std && typeof checked.marginal_log_std === "object" ? { marginal: numeric(checked.marginal_log_std) } : {}) };
      } else if (str(checked.skipped) && fits.length) {
        fits[fits.length - 1].identificationSkipped = str(checked.skipped);
      }
      if (action === "rank_experiments" && Array.isArray(result.ranking)) ranking = { criterion: str(result.criterion) || "min_eig", rows: result.ranking };
    } else if (r.kind === "proposal") {
      const pid = str(p.proposal_id), event = str(p.event), raw = proposals.get(pid);
      if (event === "proposed") {
        const raw = proposed(pid, p, obj(catalog[str(p.experiment)]), fits[fits.length - 1]?.n ?? 0, ranking, nonIdentified, host);
        proposals.set(pid, raw);
        if (orphan) raw.proposal.trace = orphan;
        untraced = orphan ? null : raw;
        orphan = null;
        state = "awaiting-agent";
      } else if (raw) {
        decided(raw, event, p, r.ts);
      }
    } else if (r.kind === "reveal") {
      reveal = {
        source: str(p.source), tolerance: num(p.tolerance), truth: numeric(p.truth), estimate: numeric(p.estimate), fit_id: num(p.fit_id),
        quantities: (Array.isArray(p.quantities) ? p.quantities : []).map((raw) => {
          const q = obj(raw);
          return { name: str(q.name), truth: num(q.truth), estimate: num(q.estimate), ratio: num(q.ratio),
            sigma_ratio: typeof q.sigma_ratio === "number" ? q.sigma_ratio : null, within: q.within === true, identifiable: q.identifiable === true };
        }),
      };
    } else if (r.kind === "outcome") {
      const status = str(p.status);
      state = status === "validated" ? "validated" : ["inconclusive", "failed", "budget_exhausted"].includes(status) ? "inconclusive" : "awaiting-agent";
      const v = obj(p.validation);
      if (v.available === true) {
        validation = { state: "summary", passed: v.passed === true, chi2N: num(v.chi2_per_n), threshold: num(v.threshold), measurements: measurements.filter((m) => m.split === "test").map((m) => m.id) };
      }
    }
  }
  const last = records[records.length - 1];
  const experiments = [...measurements.map((m) => m.experiment as string), ...[...proposals.values()].map((x) => x.proposal.experiment as string)];
  return {
    experiments,
    inv: {
      id: head.investigation, name: str(meta.title) || head.investigation, projectId: str(meta.project_id), configVersion: at + 1, free, host,
      seed: Number.isFinite(num(meta.seed)) ? num(meta.seed) : NaN, state, progress: null, updated: when(last.ts),
      budget: { steps, simulations, experiments: measurements.length },
      measurements, fits, proposals: [...proposals.values()].map((x) => x.proposal), validation, ...(reveal ? { reveal } : {}),
    },
  };
}

export function proposed(pid: string, p: Obj, entry: Obj, atFit: number, ranking: { criterion: string; rows: unknown[] } | null, nonIdentified: string[] | null, host: string): Raw {
  const settings = obj(p.settings), experiment = str(p.experiment), outlook = outlookOf(p), edit = obj(entry.edit);
  const fields: ProposalField[] = outlook.axes.map((a) => {
    const lim = nums(edit[a.name]), value = num(settings[a.name]);
    return { name: a.name, label: a.name, unit: "", value, original: value, lo: lim.length === 2 ? lim[0] : a.values[0], hi: lim.length === 2 ? lim[1] : a.values[a.values.length - 1] };
  });
  const editable = new Set(fields.map((f) => f.name));
  const own = num(p.score);
  const rows: RankedCandidate[] = (ranking?.rows ?? []).map((row) => {
    const d = obj(row);
    const [label, minEig, dOpt, after] = Array.isArray(row) ? row : [d.experiment, d.min_eig, d.d_opt, d.after];
    return { label: str(label), score: ranking!.criterion === "d_opt" ? num(dOpt) : num(minEig), proposal: str(label) === experiment,
      ...(after && typeof after === "object" ? { after: Object.fromEntries(Object.entries(obj(after)).map(([k, v]) => [k, v == null || !Number.isFinite(num(v)) ? null : num(v)])) } : {}) };
  }).filter((x) => x.label && Number.isFinite(x.score));
  if (!rows.some((x) => x.proposal) && Number.isFinite(own)) rows.push({ label: experiment, score: own, proposal: true });
  const params = Object.keys(outlook.after).filter((k) => !nonIdentified || nonIdentified.includes(k));
  return {
    settings,
    proposal: {
      id: pid, experiment: experiment as ExperimentKind, atFit, fields,
      fixedSettings: Object.fromEntries(Object.entries(numeric(settings)).filter(([k]) => !editable.has(k))),
      status: "proposed", decidedBy: null, decidedAt: null,
      hypothesis: str(p.rationale) || str(p.expected_information), ranking: rows,
      expected: params.map((param) => ({ param, after: null, ...(nonIdentified ? {} : { before: "unknown" as const }) })), dataFrom: host,
      preview: { t: [], input: null, predicted: [] }, outlook, delivered: false,
    },
  };
}

function decided(raw: Raw, event: string, p: Obj, ts: number): void {
  const prop = raw.proposal;
  if (event === "approved" || event === "edited" || event === "rejected" || event === "withdrawn") {
    prop.status = event === "rejected" || event === "withdrawn" ? "rejected" : "approved";
    prop.decidedBy = event === "withdrawn" ? "the SDK (withdrawn)" : str(p.by) || "someone";
    prop.decidedAt = when(ts);
  }
  if (event === "edited") {
    raw.settings = obj(p.settings);
    prop.fields = prop.fields.map((f) => ({ ...f, value: Number.isFinite(num(raw.settings[f.name])) ? num(raw.settings[f.name]) : f.value }));
  }
  if (event === "data_attached") prop.delivered = true;
}

/** JSON display bodies can arrive with different object-key order in a snapshot. */
function sameDisplay(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every((key) => Object.hasOwn(b, key) &&
    sameDisplay((a as Obj)[key], (b as Obj)[key]));
}

// ------------------------------------------------------------------------ the model

export class WireModel {
  private projects: WireProject[] = [];
  private configs = new Map<string, { version: string; config: unknown }[]>();
  private logs = new Map<string, WireRecord[]>();
  private seen = new Set<string>();
  private cache = new Map<string, ReturnType<typeof mapInvestigation>>();
  private changed = true;
  /** Monotonic local receipt order, independent of record cursors. */
  displayRevision = 0;
  private displays = new Map<string, { digest: string; display: unknown; revision: number }>();

  /** The server validates format-1 manifests; reject malformed stream envelopes here. */
  display(event: unknown): boolean {
    const e = obj(event);
    if (typeof e.project_id !== "string" || !e.project_id || typeof e.digest !== "string" || !/^[a-f0-9]{64}$/.test(e.digest) || obj(e.display).format !== 1) return false;
    const previous = this.displays.get(e.project_id), revision = ++this.displayRevision;
    if (previous?.digest === e.digest) {
      // Even an unchanged receipt is newer than an already in-flight snapshot.
      this.displays.set(e.project_id, { ...previous, revision });
      return false;
    }
    this.displays.set(e.project_id, { digest: e.digest, display: e.display, revision });
    this.projects = this.projects.map((p) => p.id === e.project_id ? { ...p, display: e.display } : p);
    this.changed = true;
    return true;
  }
  /** Set when a record pins a project or config version the reference data lacks: refetch it. */
  stale = false;

  constructor(w: WireWorkspace, readonly user = "local") {
    this.reference(w);
    for (const r of w.records) this.add(r);
  }

  /** Replace the projects and config versions (from a fresh `GET /workspace`). */
  reference(w: Pick<WireWorkspace, "projects" | "config_versions">, startedAt = this.displayRevision): void {
    this.projects = w.projects.map((p) => {
      const live = this.displays.get(p.id);
      if (live && live.revision > startedAt) return { ...p, display: live.display };
      // A remembered digest belongs to its body, not to every later snapshot.
      // Keep it only when the snapshot installs that same presentation.
      if (live && !sameDisplay(live.display, p.display)) this.displays.delete(p.id);
      return p;
    });
    for (const [id, live] of this.displays) {
      if (live.revision <= startedAt && !w.projects.some((p) => p.id === id)) this.displays.delete(id);
    }
    this.configs = new Map();
    for (const c of w.config_versions) this.configs.set(c.project_id, [...(this.configs.get(c.project_id) ?? []), { version: c.version, config: c.config }]);
    this.cache.clear();
    this.stale = false;
    this.changed = true;
  }

  /** Add a record; false when it was already there (by id). */
  add(r: WireRecord): boolean {
    const key = `${r.investigation}/${r.id}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const log = this.logs.get(r.investigation) ?? [];
    let i = log.length;
    while (i > 0 && log[i - 1].seq > r.seq) i--;
    log.splice(i, 0, r);
    this.logs.set(r.investigation, log);
    this.cache.delete(r.investigation);
    this.changed = true;
    return true;
  }

  /** Whether anything changed since the last call. */
  takeChanged(): boolean {
    const c = this.changed;
    this.changed = false;
    return c;
  }

  /** A proposal's settings as last proposed or edited, exactly as recorded (for an `edited` decision). */
  settings(investigation: string, proposal: string): Record<string, unknown> | null {
    let out: Record<string, unknown> | null = null;
    for (const r of this.logs.get(investigation) ?? []) {
      const p = r.payload;
      if (r.kind === "proposal" && p.proposal_id === proposal && (p.event === "proposed" || p.event === "edited")) out = obj(p.settings);
    }
    return out;
  }

  workspace(): Workspace {
    this.stale = false;
    const projects: Project[] = [];
    for (const wp of this.projects) {
      const cfgs = this.configs.get(wp.id) ?? [];
      if (!cfgs.length) {
        projects.push({ id: wp.id, name: wp.name, configs: [], investigations: [] });
        // Its first streamed investigation may reference a config registered after load.
        if ([...this.logs.values()].some((log) => str(log[0]?.payload.project_id) === wp.id)) this.stale = true;
        continue;
      }
      const mapped: NonNullable<ReturnType<typeof mapInvestigation>>[] = [];
      for (const [id, log] of this.logs) {
        if (str(log[0]?.payload.project_id) !== wp.id) continue;
        if (!this.cache.has(id)) this.cache.set(id, mapInvestigation(log, cfgs));
        const m = this.cache.get(id);
        if (m) mapped.push(m);
        else this.stale = true;
      }
      mapped.sort((a, b) => (this.logs.get(a.inv.id)![0].ts - this.logs.get(b.inv.id)![0].ts) || (a.inv.id < b.inv.id ? -1 : 1));
      const used = new Map<number, string[]>();
      for (const m of mapped) used.set(m.inv.configVersion, [...(used.get(m.inv.configVersion) ?? []), ...m.experiments]);
      // Applied after ensureSpecs, so experiments only records name still get the manifest's labels.
      const configs = cfgs.map((c, i) => applyDisplay(ensureSpecs(mapConfig(c.config, i + 1, c.version), used.get(i + 1) ?? []), wp.display));
      projects.push({ id: wp.id, name: wp.name, configs, investigations: mapped.map((m) => m.inv) });
    }
    for (const [, log] of this.logs) if (log[0]?.kind === "investigation" && !this.projects.some((p) => p.id === str(log[0].payload.project_id))) this.stale = true;
    return { user: this.user, projects };
  }
}

export const pairingOf = (p: WirePairing) => ({ code: p.user_code, device: p.device_name, client: p.client, expires: p.expires });
