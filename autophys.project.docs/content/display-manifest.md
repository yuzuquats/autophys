# The UI should render what the simulator declares and know nothing about batteries

Status: rev 3 (2026-11-04). **Approved by the operator for implementation
(DM-1 in [decisions.md](decisions.md)).** Step 1 (Python SDK) is implemented
(I6e0c3a9f2d8b51c7e4a2). Step 3 (Rust SDK) is implemented: `Display`,
trajectory `.u`, validated bench declarations and 64-point previews. Full archive
gates and independent review are recorded below. The byte-identical manifests are:
- `sdks/rust/src/models/fixtures/display/battery_ecm.json` (sha256
  `e1aea0cbe6f8065c8b642d4aeb895509290ae3b30eb6496373c2a17d70c3f5fd`);
- `sdks/rust/src/models/fixtures/display/oscillator.json`
  (`824b945f5f05e47112940e0dfddbafc42a05e6bd0e3f40e9759b3b91ef3abe96`);
- `sdks/rust/src/models/fixtures/display/thermal_rc.json`
  (`e19385e061d7fa85fd0fffc66a21c549976d337d9098606c7105ffd5d0442e11`).

`python generate.py --display` regenerates them. Step 2 (daemon/store) is implemented: format-only uploads, persisted latest
manifest, workspace display and replay-on-connect display events. Rust SDK
and UI work can start from these. Rev 3 settles four points the implementation had to
decide; they are in "The contract between the two SDKs".

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
- **Hashes stay unchanged (rev 3).** `source_hash` hashes the function
  source *including its decorator lines*. So the three bench models attach
  their `Display` below the decorated function (`sim.with_display(...)`),
  never in `@simulator(...)`. Their input channels come from an input function
  declared in the `Display`, `(settings, t) -> values` (battery: its existing
  `current(experiment)`), not from a new return value. New simulators may use
  `@simulator(..., display=)` and return inputs directly. The display is
  never part of `schema()`, `config()` or either hash.
- **`u` (rev 3):** Python's result is the same `{t, outputs}` dict as
  before, with inputs on a separate `.u` mapping (`SimulationResult`), so no
  reader of the outputs changes.
- **Preview numbers (rev 3):**
  - Initial parameters are `Project.initial_value()`: the declared `initial`,
    else the geometric midpoint for positive bounds, else the arithmetic
    midpoint.
  - `t` is 64 points spaced evenly over `[0, duration]` (the trajectory's
    last time when `duration` is absent).
  - Inputs are interpolated onto the unrounded `t`. Then every time and input
    value is rounded with Python's `float(f"{x:.6g}")`.
  - The manifest is serialised with the store's canonical encoder as UTF-8,
    with no trailing newline.
- **Undeclared settings (rev 3):** every catalog setting appears in
  `settings`. One the simulator does not declare (`kind` included) is listed
  explicitly with its raw name as label, an empty unit and role `other`, so
  the UI never infers anything.
- **Upload (rev 3):** `HttpStore` PUTs the manifest when a project is
  registered over HTTP. A daemon without the route (404/405) gets one warning
  per store, and registration still succeeds. Local stores neither compute
  nor store a manifest until the daemon's workbook table exists (step 2).
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


## Daemon step 2 implementation (2026-11-04)

The keyed PUT returns 201 on a changed manifest, 200 on a canonical duplicate,
with `{project_id, digest}`. Each object in `/workspace.projects` has a
`display` manifest or null. `event: display` carries
`{project_id, digest, display}`; see [store.md](store.md). The current
manifest is resent on each stream connection and changed digests are polled
for external writers as well as sent on daemon wakeups. Record cursors do
not change. New uploads replace the current row transactionally; reverting
to an earlier body is a new upload.

**DM-D1 — agent-chosen, pending operator review.** Store display as an optional
format-1 table, created on the first PUT, rather than incrementing the core
workbook version. Current Python readers refuse a version above 1; they
preserve unknown tables, so this additive extension keeps both SDKs usable.
The alternative is a coordinated format-2 migration of both SDKs. Reversal:
add that migration once both readers support it; existing table bodies can
be retained. This choice does not alter the records or hash contract.

Task-board CLI was unavailable on rwc-dev-01; implementation, archived-tree
gates and independent review are tracked in these two spec pages.

## Rust step 3 implementation (2026-11-04)

`autophys::Display` attaches with `FunctionSimulator::with_display`; metadata is
validated before attachment. `display().canonical(&project)` and `digest` use
uncounted previews at `Project::initial_value`, linear interpolation before
six-significant-digit rounding, and the existing canonical encoder without a
newline. All three Python golden byte comparisons pass. The source-hashed
`models/{battery,oscillator,thermal}.rs` files and golden fixtures are unchanged;
public model constructors attach declarations through wrappers outside those
files. A test compares schemas, source hashes and config versions before and
after attachment for every bench model. HTTP registration is outside step 3.

