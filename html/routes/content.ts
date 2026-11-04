/**
 * The product copy the cookbook shows around the app: the pitch deck on the landing, and the
 * tutorial steps, which point into the slots by the ui's stable ids and classes. (The
 * cookbook's own steps cover its chrome.)
 */
import type { Cookbook } from "@tento-cookbook/lib.ts";

/** Every number in the deck below is MOCK, invented to show the charts (handoff from
 * autophys/design, 2026-11-04). The marker shows on each slide that carries numbers, so
 * nothing reads as measured; replace with real runs and drop it. `grep -n MOCK` finds them. */
const MOCK = "mock data";

/** The battery pitch, in the hacks.lona.so order: hero, user, costly task, alternative, demo,
 * advantage, then where the same contract goes next. */
const decay = (a: number, tau: number, floor: number, until = 40) =>
  Array.from({ length: 81 }, (_, i) => i * until / 80).map((t) => [t, a * Math.exp(-t / tau) + floor] as [number, number]);
const cross = (a: number, tau: number, floor: number, at = 10) => tau * Math.log(a / (at - floor));
const series = (label: string, a: number, tau: number, floor: number, emphasis = false) => {
  const t = cross(a, tau, floor);
  return { label, points: decay(a, tau, floor), emphasis, marker: { at: [t, 10] as [number, number], label: `${t.toFixed(1)} h` } };
};
const g = (q: number, m: number, w: number) => Math.exp(-(((q - m) / w) ** 2));
const info = Array.from({ length: 101 }, (_, i) => Math.min(1, 0.12 + 0.88 * g(i, 12, 7) + 0.55 * g(i, 88, 8) + 0.3 * g(i, 50, 10)));

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
      title: `${app.title}: battery models in fewer test hours`,
      description: `Runs only the tests that pin down your cell model. Muse Spark directs it, and code checks every claim. (Figures in this deck: ${MOCK}.)`,
      body: {
        kind: "actions",
        primary: open,
        stats: [
          { value: "6.8×", label: "fewer test hours to a validated model" },
          { value: "12", label: "held-out cells in the benchmark" },
          { value: "±10%", label: "bar for “identified”, enforced in code" },
        ],
      },
    },
    {
      eyebrow: { label: "The user" },
      title: "Battery researchers who fit a model to every new cell.",
      description: "A pack design or BMS can't use the model until it's trusted, so every new cell is characterized first.",
      body: { kind: "person", name: "A Stanford battery researcher", role: "Physics PhD, Stanford · our teammate" },
    },
    {
      eyebrow: { label: `The costly task · ${MOCK}` },
      title: "Pulse-test grids that spend most of their hours resting.",
      description: "An HPPC run pulses the cell at a fixed ladder of charge levels and rests before each pulse. Every step runs, whatever it shows.",
      body: {
        kind: "breakdown",
        stats: [
          { value: "38 h", label: "per HPPC grid" },
          { value: "72%", label: "of it resting" },
          { value: "4", label: "grids per cell" },
        ],
        segments: ribbon,
      },
    },
    {
      eyebrow: { label: `The existing alternative · ${MOCK}` },
      title: "Today: run the full grid, then fit it in PyBaMM or MATLAB.",
      description: "Standard, comparable across labs, and the tools are mature. But the grid is fixed before the first pulse comes back.",
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
      title: "One pulse in: “R1 and C1 are tied.” One more: validated.",
      description: "Fisher ranking scores the next pulse, and Muse Spark explains and requests it. You edit it, watch it re-score, and approve.",
      body: {
        kind: "uncertainty",
        axes: ["R1", "C1"],
        target: { label: "±10%", size: 0.34 },
        regions: [
          { label: "After pulse 1: tied (ρ 0.96)", rx: 0.96, ry: 0.12, angle: 40 },
          { label: "After pulse 2: identified", rx: 0.24, ry: 0.17, angle: 15, emphasis: true },
        ],
      },
    },
    {
      eyebrow: { label: `The advantage · ${MOCK}` },
      title: "Fewer test hours to the same validated model.",
      description: "Four approaches on the same held-out cells, with the truth hidden from the agent. Done means every parameter within ±10%.",
      body: {
        kind: "lines",
        x: { label: "Test hours", min: 0, max: 40, ticks: [0, 10, 20, 30, 40], unit: " h" },
        y: { label: "Worst parameter error", min: 0, max: 60 },
        threshold: { value: 10, label: "±10%: identified" },
        series: [
          series("Full HPPC grid", 55, 19.7, 2),
          series("Scripted numerics", 55, 11.5, 2),
          series("Muse Spark, base skill", 55, 5.2, 2),
          series("Muse Spark, tuned skill", 55, 3.1, 2, true),
        ],
      },
    },
    {
      eyebrow: { label: "Beyond batteries" },
      title: "Any lab with a simulator and an expensive test.",
      description: "One @ap.simulator per domain. The top three run today.",
      body: {
        kind: "comparison",
        columns: ["Tangled parameters", "Next test it picks"],
        rows: [
          { label: "Battery cell", before: "R1 ↔ C1", after: "Which pulse or discharge" },
          { label: "Mechanism", before: "Mass ↔ stiffness", after: "Forcing frequency" },
          { label: "Enclosure", before: "Capacity ↔ resistance", after: "Step or pulse heating" },
          { label: "Kinetics", before: "A ↔ Ea", after: "Reactor temperature" },
        ],
      },
    },
  ];
}

export const tutorial = [
  { title: "Pick a project", body: "Each project is one simulator and its configuration. The switcher is at the top of the sidebar.", target: ["#ap-switch"] },
  { title: "Open an investigation", body: "Its measurements, fits, sensitivity, proposals and validation are rows under it.", target: ["std-tree-list.ap-tree:not(.ap-pinned)"] },
  { title: "Read a fit", body: "Each fit opens into its views: Fit, Residuals, Landscape and whatever its experiments ask for.", target: [".ap-viewer"] },
  { title: "Decide the next experiment", body: "Edit the proposed settings if you like, then approve or reject it.", target: ["#ap-action-approve", ".ap-decision"] },
] as const;
