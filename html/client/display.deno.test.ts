/** Display manifest (format 1, display-manifest.md) → domain config, and the role-grouped Configuration cards. */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyDisplay, mapConfig } from "./wire.ts";
import { experimentSections, knownSection } from "./derive/configuration.ts";

const config = {
  simulator: { name: "battery_ecm", outputs: ["v"], source_hash: "abc" },
  params: { R0: { lo: 0.001, hi: 0.1, initial: 0.01, unit: "Ω" }, Q: { lo: 1, hi: 10, initial: 2, unit: "Ah", fixed: true } },
  catalog: {
    pulse_train: { settings: { current: 2, on: 30, off: 60, duration: 300, rate: 2, capacity_ah: 5, kind: 1 }, edit: { current: [0.5, 10] }, max_runs: 3 },
    rest: { settings: { duration: 600, rate: 1, capacity_ah: 5 } },
  },
  noise: { sigma: { v: 0.002 } }, budgets: { max_steps: 10, max_simulations: 100, max_experiments: 2 }, policy: { kind: "scripted" },
};
const display = {
  format: 1, simulator: "battery_ecm",
  channels: { v: { label: "Terminal voltage", unit: "V", role: "output" }, i: { label: "Current", unit: "A", role: "input" } },
  params: { R0: { label: "R₀", description: "ohmic resistance" } },
  settings: {
    current: { label: "Current", unit: "A", role: "drive" }, on: { label: "On", unit: "s", role: "drive" }, off: { label: "Off", unit: "s", role: "drive" },
    duration: { label: "Duration", unit: "s", role: "sampling" }, rate: { label: "Rate", unit: "Hz", role: "sampling" },
    capacity_ah: { label: "Capacity", unit: "Ah", role: "known" }, kind: { label: "kind", unit: "", role: "other" },
  },
  experiments: {
    pulse_train: { label: "Pulse train", description: "Square pulses with rests.", views: ["edges", "phase-portrait"], preview: { t: [0, 1, 2, 3], u: { i: [0, 2, 2, 0] } } },
  },
};

Deno.test("display: the manifest supplies channels, labels, units, roles, views and the input preview", () => {
  const c = mapConfig(config, 1, "h", display), pulse = c.catalog.find((e) => e.id === "pulse_train")!, rest = c.catalog.find((e) => (e.id as string) === "rest")!;
  assertEquals([pulse.label, pulse.input, pulse.output], ["Pulse train", { name: "i", label: "Current", unit: "A" }, { name: "v", label: "Terminal voltage", unit: "V" }]);
  assertEquals(pulse.settings.map((s) => [s.name, s.label, s.unit, s.role]), [
    ["current", "Current", "A", "drive"], ["on", "On", "s", "drive"], ["off", "Off", "s", "drive"], ["duration", "Duration", "s", "sampling"],
    ["rate", "Rate", "Hz", "sampling"], ["capacity_ah", "Capacity", "Ah", "known"], ["kind", "kind", "", "other"],
  ]);
  assertEquals([pulse.viewHints, pulse.unsupportedViews, pulse.description, pulse.preview], [["zoom:edges"], ["phase-portrait"], "Square pulses with rests.", { t: [0, 1, 2, 3], u: [0, 2, 2, 0] }]);
  assertEquals([rest.label, rest.description, rest.preview, rest.input], ["Rest", undefined, undefined, null], "an experiment the manifest omits keeps its generic label and drives nothing");
  const free = applyDisplay(mapConfig(config, 1, "h"), { ...display, experiments: { pulse_train: { label: "Free", views: [], preview: { t: [0, 1], u: { i: [0, 0] } } } } }).catalog[0];
  assertEquals([free.input, free.preview], [null, null], "an all-zero preview means the experiment applies no input");
  assertEquals(c.params.map((p) => [p.name, p.label, p.description]), [["R0", "R₀", "ohmic resistance"], ["Q", undefined, undefined]]);
  assertEquals([c.hash, c.params[0].lo, pulse.settings[0].lo, pulse.settings[0].hi], ["h", 0.001, 0.5, 10], "presentation never changes values, ranges or identity");
});

