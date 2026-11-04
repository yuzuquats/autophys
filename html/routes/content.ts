/**
 * The product copy the cookbook shows around the app: the pitch deck on the landing, and the
 * tutorial steps, which point into the slots by the ui's stable ids and classes. (The
 * cookbook's own steps cover its chrome.)
 */
import type { Cookbook } from "@tento-cookbook/lib.ts";

/** Marks a fact that needs a real run or the partner's numbers. Nothing written with it may be
 * presented as measured; `grep -n "TBD" html/routes/content.ts` lists what is still open. */
const TBD = "TBD";

/** Bars whose values are still TBD get equal lengths, so no proportion reads as measured. */
const even = (labels: string[], emphasis?: string) =>
  labels.map((label) => ({ label, value: TBD, share: Math.round(100 / labels.length), emphasis: label === emphasis }));

/** The battery pitch, in the hacks.lona.so order: hero, user, costly task, alternative, demo,
 * advantage, then where the same contract goes next. */
export function deck(app: Cookbook.App, appPath = "/app"): Cookbook.Deck.Slide[] {
  const open = { label: "Open the workbench", href: appPath };
  return [
    {
      eyebrow: { icon: "mark" },
      title: `${app.title}: battery models in fewer test hours`,
      description: "Runs only the tests that pin down your cell model. Muse Spark directs; a code guardrail checks every claim.",
      body: {
        kind: "actions",
        primary: open,
        stats: [
          { value: TBD, label: "fewer test hours to a validated model" },
          { value: TBD, label: "held-out cells in the benchmark" },
          { value: "±10%", label: "bar for “identified”, enforced in code" },
        ],
      },
    },
    {
      eyebrow: { label: "The user" },
      title: "Battery researchers who fit a model to every new cell.",
      description: "The model must be trustworthy before a pack design or BMS uses it, so each new cell is characterized first.",
      body: { kind: "person", name: "A Stanford battery researcher", role: "Physics PhD, Stanford · our teammate" },
    },
    {
      eyebrow: { label: "The costly task" },
      title: "Pulse-test grids that spend most of their hours resting.",
      description: "An HPPC run pulses the cell at a fixed ladder of charge levels, resting before each. Every step runs regardless.",
      body: {
        kind: "breakdown",
        stats: [
          { value: TBD, label: "hours per HPPC grid" },
          { value: TBD, label: "of it resting" },
          { value: TBD, label: "grids per cell" },
        ],
        segments: even(["Setup", "Step charge", "Rest", "Pulse and fit"], "Rest"),
      },
    },
    {
      eyebrow: { label: "The existing alternative" },
      title: "Today: the full grid, fitted afterwards in PyBaMM or MATLAB.",
      description: "Standard, comparable across labs, mature tools. But the grid is fixed before the first pulse is seen.",
      body: {
        kind: "comparison",
        columns: ["Today", "With autophys"],
        rows: [
          { label: "Plan", before: "Fixed ladder", after: "Ranked by Fisher information" },
          { label: "Trust", before: "Low residuals", after: "±10% rule, enforced in code" },
          { label: "Next test", before: "The next step", after: "Muse Spark directs; you approve" },
          { label: "Learns", before: "Same every cell", after: "Muse Wonder tunes the playbook (in build)" },
        ],
      },
    },
    {
      eyebrow: { label: "The demo" },
      title: "One pulse in: “R1 and C1 are tied.” One more: validated.",
      description: "Fisher ranking scores the next pulse; Muse Spark explains and requests it. You edit, watch it re-score, approve.",
      body: { kind: "demo", caption: "Live in the workbench: open it and follow the tour." },
    },
    {
      eyebrow: { label: "The advantage" },
      title: "Fewer test hours to the same validated model.",
      description: "Same held-out cells, four ways, truth hidden from the agent. Done means every parameter ±10% and validation passed.",
      body: {
        kind: "result",
        bars: even(["Full HPPC grid", "Scripted numerics", "Muse Spark, base skill", "Muse Spark, tuned skill"], "Muse Spark, tuned skill"),
        primary: open,
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
          { label: "Pharmacokinetics", before: "Absorption ↔ elimination", after: "Blood-draw times" },
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
