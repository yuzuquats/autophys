/** Browser project draft and its already-derived vertical stepper. */
import type { Snapshot, ProjectSetup, CreatedProject } from "../api.ts";
import type { DetailsModel, Field } from "../../ui/view-model.ts";

export type SetupSession = {
  step: number;
  draft: Record<keyof ProjectSetup, string>;
  created?: CreatedProject;
  busy: boolean;
  notice?: string;
};
export const beginSetup = (_snap: Snapshot): SetupSession => ({
  step: 1, busy: false,
  draft: { name: "Thermal experiment", model: "thermal_rc", c: "400", r: "1.5", power: "10", duration: "600" },
});
export function setupRequest(session: SetupSession): ProjectSetup {
  const d = session.draft;
  if (!d.name.trim() || d.name.trim().length > 120) throw new Error("Enter a project name of 1–120 characters.");
  const body = { name: d.name.trim(), model: d.model, c: Number(d.c), r: Number(d.r), power: Number(d.power), duration: Number(d.duration) };
  for (const [key, lo, hi] of [["c", 10, 1e5], ["r", 0.01, 100], ["power", 0.1, 100], ["duration", 10, 3600]] as const) {
    if (!d[key].trim() || !Number.isFinite(body[key]) || body[key] < lo || body[key] > hi)
      throw new Error(`${key === "c" ? "C" : key === "r" ? "R" : key}: use a value from ${lo} to ${hi}.`);
  }
  return body;
}
export function setupBody(session: SetupSession, _snap: Snapshot, _origin: string) {
  const field = (name: keyof ProjectSetup, label: string, unit?: string): Field => ({ name: `setup:${name}`, label, unit, value: session.draft[name] });
  return {
    kind: "project-setup" as const, title: "New project", notice: session.notice,
    description: "Create a thermal simulator and run a simulated investigation on this daemon. No SDK or API key needed.",
    steps: [
      { title: "Choose your model", done: session.step > 1, current: session.step === 1,
        description: "Thermal RC · C dT/dt = power − (T − 20°C) / R. This built-in model uses simulated measurements from a reference specimen.",
        fields: session.step === 1 ? [field("name", "Project name")] : [],
        actions: session.step === 1 ? [{ name: "setup-next", label: "Continue", variant: "primary" as const }] : [] },
      { title: "Set parameters and experiment", done: !!session.created, current: session.step === 2,
        description: "Initial guesses: C in 10–100,000 J/K; R in 0.01–100 K/W. The step experiment accepts 0.1–100 W and 10–3,600 s. Sampling: 0.2 Hz; temperature noise: 0.05°C.",
        fields: session.step === 2 ? [field("c", "Heat capacity C", "J/K"), field("r", "Thermal resistance R", "K/W"), field("power", "Step power", "W"), field("duration", "Duration", "s")] : [],
        actions: session.step === 2 ? [{ name: "setup-back", label: "Back" }, { name: "setup-create", label: session.busy ? "Creating…" : "Create project", variant: "primary" as const }] : [] },
      { title: "Run the investigation", done: false, current: session.step === 3,
        description: session.created
          ? `${session.draft.name} is saved. The scripted policy fits simulated data, proposes one experiment for your approval, then fits and validates the result. Runs stop after 12 steps or 30 minutes waiting for approval. Keep this daemon running; runs do not resume after a daemon restart.`
          : "Save the configuration, then start the daemon’s built-in scripted policy.",
        fields: [],
        actions: session.step === 3 ? [{ name: "setup-start", label: session.busy ? "Starting…" : "Start investigation", variant: "primary" as const }] : [] },
    ].map(step => ({ ...step, actions: step.actions.map(a => ({ ...a, disabled: session.busy })) })),
  };
}
export function setupDetails(session: SetupSession, _snap: Snapshot, _origin: string, notice?: string): DetailsModel {
  return { icon: "workspace", title: "New project", status: { text: `Step ${session.step} of 3` },
    sections: [
      ...(notice ? [{ heading: "Not saved", blocks: [{ kind: "text" as const, text: notice, tone: "danger" as const }] }] : []),
      { heading: "Runs on this daemon", blocks: [{ kind: "text", text: "Thermal RC simulator · scripted policy · simulated measurements. No credentials or device pairing required. SDK projects and real devices remain available separately." }] },
    ] };
}
