/** Read-only configuration content shared by Main and Details. */
import type { Channel, ProjectConfig, SettingSpec } from "../domain.ts";
import type { Section } from "../../ui/view-model.ts";
import { engineering, int, sig } from "./fmt.ts";

const specOutput = (c: ProjectConfig, channel: string) => c.catalog.find((e) => e.output.name === channel)?.output.unit ?? "";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Word labels are capitalised; symbols such as x or T are kept as written. */
const channel = (ch: Channel) => `${ch.label.length > 2 ? cap(ch.label) : ch.label}${ch.unit ? ` (${ch.unit})` : ""}`;
const settingUnit = (s: SettingSpec) => s.unit || ({ current: "A", duration: "s", rate: "Hz", frequency: "Hz", freq: "Hz" } as Record<string, string>)[s.name] || "";

/** One card per experiment: a caption with its channels and run limit, then each setting's default and allowed range. */
export function experimentSections(c: ProjectConfig): Section[] {
  return c.catalog.map((e) => ({
    heading: e.label,
    blocks: [
      { kind: "text", text: [e.input ? `${channel(e.input)} → ${channel(e.output)}` : `Measures ${channel(e.output)}`, e.maxRuns == null ? "" : `up to ${e.maxRuns} runs`].filter(Boolean).join(" · ") },
      ...(e.settings.length ? [{ kind: "table" as const, rows: [
        { dim: true, cells: [{ text: "Setting" }, { text: "Default", end: true }, { text: "Allowed", end: true }] },
        ...e.settings.map((s) => ({ cells: [{ text: cap(s.label) }, { text: engineering(s.default, settingUnit(s)), end: true },
          { text: s.lo === s.hi ? "fixed" : `${engineering(s.lo, settingUnit(s))}–${engineering(s.hi, settingUnit(s))}`, end: true }] })),
      ] }] : []),
    ],
  }));
}

export function configurationSections(c: ProjectConfig): Section[] {
  return [
      { heading: "Parameters", blocks: [{ kind: "table", rows: c.params.map((p) => ({ cells: [{ text: p.name }, { text: `${engineering(p.lo, p.unit)} … ${engineering(p.hi, p.unit)}`, end: true },
        { text: "", tag: p.fixed ? { text: "fixed", tone: "muted" } : { text: "free" }, end: true }] })) }] },
      { heading: "Experiments", blocks: c.catalog.map((e) => ({ kind: "facts", rows: [
        { label: e.label, value: e.maxRuns == null ? "" : `Up to ${e.maxRuns} runs` },
        ...e.settings.map((setting) => ({ label: cap(setting.label), value: engineering(setting.default, settingUnit(setting)) })),
      ] })) },
      { heading: "Noise", blocks: [{ kind: "facts", rows: Object.entries(c.noise.sigma).map(([k, v]) => ({ label: `σ ${k}`, value: `${sig(v, 2)} ${specOutput(c, k)}` })) },
        { kind: "text", text: `Scale estimation ${c.noise.estimate ? "on" : "off"} · sensor bias ${c.noise.bias}` }] },
      { heading: "Run limits", blocks: [{ kind: "facts", rows: [{ label: "Agent steps", value: String(c.budgets.maxSteps) }, { label: "Simulations", value: int(c.budgets.maxSimulations) },
        { label: "Total experiments", value: String(c.budgets.maxExperiments) }] }, { kind: "text", text: `Policy: ${c.policy.label}` }] },
  ];
}
