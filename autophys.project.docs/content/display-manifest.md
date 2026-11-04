# The UI should render what the simulator declares and know nothing about batteries

Status: rev 2 (2026-11-04). **Approved by the operator for implementation
(DM-1 in [decisions.md](decisions.md)).** Steps 1–3 are handed to
autophys/py and autophys/rs; step 4 (the UI) starts once step 1's golden
manifests exist. Nothing is implemented yet. Rev 2 makes Python the source
of the bench manifests, in line with AX-2, and pins the preview sampling so
that both SDKs can produce identical bytes.

The operator asked for the decoupling ("autophys should be generic") and for
a spec, after seeing a mock of two products rendered by one UI.

This plan adds a **display manifest**: a simulator's declaration of how its
channels, settings and experiments should be shown. The Python or Rust SDK
uploads it, the daemon stores it without reading it, and one compiled UI
renders any product from it. Changing a label, unit, role or view in Python
then shows up in the live UI with no rebuild and no redeploy.

It does **not** change fitting, the config hash, `config_version`,
`source_hash` or any existing record. Projects that have no manifest keep
working; they are rendered generically.

## The evidence: the UI already has the slot, and only fixtures fill it

The client's domain model gives every experiment an `ExperimentSpec`
(`html/client/domain.ts:31`): an input channel, an output channel, settings
with units, and `viewHints` naming the extra Fit views. The chart code is
already generic over it:

- the input strip draws `spec.input`;
- the Envelope and Edges views filter on `viewHints`
  (`derive/charts.ts:141`, `:190`).

Only the hand-written fixtures (`html/client/fixtures/fixtures.ts`) fill the
slot in. The live daemon path leaves it empty, because nothing in the SDK's
config carries that information:

```
html/client/wire.ts:53
  return { id, label: humanize(id), input: null, output, settings,
           maxRuns, viewHints: [] };
```

To make up for the empty slot, product knowledge has been coded into the UI
in four places:

```review-table
| Site                              | What it hard-codes                                                         |
| --------------------------------- | -------------------------------------------------------------------------- |
| `derive/configuration.ts:14`      | shows only settings named current/duration/rate/amplitude/frequency/freq, and guesses their units from those names |
| `derive/charts.ts:40`             | an experiment with no declared input is drawn as `force (N)`                |
| `derive/shared.ts:104`            | `project.id === "bench-oscillators"` opens on Landscape                     |
| `derive/shared.ts:139-140`        | `p.experiment === "sine"` gets a frequency label                            |
```

What this looks like on live `battery_ecm` today:

- there is no input strip;
- there are no Edges views, even for `pulse_train`;
- settings have no units;
- `on`, `off`, `capacity_ah` and `soc0` never appear on the Configuration
  page.

A thermal project's `power` setting would be dropped from Configuration
entirely.

## The mechanism

There is one root cause behind all four sites: **the UI's only description
of a product is the simulator schema.** That schema is
`{name, params, experiments, outputs, stochastic}` (`simulator.py:142`,
`project.rs:214`).

- Settings in the schema are a free-form dict with no units or roles.
- Inputs are not declared at all.
- The schema is hashed twice: once into `source_hash` and once, through
  `config()`, into `config_version` (`project.rs:237`).

So any presentation field added to the schema would change every existing
project's identity. With no other place to put the information, it went into
the UI as name matching.

The input channel has a second, separate problem. The Python SDK's
`_check_result` keeps only the declared `outputs` and drops every other
channel the simulator returns (`simulator.py:236`). A simulator that computes
its drive current today cannot hand it to anyone.

## The model

```review-flow
flowchart LR
  P["Python or Rust project<br/>simulator declares display"]:::changed
  C["SDK client<br/>PUT projects/pid/display"]:::new
  D["daemon :4794<br/>stores it unread, serves it in workspace and stream"]:::changed
  W["wire.ts<br/>manifest to ExperimentSpec"]:::changed
  R["derive and ui<br/>no product names"]:::changed
  H["config, config_version, source_hash unchanged"]
  P --> C --> D --> W --> R
  P --> H
```

The manifest travels **next to** the config and never through it.
`PUT /config_versions/{v}` cannot carry it anyway, because the daemon rejects
a body whose sha256 is not the version (`sdks/python/src/autophys/http.py:355`).

### The manifest, format 1

```
{
  "format": 1,
  "simulator": "battery_ecm",
  "default_view": "fit",              // optional; one of the core views or an experiment's view
  "channels": {
    "v": {"label": "Terminal voltage", "unit": "V", "role": "output"},
    "i": {"label": "Current",          "unit": "A", "role": "input"}
  },
  "params": {                         // optional; the unit and range already come from the schema
    "R0": {"label": "R₀", "description": "ohmic resistance"}
  },
  "settings": {
    "current":     {"label": "Current",  "unit": "A",  "role": "drive"},
    "on":          {"label": "On",       "unit": "s",  "role": "drive"},
    "off":         {"label": "Off",      "unit": "s",  "role": "drive"},
    "duration":    {"label": "Duration", "unit": "s",  "role": "sampling"},
    "rate":        {"label": "Rate",     "unit": "Hz", "role": "sampling"},
    "capacity_ah": {"label": "Capacity", "unit": "Ah", "role": "known"},
    "soc0":        {"label": "SOC₀",     "unit": "",   "role": "known"}
  },
  "experiments": {
    "pulse_train": {
      "label": "Pulse train",
      "description": "",
      "views": ["edges"],
      "preview": {"t": [64 numbers], "u": {"i": [64 numbers]}}
    }
  }
}
```