DM-RS-1 — **agent-chosen, pending operator review**: replace the `Trajectory`
map alias with a map-compatible struct exposing `.u` separately. Indexing,
iteration, collection and serde retain the historical time/output mapping;
serde intentionally keeps that wire shape (inputs are accessed via `.u`). A
caller returning an explicit `IndexMap` can use `.into()`. The alternative is
a separate display-only simulation API, which would keep the exact map alias
but split the simulation contract from Python. The wrapper is implemented to
keep ordinary simulation results aligned with Python; reversing it would be a
small SDK-only API refactor before external adoption. Identity and numerical
conformance tests cover the boundary. Implementation: `3e9496b`
(`Ia92f82fc2cb154edfbe3`), with compatibility fixes `53f8c69`
(`Ia9e363767fc7c0a4ddda`) and `22136d3` (`I5b6d6a33bd26ee06758a`).

Validation receipt: `cargo test --manifest-path sdks/rust/Cargo.toml` from a
`git archive` export of the reviewed combined master `d2bada2` passed **92
unit/integration tests and 1 doctest**, including all three golden byte
comparisons and every existing conformance case. All 54 source-hashed model
and fixture files checked against the pre-step master are byte-unchanged.
Initial gates found two trajectory-to-map test call sites, now converted, and
a stale exact-four-workbooks assertion, now requiring the original four by
name and checking every committed workbook. The fifth workbook's reveal
support landed independently before the passing gate. No cases were edited.

A separate GPT-6.1 Sol reviewer (Codex, high effort, no credits provider)
reviewed the three scoped commits against rev 3 and Python `acf3c33`: **no
findings**, including no unresolved objections. The final receipt commit is
archive-gated again before handoff; its owner-host log is
`~/.cache/autophys/rs-dm1-evidence/gate-<commit>.log`. All gates use
`CARGO_TARGET_DIR=~/.cache/autophys/rs-dm1-target`, removed after the final gate.
Python source and fixtures were untouched, so the Python suite was not rerun.
DM-RS-1 remains pending operator review; HTTP registration and UI integration
are outside this Rust step.
Task-board CLI was unavailable on rwc-dev-01 (installed `lona-console` has no
`task` command); plan and live gate logs are in
`~/.cache/autophys/rs-dm1-evidence/` on the owner host. No other threads were
messaged.


### Daemon/store validation and review receipt (2026-11-04)

Implementation commits: display `b242839` (`I3239635c574aff73f583`);
reveal/curves `e5472b3` (`I930ec3df6c116b50e969`). Both were assembled
from HEAD blobs through private indexes; no peer uncommitted work was adopted.

A `git archive` export of the combined commit passed `cargo test --workspace`:
161 passed, 0 failed, 2 existing ignored tests. This includes 4 display route/
stream tests and 5 reveal/curve tests, all Python workbook conformance inputs,
and the Rust SDK suite. The initial test-only Actix macro collision was fixed
before this passing gate.

Independent review (separate GPT-6.1 Sol agent, no credits provider) found one
P2: unrelated project broadcasts could postpone an external-writer poll.
The stream now keeps a fixed polling deadline. A fifth display test sustains
unrelated writes while requiring the external manifest within 1.5 seconds and
checking scope isolation. The reviewer found no other actionable findings.
The final archived-tree rerun is recorded on rwc-dev-01 at
`~/.cache/autophys/daemon-dm1-work/c-workspace-test.log`, using exactly
`CARGO_TARGET_DIR=~/.cache/autophys/daemon-dm1-target cargo test --workspace`.
That target is disposable and removed after qualification. No push or deploy.

## UI step 4, Configuration part (2026-11-04)

Implemented by autophys/ui (Change-Ids Ib3cdc761fdc5ea9c0abfcd92cfd575369e5b2aec and
I3248a2f142edd5535d353acee536304dc365757d). `wire.ts` `applyDisplay`
maps a project's manifest onto each config version: channel, setting and
parameter labels and units, setting roles, experiment labels, descriptions,
views (`edges`/`spectrum` to the UI's existing hints; unknown names listed as
"not supported by this UI") and input previews. An experiment gets the
input channel only when its preview of that channel is not all zero, so free
decay stays "Measures …". No manifest, or another format, leaves the config
as it was; every setting then renders as `other` under its raw name.

The Configuration page groups by role: drive and `other` settings in each
experiment table, sampling as one line ("Recorded for 10 s @ 100 Hz"), and
known settings once on a "Known values" card (facts, not chips). The
whitelist and unit map in `configuration.ts` are deleted. The fixtures
declare manifests and go through `applyDisplay` after hashing.
`html/client/display.deno.test.ts` covers the mapping and the cards.

Still open in step 4:
- the `display` stream event (an open page picks up a new manifest on reload);
- the `force (N)` fallback in `charts.ts`, the `default_view` field and the
  sine proposal label in `shared.ts`, and the product-word guard test;
- the Fit and proposal views reading `preview` and the renamed views;
- the Details panel still lists configuration in its older flat form.
