/** Read-only configuration content shared by Main and Details. */
import type { ProjectConfig } from "../domain.ts";
import type { Section } from "../../ui/view-model.ts";
import { engineering, int, sig } from "./fmt.ts";

const specOutput = (c: ProjectConfig, channel: string) => c.catalog.find((e) => e.output.name === channel)?.output.unit ?? "";

export function configurationSections(c: ProjectConfig): Section[] {
  return [
      { heading: "Parameters", blocks: [{ kind: "table", rows: c.params.map((p) => ({ cells: [{ text: p.name }, { text: `${engineering(p.lo, p.unit)} … ${engineering(p.hi, p.unit)}`, end: true },
        { text: "", tag: p.fixed ? { text: "fixed", tone: "muted" } : { text: "free" }, end: true }] })) }] },
      { heading: "Experiments", blocks: c.catalog.map((e) => ({ kind: "facts", rows: [
        { label: e.label, value: e.maxRuns == null ? "" : `Up to ${e.maxRuns} runs` },
        ...e.settings.filter((setting) => ["current", "duration", "rate", "amplitude", "frequency", "freq"].includes(setting.name)).map((setting) => ({ label: setting.label.charAt(0).toUpperCase() + setting.label.slice(1), value: engineering(setting.default, setting.unit || ({ current: "A", duration: "s", rate: "Hz", frequency: "Hz", freq: "Hz" } as Record<string, string>)[setting.name] || "") })),
      ] })) },
      { heading: "Noise", blocks: [{ kind: "facts", rows: [
        ...Object.entries(c.noise.sigma).map(([k, v]) => ({ label: `σ ${k}`, value: `${sig(v, 2)} ${specOutput(c, k)}` })),
        { label: "Estimate scale", value: c.noise.estimate ? "yes" : "no" }, { label: "Sensor bias", value: c.noise.bias }] }] },
      { heading: "Budget", blocks: [{ kind: "facts", rows: [{ label: "Agent steps", value: String(c.budgets.maxSteps) }, { label: "Simulations", value: int(c.budgets.maxSimulations) },
        { label: "Experiments", value: String(c.budgets.maxExperiments) }, { label: "Policy", value: c.policy.label }] }] },
  ];
}