**Roles** replace the whitelist, and the Configuration page groups settings
by role:

```review-table
| Role       | Meaning                                       | Where it renders                                        |
| ---------- | --------------------------------------------- | ------------------------------------------------------- |
| `drive`    | what the experiment applies                   | on each experiment card, beside its waveform            |
| `sampling` | duration, rate                                | one line under the card: `300 s @ 2 Hz`                 |
| `known`    | fixed physical constants shared by experiments | once, at project level, as chips                        |
| `other`    | the default for any undeclared setting        | on the card, with its raw name and no unit — never hidden |
```

**Views name analyses, not products.** Fit, Residuals and Landscape are
always present. On top of those, an experiment may declare any of:
- `edges`: zoom on input transitions;
- `envelope`: the decay envelope;
- `spectrum`: the output's spectrum.

The UI's current `"zoom:edges"` and `"frequency"` hints are renamed to
`edges` and `spectrum`. An unknown view name is ignored, and the
Configuration page lists it as "not supported by this UI".

**Previews** are computed by the SDK when the manifest is registered:
- it runs one simulation per catalog experiment at the project's `initial`
  parameters;
- it keeps only the `input` channels;
- it downsamples them to 64 points.

These runs fall outside the investigation's simulation budget. Because the
waveform icons are stored data, the UI never needs to know what a "pulse" or
a "sine" is.

### Inputs are channels the simulator emits, kept apart from outputs

A simulator returns its drive alongside its outputs: battery returns
`{"t", "v", "i"}`. `_check_result`, and its Rust equivalent, keep the
declared input channels in a separate `u` map. Every existing consumer of
`y` therefore stays output-only: fitting, residuals, and `wire.ts:123`, which
takes the first channel of `y` as the output.

Measurements may also carry `observation.u`, for labs that record their
stimulus. When a measurement has no `u`, the input strip falls back to a
simulation of that experiment's settings.

```review-callout
kind: decision
title: Rejected — put input channels in `y`
This is simpler for the SDK. It was rejected because every reader of `y`
assumes `y` holds outputs: `wire.ts:123` takes the first key, and the fit
code compares every channel it is given. Putting inputs in a separate key
means no existing consumer has to learn the new rule.
```

### What the daemon does

The daemon gets one new endpoint, `PUT /api/v1/projects/{pid}/display`,
which takes the manifest JSON as its body.

- **Validation:** the daemon checks `format` and caps the size at 256 KiB.
  It does not read anything else.
- **Storage:** a workbook table holds `(project, digest, body, created)`.
  The digest is sha256 of the canonical JSON. Re-uploading identical bytes is
  a no-op, and the newest upload wins.
- **Snapshot:** `GET /workspace` adds `"display"` beside each project's
  `config_versions` (`src/http.rs:358`).
- **Stream:** `/stream` sends a `display` event, so an open UI re-renders
  without reloading.

autophys/rs may choose a record kind instead of a table, if that is how the
workbook already streams changes. Either way, the change must also be
documented in `workbook-format.md`.

### What the UI does

**`wire.ts`** builds `ExperimentSpec` from the manifest:
- the input and output channels;
- setting units and roles;
- views;
- the preview.

`humanize(id)` becomes the fallback for a missing label, not the rule.

**The fixtures move to the manifest format** and go through `wire.ts`, so
the demo and the live daemon share one path.

**These are deleted:**
- the whitelist and unit map at `configuration.ts:14`;
- the `force (N)` fallback at `charts.ts:40`, so no declared input means no
  input strip;
- `shared.ts:104`; the default Fit view becomes a manifest field
  (`"default_view"`);
- `shared.ts:139-140`; a proposal is labelled with its experiment label and
  its drive settings.

**A guard test** (`html/client/generic.deno.test.ts`) fails if
`html/client/derive/` or `html/ui/` contains a product word: `battery`,
`oscillator`, `thermal`, `current`, `force`, `sine`, `soc`, or any bench
project id. Fixtures are exempt.

```review-callout
kind: decision
title: Rejected — let the UI draw waveforms from `kind`
The UI could draw a pulse or a sine from `kind` plus settings without
touching any simulator. But that puts per-waveform logic back into the UI,
and a new product with a new `kind` would need a UI release. Emitting the
input as a channel costs one return value per simulator.
```

```review-callout
kind: decision
title: Rejected — put the manifest inside `config()`
One blob would be simpler, but every existing project would get a new
`config_version`. A label would also become part of the investigation's
identity, so fixing a typo would split an investigation in two.
Presentation is not part of the physics, so it must not be part of the hash.
```

## Decisions

