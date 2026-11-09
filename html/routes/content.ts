/**
 * The product copy the cookbook shows around the app: the pitch deck on the landing, and the
 * recorded experiments. The workbench opens directly on the account's server data.
 */
import type { Cookbook } from "@tento-cookbook/lib.ts";
import { MUSE_AVATAR } from "./loops-figure.ts";

/** Illustrative product charts use MOCK (design handoff, 2026-11-04).
 * Their markers distinguish them from the recorded runs on the experiments slide.
 * Replace each mock chart with real runs before dropping its marker. */
const MOCK = "mock data";

/** The calibration pitch: hero, user, costly task, alternative, demo, advantage,
 * workflow, other applications, then the team and the recorded experiments. */
const g = (q: number, m: number, w: number) => Math.exp(-(((q - m) / w) ** 2));
const info = Array.from({ length: 101 }, (_, i) => Math.min(1, 0.12 + 0.88 * g(i, 12, 7) + 0.55 * g(i, 88, 8) + 0.3 * g(i, 50, 10)));

/** Line icons for the use-case wall: 24 px viewBox, drawn with the cookbook's stroke. */
const ICONS = {
  battery: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10.5v3M7 10v4M10 10v4"/>',
  spring: '<path d="M12 2v3M8 5h8M8 5l8 2.5-8 2.5 8 2.5-8 2.5"/><rect x="7" y="16" width="10" height="6" rx="1.5"/>',
  thermometer: '<path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/>',
  pill: '<rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-35 12 12)"/><path d="M9.7 8.8l4.6 6.4"/>',
  motor: '<circle cx="11" cy="12" r="7"/><circle cx="11" cy="12" r="2"/><path d="M18 12h4M11 5V3"/>',
  bridge: '<path d="M2 18h20M4 18v-4M20 18v-4M2 14h20M6 14l6-7 6 7M12 7v7"/>',
  exchanger: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h4c2 0 2 4 4 4s2-4 4-4 2 4 4 4h2"/>',
  chain: '<rect x="2.5" y="9" width="8" height="6" rx="3"/><rect x="13.5" y="9" width="8" height="6" rx="3"/><path d="M8 12h8"/>',
  stack: '<rect x="4" y="4" width="4" height="16" rx="1"/><rect x="10" y="4" width="4" height="16" rx="1"/><rect x="16" y="4" width="4" height="16" rx="1"/>',
  layers: '<path d="M2 8h20M2 13h20M2 18h20"/><path d="M12 3v15M10 16l2 2 2-2"/>',
  beaker: '<path d="M6 3h12M7 3v15a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V3"/><path d="M7 11h10M10 15h.01M14 17h.01M12 13.5h.01"/>',
  fan: '<circle cx="12" cy="12" r="1.5"/><path d="M12 10.5C12 6 9 4 7.5 5.5S9 10 12 10.5zM13.5 12c4.5 0 6.5-3 5-4.5S14 9 13.5 12zM12 13.5c0 4.5 3 6.5 4.5 5S15 14 12 13.5zM10.5 12C6 12 4 15 5.5 16.5S10 15 10.5 12z"/>',
  solar: '<path d="M5 5h14l2 10H3z"/><path d="M4 10h16M9.5 5l-1 10M14.5 5l1 10M12 15v4M8 19h8"/>',
  tank: '<rect x="6" y="3" width="12" height="18" rx="5"/><circle cx="10.5" cy="14" r="1"/><circle cx="13.5" cy="10" r="1"/><circle cx="12" cy="17" r=".6"/>',
};

/** Line icons for the loop slides' steps (24 px, stroked by the cookbook). */
const LOOP_ICONS = {
  score: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  keep: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  record: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".8"/><circle cx="4" cy="12" r=".8"/><circle cx="4" cy="18" r=".8"/>',
  distil: '<rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  reinforce: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8"/>',
};

/** The inner loop: one investigation, as both loop slides draw it. */
const INVESTIGATION = {
  title: "One investigation",
  caption: "Inner loop · Muse Spark",
  avatar: MUSE_AVATAR,
  steps: ["Fit", "Identifiability", "Rank tests", "Run a test"] as [string, string, string, string],
  note: "until identified or out of budget",
};

