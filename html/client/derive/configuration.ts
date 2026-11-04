/** Read-only configuration content shared by Main and Details. */
import type { Channel, ProjectConfig, SettingSpec } from "../domain.ts";
import type { Section } from "../../ui/view-model.ts";
import { engineering, int, sig } from "./fmt.ts";

const specOutput = (c: ProjectConfig, channel: string) => c.catalog.find((e) => e.output.name === channel)?.output.unit ?? "";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Word labels are capitalised; symbols such as x or T are kept as written. */
const channel = (ch: Channel) => `${ch.label.length > 2 ? cap(ch.label) : ch.label}${ch.unit ? ` (${ch.unit})` : ""}`;
/** A setting with no declared role (no manifest, or undeclared in it) is `other`: shown with its raw name, never hidden. */
const roleOf = (s: SettingSpec) => s.role ?? "other";
const value = (s: SettingSpec) => engineering(s.default, s.unit);
const allowed = (s: SettingSpec) => s.lo === s.hi ? "fixed" : `${engineering(s.lo, s.unit)}–${engineering(s.hi, s.unit)}`;

/** Sampling settings on one line: "10 s @ 100 Hz" for a duration and a rate, otherwise "Label value" pairs. */
function samplingLine(settings: SettingSpec[]): string {
  const duration = settings.find((s) => s.unit === "s"), rate = settings.find((s) => s.unit === "Hz");
  if (settings.length === 2 && duration && rate) return `Recorded for ${value(duration)} @ ${value(rate)}`;
  return `Recorded with ${settings.map((s) => `${s.label.toLowerCase()} ${value(s)}`).join(" · ")}`;
}

/**
 * One card per experiment, grouped by setting role (display-manifest.md): the caption names its
 * channels and run limit; then its description, the input it applies at its defaults, a table of
 * drive and undeclared settings with their defaults and allowed ranges, and one sampling line.
 * Known settings are project-wide (knownSection).
 */
export function experimentSections(c: ProjectConfig): Section[] {
  return c.catalog.map((e) => {
    const shown = e.settings.filter((s) => roleOf(s) === "drive" || roleOf(s) === "other"), sampling = e.settings.filter((s) => roleOf(s) === "sampling");
    const blocks: Section["blocks"] = [];
    if (e.description) blocks.push({ kind: "text", text: e.description });
    if (e.preview && e.input) blocks.push({ kind: "wave", t: e.preview.t, y: e.preview.u, label: `${channel(e.input)} at the defaults` });
    if (shown.length) blocks.push({ kind: "table", rows: [
      { dim: true, cells: [{ text: "Setting" }, { text: "Default", end: true }, { text: "Allowed", end: true }] },
      ...shown.map((s) => ({ cells: [{ text: roleOf(s) === "other" ? s.label : cap(s.label) }, { text: value(s), end: true }, { text: allowed(s), end: true }] })),
    ] });
    if (sampling.length) blocks.push({ kind: "text", text: samplingLine(sampling) });
    if (e.unsupportedViews?.length) blocks.push({ kind: "text", tone: "muted", text: `Not supported by this UI: ${e.unsupportedViews.join(", ")} view` });
    if (!blocks.length) blocks.push({ kind: "text", tone: "muted", text: "No settings" });
    return {
      heading: e.label,
      caption: [e.input ? `${channel(e.input)} → ${channel(e.output)}` : `Measures ${channel(e.output)}`, e.maxRuns == null ? "" : `up to ${e.maxRuns} runs`].filter(Boolean).join(" · "),
      blocks,
    };
  });
}

/** Known settings (physical constants the experiments share), once per project; a value that differs between experiments lists each. */
export function knownSection(c: ProjectConfig): Section | null {
  const known = new Map<string, { s: SettingSpec; values: Set<string> }>();
  for (const e of c.catalog) for (const s of e.settings) if (roleOf(s) === "known") {
    const k = known.get(s.name) ?? { s, values: new Set<string>() };
    k.values.add(value(s));
    known.set(s.name, k);
  }
  if (!known.size) return null;
  return { heading: "Known values", caption: "Constants every experiment shares", blocks: [{ kind: "facts", rows: [...known.values()].map(({ s, values }) => ({ label: cap(s.label), value: [...values].join(", ") })) }] };
}

export function configurationSections(c: ProjectConfig): Section[] {
  return [
      { heading: "Parameters", blocks: [{ kind: "table", rows: c.params.map((p) => ({ cells: [{ text: p.name }, { text: `${engineering(p.lo, p.unit)} … ${engineering(p.hi, p.unit)}`, end: true },
        { text: "", tag: p.fixed ? { text: "fixed", tone: "muted" } : { text: "free" }, end: true }] })) }] },
      { heading: "Experiments", blocks: c.catalog.map((e) => ({ kind: "facts", rows: [
        { label: e.label, value: e.maxRuns == null ? "" : `Up to ${e.maxRuns} runs` },
        ...e.settings.map((setting) => ({ label: cap(setting.label), value: value(setting) })),
      ] })) },
      { heading: "Noise", caption: "Measurement error assumed per output", blocks: [{ kind: "facts", rows: Object.entries(c.noise.sigma).map(([k, v]) => ({ label: `σ ${k}`, value: `${sig(v, 2)} ${specOutput(c, k)}` })) },
        { kind: "text", text: `Scale estimation ${c.noise.estimate ? "on" : "off"} · sensor bias ${c.noise.bias}` }] },
      { heading: "Run limits", caption: "What one investigation may spend", blocks: [{ kind: "facts", rows: [{ label: "Agent steps", value: String(c.budgets.maxSteps) }, { label: "Simulations", value: int(c.budgets.maxSimulations) },
        { label: "Total experiments", value: String(c.budgets.maxExperiments) }] }, { kind: "text", text: `Policy: ${c.policy.label}` }] },
  ];
}