```review-table
| Question                                              | Answer                                     | Why                                                                     |
| ----------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| Can Python reconfigure the UI with no rebuild?        | Yes, for everything in format 1            | the manifest is data stored by the daemon and read when the UI loads    |
| Does the manifest change `config_version`?            | No                                         | it is uploaded and stored apart from `config()`                         |
| Versioned per config version, or per project?         | Per project; the newest upload wins        | a label is not physics; old investigations re-render with new labels    |
| Where does the input waveform come from?              | a channel the simulator emits, kept in `u` | no waveform logic in the UI                                             |
| What does an undeclared setting do?                   | shows with its raw name, role `other`      | hiding data is how `on`/`off` disappeared                               |
| Can Python add a new kind of chart?                   | No, not in format 1                        | a new analysis view is added to the UI once; then any product can declare it |
| Must the Python and Rust SDKs emit identical bytes?   | Yes, for the three bench models            | conformance cases already pin their schemas                             |
```

## Phases

The steps can land one at a time, because every new field is optional and a
project with no manifest renders generically.

```review-steps
1. autophys/py — Python SDK: `Display`, `@simulator(..., display=)`, inputs kept as `u` in `_check_result`, previews, the client PUT on project registration, the fake store's endpoint; manifests for battery, oscillator and thermal; golden manifest JSON for the three bench models.
2. autophys/rs — daemon: the display table, `PUT /projects/{pid}/display`, `display` in `/workspace`, a `display` event on `/stream`, `workbook-format.md`. Independent of step 1.
3. autophys/rs — Rust SDK: `Display` type, `u` channels kept in the trajectory, previews, the bench manifests, byte-identical against step 1's goldens.
4. autophys/ui — `wire.ts` mapping, fixtures in manifest format, the four guesses deleted, the guard test, the Configuration page grouped by role (mock A).
5. Deferred — Python-supplied custom panels (a Vega-Lite spec or precomputed series), so a product can ship its own chart with no UI release. Waits for a real product that needs one.
6. Deferred — more than one output channel per chart. Format 1 allows a list of outputs; the UI draws the first and lists the rest.
```

### The contract between the two SDKs

This page is the contract between the two SDKs. A disagreement is settled by
revising this page, not by one side diverging.

- **Python is the reference**, as for numerics (AX-2). Step 1 writes the
  golden manifests through the existing fixture generator
  (`sdks/rust/src/models/fixtures/generate.py`), and Rust's conformance test
  reads them.
- **Bytes:** the manifest is serialised with the same canonical JSON as
  `config()` (`sdks/rust/src/canonical.rs` and its Python counterpart). The
  digest is the sha256 of those bytes.
- **Preview sampling:** `t` is 64 points spaced evenly over
  `[0, duration]`. Each `u` channel is the simulated input, linearly
  interpolated onto `t` and rounded to 6 significant figures. The simulation
  runs at the project's `initial` parameters with default options.
- **Validation in both SDKs:**
  - every key in `settings` must exist in some experiment in the catalog;
  - every `output` channel must be in `outputs`;
  - every `input` channel must be returned by the simulator;
  - `views` must come from `{edges, envelope, spectrum}`;
  - `default_view` must be one of `fit`, `residuals`, `landscape`, `edges`,
    `envelope` or `spectrum`.

  A violation fails at declaration time, not when the manifest is uploaded.

## Validation

1. **Guard test.** The product-word test passes on the UI tree.
2. **Live end-to-end run** against a dev daemon on :4795:
   - Register `battery_ecm` and `bench-oscillators` from Python.
   - Screenshot Configuration and Fit for both, using `withHeadless`. Check:
     - battery shows its current strip and Edges on `pulse_train`, and lists
       `on`, `off`, `capacity_ah` and `soc0`;
     - the oscillator shows Force, plus Envelope and Spectrum.
   - Change one label in Python and upload again. The open page updates
     without a reload, and `config_versions` still has the same entries.
3. **No manifest.** A project with no manifest renders raw names, no units,
   the core views and no input strip, and throws no exceptions.

## Scope boundary

- **Fitting, sensitivity, the agent, budgets, and stored records** are not
  touched. Owner: autophys/rs and autophys/py.
- **Persisted hashes** (`source_hash`, `config_version`) do not change.
- **The tento cookbook shell** (vendored) is not touched; the manifest lives
  entirely in autophys.
- **The Configuration layout** (mocks A, B or C) is the operator's pick in
  the autophys/ui review. This plan only fixes where its data comes from.

```review-callout
kind: risk
title: What is not measured, and what would prove this plan wrong
Not measured:
- The cost of the previews. It should be about one cheap simulation per
  experiment (battery's longest is 600 samples), but nobody has timed it.
- Whether real lab measurements will record their stimulus in `u`. Until
  they do, the strip shows the simulated input, not the measured one.
- Whether four roles are enough. They come from three bench models,
  not from a real product.

This plan is wrong if a real product's experiments cannot be described by
flat, named settings. One example is an arbitrary uploaded current profile:
`time_grid` already accepts a `t` array. The preview would still render that
profile, but roles would say nothing useful about it, and the manifest would
need a structured-settings extension before format 1 is worth freezing.
```