export function deck(app: Cookbook.App, appPath = "/app"): Cookbook.Deck.Slide[] {
  const open = { label: "Open the workbench", href: appPath };
  const rest = (n: number) =>
    Array.from({ length: n }, () => [
      { label: "", value: "", share: 1.06 },
      { label: "", value: "", share: 2.74, emphasis: true },
    ]).flat();
  const ribbon = rest(10);
  ribbon[1].label = "Rest";
  return [
    {
      eyebrow: { icon: "mark" },
      title: `Muse Spark plans the experiment. ${app.title} checks the claim.`,
      description: `Spark proposes the next test, ranked by what it would separate. Code checks every claim; in the workbench, a person approves every test.
      (Product charts: ${MOCK}; experiment results are labeled separately.)`,
      body: {
        kind: "actions",
        primary: open,
        stats: [
          // examples.md, live model runs: Spark and Wonder each passed 8 of 8 (scripted did too).
          { value: "8 / 8", label: "live runs passed by Muse Spark 1.3, and by Muse Wonder 1.0" },
          { value: "±10% at 1σ", label: "bar for “identified”, from sensitivity analysis" },
          { value: "every test", label: "approved by a person in the workbench" },
        ],
      },
    },
    {
      eyebrow: { label: "The user" },
      title: "Engineers and scientists who rely on physics-based models.",
      description: "Before these models can guide design or control, they must be calibrated and validated for each new system, material, or operating regime.",
      body: { kind: "person", name: "Joseph Lucero", role: "Chemistry PhD student, Stanford · lithium iron batteries · our teammate" },
    },
    {
      eyebrow: { label: `The costly task · ${MOCK}` },
      title: "Physics-based models are calibrated on expensive experiments.",
      description: "Characterizing these models takes time, effort, and money. Reducing experiments to the minimum set needed creates direct savings for any company that relies on them.",
      body: {
        kind: "breakdown",
        stats: [
          { value: ">24 h", label: "to characterize battery behavior across states of charge" },
          { value: ">75%", label: "of that time spent resting" },
          { value: "≥3", label: "temperatures requiring characterization" },
        ],
        segments: ribbon,
      },
    },
    {
      eyebrow: { label: `The existing alternative · ${MOCK}` },
      title: "Today: run a fixed experimental campaign, then calibrate the model.",
      description: "The process is standard, comparable, and supported by mature tools. But every condition is fixed before the first measurement reveals what the model still needs.",
      body: {
        kind: "profile",
        axis: ["0% SOC", "50%", "100% SOC"],
        curve: { label: "Information each pulse would add (Fisher)", values: info },
        fixed: { label: "Today: 11 fixed pulses", at: Array.from({ length: 11 }, (_, i) => i / 10) },
        picks: { label: "autophys: 4 ranked pulses", at: [0.12, 0.88, 0.5, 0.06] },
      },
    },
    {
      eyebrow: { label: `The demo · ${MOCK}` },
      title: "One experiment reveals which physical parameters remain confounded. The next identifies them.",
      description: "Fisher ranking scores the next experiment, and Muse Spark explains which physical uncertainty it resolves. You edit the proposal, watch it re-score, and approve.",
      body: {
        kind: "uncertainty",
        axes: ["Diffusivity", "Reaction rate"],
        target: { label: "±10%", size: 0.34 },
        regions: [
          { label: "After experiment 1: confounded (ρ 0.96)", rx: 0.96, ry: 0.12, angle: 40 },
          { label: "After experiment 2: identified", rx: 0.24, ry: 0.17, angle: 15, emphasis: true },
        ],
      },
    },
    {
      eyebrow: { label: "Experimental · Muse Spark 1.3, live, one seed" },
      title: "What Muse Spark found, and what it could not claim.",
      description: `Six hidden test cases: calibration alone versus Muse Spark driving ${app.title}.`,
      // Recorded run, not mock: discovery-harness.md, Muse Spark 1.3 pass, seed 0
      // (2026-11-08), held-out RMSE and outcome per case, bare arm versus full arm.
      body: {
        kind: "cases",
        axis: { label: "Held-out RMSE, log scale (lower is better)", min: 0.03, max: 10, ticks: [0.03, 0.1, 0.3, 1, 3, 10], log: true },
        legend: ["Calibration alone", `Muse Spark + ${app.title}`],
        rows: [
          { label: "Planted lag", base: 0.57, value: 0.05, outcome: "Found", emphasis: true },
          { label: "Transport delay", base: 0.35, value: 0.07, outcome: "Not identified" },
          { label: "Quantized offset", base: 0.32, value: 0.25, outcome: "Inconclusive" },
          { label: "Null twin", base: 0.05, value: 0.05, outcome: "Inconclusive" },
          { label: "Out of grammar", base: 0.29, value: 0.39, outcome: "Inconclusive" },
          { label: "Planted offset", base: 0.30, value: 7.08, outcome: "No wrong claim", emphasis: true },
        ],
        note: "One seed, not a benchmark. Calibration alone made one wrong claim; Spark made none. Discovery is not in this release.",
      },
    },
    {
      eyebrow: { label: "Get started" },
      title: "Try it in your browser.",
      description: "Nothing to install, and no account. The hosted workbench opens a demo workspace of example investigations.",
      // Stepping onto this slide opens the app and its tutorial (as the down arrow does).
      opensApp: true,
      body: {
        kind: "browser",
        url: "https://autophys.lona.so/app",
        steps: [
          { title: "Open an example investigation", detail: "Its measurements, fits and proposals are listed under it." },
          { title: "Read the verdict", detail: "Which parameters the data pins down to ±10%, and which sit on a ridge." },
          { title: "Approve the next test", detail: "Edit the proposed settings if you like, then approve or reject it." },
        ],
        primary: { label: "Open the workbench", href: appPath },
      },
    },
    {
      eyebrow: { label: `How Muse decides · ${MOCK}` },
      title: "Muse Spark reasons about what to measure next.",
      description: "Every number it repeats comes from an autophys tool. It can propose a test; only you can approve one.",
      body: {
        kind: "chat",
        agent: { name: "Muse Spark", avatar: MUSE_AVATAR },
        messages: [
          { from: "user", text: "Calibrate this cell from pulses.csv. What should I test next?" },
          { from: "agent", source: "fit · identifiability", text: "R0 and C1 are within ±10%. R1 is at ±61%." },
          { from: "agent", text: "The 6 s pulse is too short to tell R1 from C1." },
          { from: "agent", source: "rank_experiments", text: "A 30 s pulse at 2 A scores 4.1 and fits the 3 h budget." },
        ],
        approval: {
          label: "In your autophys workbench · needs approval",
          title: "Pulse at 2 A",
          rows: [
            { label: "Current", value: "2 A for 30 s" },
            { label: "Cost", value: "1.08 of 3 test h" },
            { label: "Resolves", value: "R1 ↔ C1" },
          ],
          actions: ["Approve", "Edit", "Reject"],
        },
      },
    },
    {
      eyebrow: { label: "The autoloop" },
      title: "Two loops: one investigates, one improves it.",
      description: "The inner loop calibrates a physics-based model. The outer loop edits its playbook and keeps only the edits that score better.",
      body: {
        kind: "loops",
        inner: INVESTIGATION,
        outer: {
          top: { title: "Muse Wonder", caption: "proposes a playbook edit", avatar: MUSE_AVATAR },
          bottom: { title: "Keep it if better", caption: "otherwise discard it", icon: LOOP_ICONS.keep, emphasis: true },
          left: { title: "Score", caption: "answer, error, cost", icon: LOOP_ICONS.score },
        },
      },
      builds: [
        {
          eyebrow: { label: "Post-training" },
          title: "Then train the model that runs it.",
          description: "Every investigation is training data: the policy copies the expert first, then learns from what scores best.",
          body: {
            kind: "feedback",
            inner: { ...INVESTIGATION, badge: "improves" },
            steps: [
              { title: "Record each step", caption: "state and decision", icon: LOOP_ICONS.record },
              { title: "Distil", tag: "today", caption: "copy the scripted expert", icon: LOOP_ICONS.distil, emphasis: true },
              { title: "Reinforce", tag: "planned", caption: "reward the hidden-truth score", icon: LOOP_ICONS.reinforce, planned: true },
            ],
            back: "new weights",
          },
        },
      ],
    },
    {
      eyebrow: { label: "Beyond batteries" },
      title: "Any lab with a simulator and an expensive test.",
      description: "Each has parameters its usual tests can't tell apart. One simulator per field; the fit, checks and workbench carry over.",
      body: {
        kind: "uses",
        uses: [
          { icon: ICONS.spring, name: "Mechanisms", pair: "mass ↔ stiffness", choice: "Forcing frequency", live: true, emphasis: true},
          { icon: ICONS.battery, name: "Battery cells", pair: "R1 ↔ C1", choice: "Which pulse or discharge", note: "The example in this deck.", live: true },
          { icon: ICONS.thermometer, name: "Thermal enclosures", pair: "capacity ↔ resistance", choice: "Step or pulse heating", live: true },
          { icon: ICONS.flask, name: "Reaction kinetics", pair: "A ↔ Ea", choice: "Reactor temperature" },
          { icon: ICONS.pill, name: "Pharmacokinetics", pair: "clearance ↔ volume", choice: "When to draw samples", note: "Each sample is a blood draw." },
          { icon: ICONS.motor, name: "Electric motors", pair: "R ↔ L", choice: "Step or frequency sweep" },
          { icon: ICONS.bridge, name: "Structures", pair: "stiffness ↔ damping", choice: "Where to excite and sense", note: "Each setup means moving sensors." },
          { icon: ICONS.exchanger, name: "Heat exchangers", pair: "fouling ↔ film coefficient", choice: "Which flow rate" },
          { icon: ICONS.chain, name: "Polymers", pair: "modulus ↔ relaxation time", choice: "Load ramp rate" },
          { icon: ICONS.stack, name: "Fuel cells", pair: "exchange current ↔ transfer coefficient", choice: "Which polarization point", note: "Each point takes minutes to settle." },
          { icon: ICONS.layers, name: "Soil and aquifers", pair: "permeability ↔ storage", choice: "Pumping schedule" },
          { icon: ICONS.beaker, name: "Drug formulation", pair: "dissolution ↔ permeability", choice: "Which media and pH" },
          { icon: ICONS.fan, name: "HVAC zones", pair: "air exchange ↔ thermal mass", choice: "Setpoint step" },
          { icon: ICONS.solar, name: "Photovoltaics", pair: "series ↔ shunt resistance", choice: "Irradiance level" },
          { icon: ICONS.tank, name: "Bioreactors", pair: "growth rate ↔ yield", choice: "Feed rate" },
        ],
        legend: { live: "Runs in autophys today", other: "Others need their own simulator" },
      },
    },
    {
      eyebrow: { label: "Introductions" },
      title: "Meet the team.",
      description: "A founder and a researcher building better tools for physical modeling.",
      body: {
        kind: "actions",
        primary: null,
        stats: [
          { value: "James Kao", label: "Ex-FAANG · Founder" },
          { value: "Joseph Lucero", label: "Stanford chemistry PhD student · lithium iron batteries" },
        ],
      },
    },
    {
      eyebrow: { label: "APIs & model experiments · recorded runs" },
      title: "What we ran, and what we learned.",
      description: "Synthetic tasks, real runs. Meta’s direct API is wired; Spark has no measured result here.",
      // Sources: project sdk.md (live Muse smoke and autoloop), train/sft/README.md.
      // Muse used the coding plan; the autoloop's inner policy was a fake reasoner.
      // These are capability checks, not the mock battery benchmark above.
      body: {
        kind: "comparison",
        columns: ["Experiment", "Outcome"],
        rows: [
          { label: "Muse Code", before: "Wonder 1.0 · MCP tools & playbook edits", after: "Tools ran; one edit kept on a planted case." },
          { label: "Modal", before: "Qwen3.5-4B · LoRA training", after: "4/8 closed-loop; never chose an experiment." },
          { label: "Baseten Loops", before: "Qwen3.8-27B · 36 training updates", after: "Trained; not yet served or evaluated." },
        ],
      },
    },
  ];
}
