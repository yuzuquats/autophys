/**
 * The autophys domain: workspace → project → investigation → measurements, fits, sensitivity,
 * proposals and validation, delivered by the daemon Source (api.ts). Every number
 * is computed upstream by the SDK; the client formats and never simulates (AX-2). Plain JSON.
 */

export type SimulatorKind = "oscillator" | "thermal" | "thevenin";
export type ExperimentKind = "free_response" | "impulse" | "step" | "sine" | "power_step" | "pulse_train";
export type Params = Record<string, number>;
export type Settings = Record<string, number>;
/** Fitting coordinates, as the SDK uses them: log(θ) for positive parameters, θ/(hi−lo) otherwise. */
export type Coord = "log" | "linear";

/** Extra main views an experiment type asks for, beyond Fit, Residuals and Landscape. */
export type ViewHint = "envelope" | "frequency" | "zoom:edges";

export type Channel = { name: string; label: string; unit: string };
/**
 * How a setting is shown (display manifest roles): what the experiment applies (drive), how it is
 * recorded (sampling), a physical constant shared by experiments (known), or undeclared (other).
 * No role means no manifest was uploaded; it renders as `other`.
 */
export type SettingRole = "drive" | "sampling" | "known" | "other";
export type SettingSpec = { name: string; label: string; unit: string; lo: number; hi: number; default: number; role?: SettingRole };

/** `label` and `description` come from the display manifest; the name is the fallback. */
export type ParamSpec = { name: string; unit: string; lo: number; hi: number; initial: number; fixed: boolean; coord: Coord; label?: string; description?: string };

export type ExperimentSpec = {
  id: ExperimentKind;
  label: string;
  input: Channel | null;
  output: Channel;
  settings: SettingSpec[];
  /** Limit on runs of this experiment per investigation (null: no limit). */
  maxRuns: number | null;
  viewHints: ViewHint[];
  /** From the display manifest: a sentence about the experiment, the input it applies at its defaults, and views this UI cannot draw. */
  description?: string;
  preview?: { t: number[]; u: number[] } | null;
  unsupportedViews?: string[];
};

/** One immutable configuration version, declared in code by the SDK and keyed by the hash of its canonical JSON. */
export type ProjectConfig = {
  version: number;
  hash: string;
  simulator: { kind: SimulatorKind; name: string; version: string; sourceHash: string };
  params: ParamSpec[];
  catalog: ExperimentSpec[];
  noise: { sigma: Record<string, number>; estimate: boolean; bias: "off" | "fit" | "compare" };
  budgets: { maxSteps: number; maxSimulations: number; maxExperiments: number };
  policy: { kind: "scripted" | "reason-lane"; effort: string | null; label: string };
  /** Combinations to report when raw parameters sit on a ridge: name and exponents (k/m = {k: 1, m: -1}). */
  combinations: { name: string; exponents: Record<string, number> }[];
  /** The two parameters the Landscape view slices, and what is held while it does. */
  landscape: { x: string; y: string; held: string };
};

export type Measurement = {
  /** `<experiment>@<n>`, e.g. free_response@1. */
  id: string;
  experiment: ExperimentKind;
  settings: Settings;
  /** train is fitted; test is held out for validation. */
  split: "train" | "test";
  uploadedAt: string;
  source: string;
  rate: number;
  t: number[];
  input: number[] | null;
  /** NaN marks a missing sample (exported as null). */
  output: number[];
  sigmaEstimate: number;
  /** False when the source records no input channel or series. */
  inputRecorded?: boolean;
  sigmaSource?: "declared" | "estimated";
};

export type Landscape = {
  x: string; y: string; held: string;
  xs: number[]; ys: number[];
  /** Best χ²/N in each cell, row-major from the lowest y. */
  chi2: number[];
  log: boolean;
};

export type SensitivityResult = {
  names: string[];
  singular: number[];
  vectors: number[][];
  kinds: ("identifiable" | "structural" | "practical")[];
  condition: number;
  marginal: Record<string, number>;
  identified: string[];
  nonIdentified: string[];
  /** Identified combinations (only when something is not identified). */
  combos: { name: string; value: number; logStd: number }[];
};