Deno.test("display: no manifest, or another format, renders generically with every setting as other", () => {
  for (const d of [null, undefined, { ...display, format: 2 }]) {
    const c = mapConfig(config, 1, "h", d), pulse = c.catalog[0];
    assertEquals([pulse.label, pulse.input, pulse.output.label], ["Pulse train", null, "v"]);
    assert(pulse.settings.every((s) => s.role === undefined && s.label === s.name));
    const cards = experimentSections(c);
    const rows = cards[0].blocks.flatMap((b) => b.kind === "table" ? b.rows.slice(1).map((r) => r.cells[0].text) : []);
    assertEquals(rows, ["current", "on", "off", "duration", "rate", "capacity_ah", "kind"], "undeclared settings show with raw names, none hidden");
    assertEquals(knownSection(c), null);
  }
  const partial = applyDisplay(mapConfig(config, 1, "h"), { format: 1, settings: { current: { label: "Current", unit: "A", role: "drive" } } });
  assertEquals(partial.catalog[0].settings.map((s) => s.role ?? "none"), ["drive", "other", "other", "other", "other", "other", "other"], "a setting the manifest omits is other");
});

Deno.test("configuration cards group settings by role", () => {
  const c = mapConfig(config, 1, "h", display), [pulse, rest] = experimentSections(c);
  assertEquals([pulse.heading, pulse.caption], ["Pulse train", "Current (A) → Terminal voltage (V) · up to 3 runs"]);
  assertEquals(pulse.blocks.map((b) => b.kind), ["text", "wave", "table", "text", "text"]);
  const table = pulse.blocks[2];
  assert(table.kind === "table");
  assertEquals(table.rows.slice(1).map((r) => r.cells.map((x) => x.text)), [
    ["Current", "2 A", "500 mA–10 A"], ["On", "30 s", "fixed"], ["Off", "60 s", "fixed"], ["kind", "1", "fixed"],
  ]);
  assertEquals(pulse.blocks.slice(3).map((b) => b.kind === "text" ? b.text : ""), ["Recorded for 300 s @ 2 Hz", "Not supported by this UI: phase-portrait view"]);
  assertEquals(rest.blocks.map((b) => b.kind === "text" ? b.text : b.kind), ["Recorded for 600 s @ 1 Hz"]);
  const known = knownSection(c)!;
  assertEquals(known.blocks, [{ kind: "facts", rows: [{ label: "Capacity", value: "5 Ah" }] }], "a value every experiment shares is one row");
});

Deno.test("known values that differ keep the experiment they belong to", () => {
  const differing = { ...config, catalog: { ...config.catalog, rest: { settings: { duration: 600, rate: 1, capacity_ah: 2.5 } } } };
  const known = knownSection(mapConfig(differing, 1, "h", display))!;
  assertEquals(known.blocks, [{ kind: "facts", rows: [
    { label: "Capacity", value: "5 Ah", note: "Pulse train" }, { label: "Capacity", value: "2.5 Ah", note: "Rest" },
  ] }]);
});

Deno.test("display: manifest keys are own properties only", () => {
  const proto = { ...display, experiments: { pulse_train: { ...display.experiments.pulse_train, views: ["constructor", "toString", "edges"] } } };
  const pulse = mapConfig(config, 1, "h", proto).catalog[0];
  assertEquals([pulse.viewHints, pulse.unsupportedViews], [["zoom:edges"], ["constructor", "toString"]]);
  const named = { ...config, catalog: { constructor: { settings: { toString: 1 } } } };
  const c = mapConfig(named, 1, "h", { format: 1, channels: {}, settings: {}, experiments: {} }), e = c.catalog[0];
  assertEquals([e.label, e.description, e.settings.map((s) => [s.label, s.role])], ["Constructor", undefined, [["toString", "other"]]], "undeclared names are not found on the prototype");
});