export type Fit = {
  n: number;
  state: "converged" | "running" | "failed";
  variant: string | null;
  measurements: string[];
  free: string[];
  fixed: Params;
  initial: Params;
  params: Params;
  chi2N: number;
  evals: number;
  starts: number;
  /** Distinct minima among the starts; null when the source did not record them. */
  basins: number | null;
  loss: "linear" | "soft_l1";
  /** Lag-1 autocorrelation of the residuals per measurement. */
  lag1: Record<string, number>;
  /** The path of the best start, from the initial guess to the result. */
  trail: Params[];
  sensitivity: SensitivityResult | null;
  landscape: Landscape | null;
  /** The model's output on each fitted measurement's drive, at the result and at the initial guess. */
  curves: Record<string, { t?: number[]; fit: number[]; initial: number[] }>;
  /** Steady-state gain and phase against frequency, when the fit includes a sine measurement. */
  frequency: FrequencyResponse | null;
  seed: number;
  /**
   * What the SDK's identifiability rule concluded at this fit, when only its summary was
   * recorded (the daemon's step records carry no singular values or vectors). Null otherwise.
   * `marginal` is each identified parameter's one-sigma log uncertainty, absent from records
   * written before the SDK recorded it.
   */
  identification?: { identified: string[]; nonIdentified: string[]; condition: number | null; marginal?: Record<string, number> } | null;
  /**
   * Why the SDK recorded no identifiability check for this fit, when it said so (the
   * simulation budget ran out, or the check failed). Absent otherwise.
   */
  identificationSkipped?: string;
};

export type GainPhase = { gain: number; phase: number };
export type FrequencyResponse = {
  frequencies: number[];
  fit: GainPhase[];
  initial: GainPhase[];
  /** One point per sine measurement, read from its data. */
  points: ({ measurement: string; frequency: number } & GainPhase)[];
};

export type ProposalField = { name: string; label: string; unit: string; value: number; original: number; lo: number; hi: number };

export type RankedCandidate = { label: string; score: number; proposal: boolean; after?: Record<string, number | null> };

/**
 * One agent step as its record states it: the decision's action, hypothesis, evidence and expected
 * information, or the error that made it unusable. `n` counts steps from the investigation's start.
 */
export type TraceStep = { n: number; action: string; hypothesis: string; evidence: string[]; expected: string; error?: string };

export type Proposal = {
  id: string;
  experiment: ExperimentKind;
  /** The fit it was ranked at. */
  atFit: number;
  fields: ProposalField[];
  /** Settings of the experiment that are not editable (x0, start …). */
  fixedSettings: Settings;
  status: "proposed" | "approved" | "rejected";
  decidedBy: string | null;
  decidedAt: string | null;
  hypothesis: string;
  /** Ranking against the catalog's other candidates at `atFit`; the proposal's own row is recomputed on edit. */
  ranking: RankedCandidate[];
  /** Parameters not identified before the experiment, and their expected 1σ (log) after it; null stays unbounded. */
  expected: { param: string; after: number | null; before?: "unknown" }[];
  /** Where the SDK will send the data from. */
  dataFrom: string;
  /** The drive as proposed and the response the ranking fit predicts for it. */
  preview: { t: number[]; input: number[] | null; predicted: number[] };
  /**
   * The proposal's score and expected 1σ (log) of each parameter not yet identified, over a grid
   * of its editable settings: at most three axes, values ascending, arrays row-major (the last
   * axis varies fastest). The client interpolates it at edited settings; it never re-ranks.
   * A non-finite `after` value means that parameter stays unbounded there.
   */
  outlook: ProposalOutlook;
  /** Whether the SDK attached the approved experiment's data (the daemon's data_attached); absent: inferred from the measurements. */
  delivered?: boolean;
  /** The agent steps that led to this proposal, oldest first; the last is the proposing step. Absent: not recorded. */
  trace?: TraceStep[];
};

export type ProposalOutlook = { axes: { name: string; values: number[] }[]; score: number[]; after: Record<string, number[]> };

export type Validation =
  | { state: "needs-data"; recorded?: boolean }
  | { state: "passed" | "failed"; measurement: string; fit: number; chi2N: number; threshold: number; worst: { param: string; relative: number }; predicted: number[] }
  /** The outcome's held-out check as recorded by the SDK: no predicted series, no worst parameter. */
  | { state: "summary"; passed: boolean; chi2N: number; threshold: number; measurements: string[] };

/** SDK/evaluator results, revealed only after the outcome. Never re-score in the UI. */
export type Reveal = {
  source: string; tolerance: number; truth: Params; estimate: Params; fit_id: number;
  quantities: { name: string; truth: number; estimate: number; ratio: number; sigma_ratio: number | null; within: boolean; identifiable: boolean }[];
};

export type Investigation = {
  id: string;
  name: string;
  projectId: string;
  configVersion: number;
  free: string[];
  host: string;
  seed: number;
  state: "awaiting-approval" | "awaiting-data" | "awaiting-agent" | "running" | "validated" | "inconclusive";
  /** Agent steps while running. */
  progress: { done: number; total: number } | null;
  updated: string;
  budget: { steps: number; simulations: number; experiments: number };
  measurements: Measurement[];
  fits: Fit[];
  proposals: Proposal[];
  validation: Validation;
  reveal?: Reveal;
};

export type Project = { id: string; name: string; configs: ProjectConfig[]; investigations: Investigation[] };

export type Workspace = { user: string; projects: Project[] };

/** A device waiting for the operator to approve its pairing (O-3): never a key. */
export type Pairing = { code: string; device: string; client: string; expires: string };
