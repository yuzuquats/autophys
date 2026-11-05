# The workbench reads the daemon's recorded investigation

The browser now loads the real workspace, follows its record stream, and writes
proposal decisions and device approvals through the daemon. It retains the existing
cookbook shell and view-only surfaces. This joins the existing `autophys`
commit-project; it adopts and completes the stopped implementer's uncommitted
`html/` work. Scope is `html/**` and this page only; server, SDK, vendor and
other agents' changes remain theirs.

The composition root uses one `daemon()` Source and one Controller. A failed load
shows recovery UI; an empty collection stays empty. Demo access comes from signing
in as the configured demo account, which reads the seeded server workbooks through
the same snapshot and record stream as other accounts.

## What is implemented

- `client/api.ts` is the only client network module. Browser reads use
  `GET /api/v1/workspace`, the server's consistent snapshot of projects,
  config versions, investigations/proposals and records. The separate
  `/projects`, `/investigations`, config and records routes require a device
  key; the page deliberately keeps no key.
- `client/wire.ts` maps recorded config and payload fields into the domain.
  Records are folded in investigation sequence order and deduplicated by
  investigation plus record id. A POST response and its SSE echo apply once.
  POST responses may arrive before older SSE records without losing those records.
- Unscoped `/workspace.cursor` and SSE `id:` are opaque collection cursors
  (`prj_…:<gseq>[,…]`) on the current daemon. Reconnect closes the old
  EventSource and opens `GET /api/v1/stream?after=<encoded cursor>` with bounded
  backoff. A POST's numeric `gseq` belongs to one workbook and never advances
  this collection stream. The adapter also accepts the earlier numeric cursor.
- A streamed investigation whose project/config is not loaded triggers a fresh
  workspace read. This also populates a page opened before its first project exists.
- Approve/edit/reject use
  `POST /api/v1/investigations/{inv}/proposals/{pid}/approvals`, with the
  record envelope and matching `Idempotency-Key`. Edits send the full proposed
  settings with changed axes replaced. Same-origin credentials carry the document-minted HttpOnly session cookie;
  JSON content type and browser-provided Origin retain O-3.
  Refused writes, including a 409, remain visible in Details until another pick
  or decision. Unsupported withdraw/restore actions are hidden on the daemon.
- Configuration lists pending `GET /api/v1/pairings` with device, user code,
  client and expiry. Approve/deny post JSON to `/pairings/{code}/approve|deny`.
  The open app polls every five seconds; its timer stops on unmount. No device
  secret or API key enters the UI. Pairing is also available before any project.
- Unknown plot data stays absent. Measured samples and uploaded ranking/outlook
  values render; no simulator, optimizer, sensitivity calculation or waveform
  generation was added to the client. Missing input is not shown as zero force;
  missing residual diagnostics are not called white.

The `ui/` remains view-only. Source mapping and explicit empty-state models live
in `client/derive`; browser-only component binding lives in `ui/components.ts`.
The root owns navigation, clipboard access and guarded reauthentication.

## Verification and reproduction

Run from the repository root with Deno, Cargo and the installed CLI on PATH. Build outputs are in
`~/.cache/autophys/target-ui`; web output is in
`~/.cache/autophys/ui-stage/web.cookie/autophys`.
The scratch daemon uses an isolated collection and server DB beneath
`~/.cache/autophys/ui-stage/run-20261104T123632Z/`. It never uses port 4794,
the live service, or `~/.cache/tento/autophys/`.

```sh
deno test --allow-read html/
deno check --config html/deno.json html/routes/index.root.ts
CARGO_TARGET_DIR=$HOME/.cache/autophys/target-ui cargo build --locked
AUTOPHYS_PROJECT_ROOT=$PWD ~/.cache/autophys/target-ui/debug/autophys build-web \
  --out ~/.cache/autophys/ui-stage/web.cookie/autophys
# Pick a free port in 47950..47999, with your own collection and server DB.
~/.cache/autophys/target-ui/debug/autophys serve --addr 127.0.0.1:47954 \
  --web-root ~/.cache/autophys/ui-stage/web.cookie/autophys \
  --collection <scratch>/collection --server-db <scratch>/server.db
~/.cache/autophys/venv/bin/python html/e2e/seed.py \
  http://127.0.0.1:47954 <scratch>/server.db \
  ~/.cache/autophys/target-ui/debug/autophys
deno run -A html/e2e/fixture-flow.ts http://127.0.0.1:47954 <shots>/fixture-cookie
deno run -A html/e2e/daemon-flow.ts http://127.0.0.1:47954 <shots>/daemon-cookie-final
```

The seed uses the real Python SDK's oscillator investigation and HTTP store,
approves a scratch seed device through the CLI, and stops at a proposed experiment.
Its key stays in memory. Rerun daemon-flow with a freshly seeded collection.

| Check | Result |
| --- | --- |
| Deno suite, including all three boundaries | 55 passed, 0 failed |
| Root and both browser-driver type checks | Passed |
| `cargo build --locked`, required target directory | Passed; dependency warnings only |
| `autophys build-web` | Passed; route tree produced |
| Fixture driver on cookie-auth daemon | 60 checks, 0 errors (desktop + emulated phone) |
| Daemon driver on cookie-auth daemon | 17 checks, 0 unexpected browser/network errors, including expiry reload and guard |
| Mechanical design detector on changed view derivations | No findings |
| PID cleanup | Scratch servers stopped by their recorded PIDs; no test browsers remain |

A prior build attempt failed while the concurrent Cargo workspace refactor was
incomplete (`workspace.dependencies.anyhow`). The owner repaired the manifest
during this session; the next build passed without UI edits outside scope.

The requested original `ops/check-flow.ts` was run. It fails at
`[tutorial] app mounted into the queue slot`: it expects the old placeholder's
`[data-row]`, `h1`, three-step tutorial and `Server ok` status. Those assumptions
already disagree with the imported autophys fixture app. `html/e2e/fixture-flow.ts`
retains its 60 shell assertions, adapted to the real shadow-tree rows, crumb,
extended guide and source status, without altering the out-of-scope `ops/` file.
This does **not** claim the original driver passes.

Screenshots are written to the caller-supplied directory; its exact path is in the
handoff report. Final runs are `fixture-cookie/` and `daemon-cookie-final/`.
Command logs are retained in the scratch run directory.

The final live checks used the freshly built server with AX-9 cookie auth in the
server owner's concurrent working tree; that server work was still uncommitted at
UI qualification. Earlier runs used the pre-cookie binary and are not the final
auth evidence. The AX-9 session-cookie update keeps `credentials: "same-origin"` and a
same-origin EventSource. A 401 invokes an injected `reauth()` callback; the
composition root owns `location.reload()` and a 30-second `sessionStorage`
guard. A repeated refusal shows a connection error, including when load never
completed; it cannot silently switch to fixtures. SSE errors close the old
stream and probe `GET /pairings` to distinguish an expired session from a
network drop, because native EventSource does not expose status. Health display
uses only `ok`, `version` and `commit`; it never reads `tento_commit`.

## Record gaps

These are absent from the SDK payloads returned in
`GET /api/v1/workspace.records[].payload` and the equivalent streamed records;
there is no separate HTTP computation endpoint for them. Empty model fields are
intentional, rather than numbers calculated by the browser.

| Record/field | What remains absent and what the UI shows |
| --- | --- |
| `run` payload | Fitted/initial curves per measurement (`Fit.curves`), initial trajectory, optimizer trail, basin count, lag-1 residual diagnostics, landscape grid and frequency response. Measured data renders with “fit curve not recorded”; residuals/landscape have empty states; residual quality says “not recorded”. |
| `step`, `decision.action=analyze_sensitivity`, `result` | It records identified/non_identified and condition_number, but no singular values/vectors, marginal uncertainty or valued combinations. The UI shows the recorded classification and condition; it leaves singular plots and uncertainty absent. |
| `proposal`, `event=proposed`, `payload.outlook` | Optional. Uploaded axes/score/after arrays enable existing E-1 interpolation. Without them the proposed settings remain visible and read-only, with an explicit outlook gap; approve/reject still work. |
| `proposal`, `event=proposed` | No preview drive/predicted-response series. Main says “preview not recorded”; ranking bars use only recorded scores. |
| `measurement.observation` | No input channel/waveform, output units or per-setting units. The UI omits the input strip and says input is not recorded; it retains raw channel names and declared sigma. |
| `outcome.validation` | A recorded summary includes chi2_per_n, threshold and passed, but no predicted series or worst parameter/uncertainty. The UI shows the summary and names the missing prediction. Before a check is recorded it does not invent a threshold. |
| `config_versions[].config.simulator` | No human simulator version or channel units. The UI uses the name/source hash and leaves version/units empty. |
| `GET /api/v1/pairings` | No pairing SSE event; the UI polls while mounted. |

Current client limit: the domain has one output series per measurement. For a
multi-output `observation.y`, this adapter currently displays the first channel.
Supporting channel selection needs a domain/view-model extension; this is a UI
limitation, not missing server data.

## Decisions

All entries below are **agent-chosen, pending operator review**.

- **UI-5 — snapshot route for browser reads.** Before: daemon was a stub.
  Now: load the browser-authorized `/workspace` with the document-minted session rather than acquiring a device key
  for individual project/investigation/record reads. This avoids exposing
  credentials to page JavaScript and gives an explicit resume cursor. Alternative: server grants
  browser auth to those individual routes; that needs a server contract change
  and introduces snapshot races. Implemented in `api.ts`; reversing costs an
  adapter change and corresponding contract tests.
- **UI-6 — fold records, keep the collection cursor opaque.** Before: fixture
  decisions apply in one global integer order. Now: daemon records replay by
  per-investigation sequence, deduplicated by investigation/id, while SSE resumes
  from its own token. This handles independent workbooks and POST/SSE races.
  Alternative: reload all data for every event; simpler but more network and
  rendering work. Implemented in `wire.ts`, `api.ts`, `store.ts`. Reversal is
  confined to the adapter/store; no data migration.
- **UI-7 — pairing in Configuration, plus empty-workspace Devices.** Before:
  no pairing UI. Now: the pinned row signals pending codes; Configuration
  provides decisions, and an empty workspace exposes the same controls.
  Five-second polling reflects the lack of pairing events. Alternative: a
  dedicated Devices surface with server push. Implemented; reversal costs one
  derived panel/root timer adjustment. Never exposes keys.
- **UI-8 — absent recorded information stays visibly absent.** Before: the
  fixture supplied all chart inputs. Now: recorded summaries render, absent
  curves/diagnostics do not acquire synthetic values, and settings need an
  uploaded outlook axis to be edited. Alternative: SDK uploads the missing
  chart inputs; preferred follow-up, with domain mappings added when contracts
  exist. Reversing the empty presentation is cheap and requires no persisted
  data change.
- **UI-9 — fixture shell driver under the authorized UI tree.** Before:
  `ops/check-flow.ts` still drives the placeholder. Now: a driver in
  `html/e2e/` retains the 60 assertions against the real fixture interface.
  Alternative: update the original driver; that file is outside this assignment.
  Implemented; switching costs moving/adapting the driver once its owner agrees.

These choices are part of the UI implementation commit named by its Change-Id
in the handoff report. They introduce no external contracts or migrations.

- **UI-10 — host-owned reauthentication with a per-tab guard.** Before:
  failed sessions would appear as network failures. Now: one reload per
  30 seconds remints the HttpOnly cookie; further failures show an error.
  The callback is injected into the Source so client code has no DOM/storage.
  Alternative: a server session-renewal endpoint; that adds a contract and
  a separate lifecycle. Implemented to operator AX-9, with the reload interval
  agent-chosen, pending operator review. Reversal changes the root callback
  and source error handling, with no data migration.

## Cookbook follow-up and owner question

No vendor files changed. Existing cookbook gaps remain: keyed FLIP targets inside
slots and across all three slots, a phone review-card mirror, and panel resize
handles. No new cookbook API is required for daemon wiring or pairing. The root
uses the existing `shell.setCrumb` hook.

Owner question: can the owner of `ops/check-flow.ts` update it for the real
fixture UI (using `html/e2e/fixture-flow.ts` as the reference)? Its current
placeholder assertions prevent the literal requested command from passing.

## Task receipt

Review inherited diff/current API: done. Adapter/pairing/missing-data states and
unit regressions: done. Fresh cookie-auth browser qualification: done. Local UI commit: this change. The task-board CLI and a supported installed `lona-console` are
unavailable on the UI implementation host; no task database was written directly. This page is
the scoped task receipt; no other threads were messaged.


## Null and edge states

The workbench distinguishes a pending first load, an empty collection, a project
without investigations, an interrupted connection, and a missing recorded series.
A successful empty daemon load stays empty. A refused connection has an in-flow
alert and retry action. Retrying reloads the document, retaining AX-9's cookie
minting and UI-10's automatic reload guard.

With no projects, the sidebar explains what a project is and omits the selector
and empty investigation header. Main gives a copyable Python SDK recipe; Details explains how to connect a device and shows pending approvals. The
recipe deliberately names the caller-supplied simulator and measured dataset.
One project is a label; several use lona-js's SelectInput. A project with no
investigations gets its own recipe and live-update explanation. UI-4 still holds:
the UI does not create investigations.

Missing chart, uncertainty, sensitivity, preview, ranking and outlook data use a
quiet “Not recorded yet” treatment. Recorded measurements remain visible beside
the absent fitted curve. A proposal without an outlook grid keeps its settings
read-only and explains that edits cannot be scored; approve and reject remain
available. No new numerical data is computed or invented.

### Decisions (agent-chosen, pending operator review)

- **UI-11 — explicit state variants and deliberate demo entry.** Before: a
  loading source and an empty collection shared empty controls, and a failed
  connection could silently select fixtures. Now: derive supplies distinct
  loading/onboarding/unavailable/missing variants; demo entry is explicit.
  Recommended because operators can tell whether they are looking at their own
  records. Strongest alternative: automatic demo fallback, which makes first use
  effortless but obscures connection failures. Implemented. Reversal is a small
  root/derive change, with no data migration.
- **UI-12 — lona-js view primitives with a browser binding adapter.** Adopted
  `components/empty-state/empty-state`, `components/skeleton/skeleton`,
  `components/input/select-input`, `components/button/button` and `ui/icons`,
  retaining `components/tree-list/tree-list`. Pure markup supplies escaped markers;
  the browser adapter binds the components and forwards intents. The boundary
  allows only these specific modules. Core's surveyed utilities supply no needed
  visual primitive. Recommended for consistent controls without moving application
  state into views. Alternative: hand-written controls, with a larger maintenance
  burden. Implemented; replacing the adapter is local, inexpensive work.
  `Code` was rejected because it imports the CodeMirror bundle through an
  instance-specific static URL and plugin types; the SDK recipe uses semantic
  `pre/code` with a lona-js copy button. `Banner` is an absolutely positioned
  floating notice without action slots; recovery uses an in-flow semantic alert
  with the shared button. `Badge` is an absolute avatar overlay, so the existing
  tree trail badge remains. `PropertyList` brings editable number controls and
  rounded-card layout; the existing semantic `dl` better fits compact read-only
  facts. Reorderable `List` adds interaction the investigation tree does not need.
  Searchable `Dropdown` adds search/overlay handling; SelectInput suits this small
  project collection. No vendor changes are required.
- **UI-13 — an honest SDK recipe and collection guidance.** Before: no first-run
  instruction. Now: `ap.connect`, `ap.Project`, `wb.investigate`,
  `ap.ProposalRunner`, `ap.ScriptedPolicy` and `inv.run()` match the Python SDK.
  The workspace API does not expose the served collection path, so the copy says
  “your autophys collection” and asks the user to supply its path or daemon URL.
  Recommended over assuming the daemon's default path. Alternative: expose the
  collection path through a new API contract. Implemented; changing the recipe or
  consuming a future API field is cheap and needs no migration.
- **UI-14 — pending devices, not an invented paired-device inventory.** Before:
  “Devices … none” suggested the daemon had enumerated paired machines. Now:
  Details says there are no pending requests and explains SDK URL pairing and
  `autophys pair`. Pending requests have a named badge and approve/deny controls,
  including before any project exists. Recommended because the API lists pending
  requests, not approved devices. Alternative: omit all device guidance until a
  request exists, which hides how to connect. Implemented; the wording and row
  presentation are cheap to reverse.
- **UI-15 — recorded-data gaps remain visible.** Before: some missing panels had
  only a title or an empty body. Now: all missing charts use the same small empty
  component and explain what has not arrived; read-only proposal settings explain
  the missing outlook. Recommended over hiding panels, because absence is useful
  calibration context. Alternative: hide unsupported chart views, reducing clutter
  at the cost of discoverability. Implemented; reversal is confined to derive and
  presentation, with no effect on stored records.

- **UI-16 — keep a registered project visible before its first config.** Before:
  the wire adapter discarded projects without config versions. Now: the name
  remains in the switcher, Main explains how to start its first investigation,
  and Details names the missing configuration without inventing one. Recommended
  because `client.project(Project(...))` can precede `wb.investigate(...)`.
  Alternative: keep hiding the project until its first configuration arrives,
  which makes a successful SDK registration look unsuccessful. Implemented;
  reversal is a small adapter/derive change with no data migration.

### Null-state task receipt

Component/API inventory: done. Explicit models and scoped implementation: done.
Unit and boundary tests: passed. Browser qualification: passed. Local commit:
this change. Task-board CLI remains unavailable; no task database was edited directly.
No other threads were messaged.


### Null-state verification

| Check | Result |
| --- | --- |
| `deno test --allow-read html/` | 59 passed, 0 failed; layer boundaries included |
| Root and three e2e script type checks | Passed |
| `cargo build --locked` with the required UI cache target | Passed on current master; dependency warnings only |
| `autophys build-web` into the UI staging directory | Passed |
| Fixture flow | 62 checks, 0 browser/network errors |
| Daemon flow, with a second empty scratch daemon | 22 checks, 0 unexpected browser/network errors; SSE, 409, pairing and AX-9 renewal/guard passed |
| Null-state flow | 39 checks, 0 errors; 39 screenshots at 1280×800 and 390×844 |
| Process cleanup | Both scratch daemon PIDs stopped; no test Chrome processes remain |

Screenshot stems (each has `-1280x800.png` and `-390x844.png`): `empty`,
`project-empty`, `project-unconfigured`, `devices-none`, `pairings-pending`,
`switcher`, `single-project`, `loading`, `unreachable`, `reauth-failed`,
`missing-fit`, `missing-residuals`, `missing-landscape`, `missing-sensitivity`,
`missing-outlook`, and `demo`. Seven additional phone captures use the
`-390x844-sidebar.png` suffix. The manifest enumerates every file.

The empty and populated daemons used separate scratch collections and server
DBs. The populated collection came from the real Python SDK seed. Network
faults, delayed loads, project-only snapshots and a proposal without outlook
were explicit browser test inputs based on that real snapshot. They are not
production API changes. Chromium ran through the vendored `withHeadless`
launcher and closed in its finalizer. Captures, logs and the cleanup receipt
are retained as external workstream evidence, not committed.

No vendor changes are required. Useful upstream follow-ups would be a
standalone read-only code entry point without instance/plugin dependencies,
and a public `Cookbook.Shell.setStatus` hook: the current shell accepts only
an initial status callback, so the root updates its existing status node when
a later connection error arrives. No new cookbook or component API was assumed.


### Design iteration round 1 — decision rows

All rows are **agent-chosen, pending operator review**. The operator moved sidebar
work to a separate redesign during this round; this change leaves sidebar models,
markup and null states untouched. No vendor, server, SDK or persisted data changes.

| Decision | Before → implemented behavior | Recommendation and strongest alternative | Reversal and evidence |
| --- | --- | --- | --- |
| UI-17 — configuration as a main-pane document | Bounds alone occupied a stretching card; experiment catalog, noise and budgets lived in Details. Main now presents labelled parameter tracks, compact experiment settings, noise and budget. A configured project retains this page before its first investigation. | Keep the read-only configuration visible at the point of selection. Alternative: retain the chart and require Details for configuration, preserving more chart space but hiding the information this page exists to show. | Implemented in derive/configuration.ts and Main. Local rendering/model change to reverse; no migration. Desktop 1280×800 and phone 390×844 captures are under rwc-dev-01's `fleet/evidence/autophys/ui-design-r1-20261104/after/`. |
| UI-18 — readable quantities and quiet provenance | Bounds used mixed decimal precision and unlabelled log tracks; the footer exposed a full monospace source hash. Bounds now use SI prefixes and declared units, show the initial value beside its marker, and label each fitting scale. The footer starts collapsed with eight-character identities and reveals full, copyable source/config hashes. | Use declared units first; known SDK catalog setting keys current/duration/rate/frequency use A/s/Hz when the wire carries no unit. Alternative: leave those setting values unitless until the SDK uploads units, which avoids this display convention but makes the catalog harder to interpret. | Implemented; formatter, metadata and catalog-label changes are cheap to reverse. This convention applies only to recognised keys; other setting values acquire no invented unit. Source/config identity remains complete in the disclosure and clipboard value. |
| UI-19 — one section-aligned Details null state | An unconfigured project repeated “Not recorded yet” and mixed a heading with a centred empty block. Details now says it awaits the first investigation and gives one left-aligned “Record your configuration” next step. Section data gaps share that alignment; full-pane empties retain their centring. | Keep the shared lona-js EmptyState with a section-specific alignment binding. Alternative: custom markup for each missing section, adding divergent spacing and copy. | Implemented in derive/index.ts and the browser component adapter. Reversal is local markup/binding work. Sidebar empty-state bindings remain unchanged. |
| UI-20 — device decisions belong to the device | A cramped table wrapped codes and separated devices from their actions. Each pending device now has its name, client, non-wrapping monospace code, relative expiry, comparison guidance and its own lona-js approval/denial buttons. | Use one card per request. Expiry labels and transition delays are derived upstream; a small browser-only presentation element advances the supplied text, owns one callback, and clears it on detach. The vendored Timestamp only formats past times, so it would mislabel future expiry as “just now”; the vendored timer display formats an editable duration timer rather than an expiry deadline. Alternative: static relative text, which becomes stale because unchanged polling responses do not redraw. | Implemented in derive/pairing.ts and ui/timeline.ts. The narrowly isolated presentation callback changes no application or network state; the UI boundary still excludes timers elsewhere. Replacing it when a shared countdown component exists is cheap. Pure deadline-boundary tests and browser checks cover ticking, two device-specific decisions and reduced-motion behavior. |

### Rail sidebar proposal (UI-25, pending operator review)

Operator direction, 2026-11-04: the sidebar moves to tento's rail
(`vendor/tento/tento-ui-js/components/rail/`: `std-rail`, `std-rail-section`,
`std-rail-nav`) and becomes simpler. The cancelled "sidebar B tree + New project
stepper" design is not restarted. Nothing below is built yet.

| Decision | Before → proposed | Recommendation and alternative | State, reversal and evidence |
| --- | --- | --- | --- |
| UI-25 — the sidebar is a rail of flat rows | Today: a project dropdown, a pinned Configuration row and a tree up to four levels deep per investigation (Measurements › each measurement, Fit #n › Fit/Residuals/Landscape/Envelope, Sensitivity, each proposal, Validate, Ground truth), with a "Live from the daemon" footer. Proposed `std-rail`: **head**, the project name with a switcher (only with more than one project) and **+** New project; **body**, one `std-rail-nav` with Configuration (accessory `vN`) and an Investigations section (count) of one row per investigation, its accessory the status (amber **Approve** when a proposal waits, `running k/n`, the validation result, `needs data`); **foot**, Devices with a red count pill and a connection row only while broken. | **Agent-proposed, pending operator review.** An investigation's sections move to Main as a segmented control (Overview · Data · Fits · Sensitivity · Proposals · Validate · Ground truth when revealed); fit views become a switch inside Fits; a waiting proposal shows as a banner with Approve/Reject, the flow verified live on 2026-11-04. Alternative: keep the investigation's children in the rail as a `std-tree-list` under each row (the rail allows a tree beside flat navs); less Main work, but it keeps the depth the operator wants gone. | Presentation only: `derive/tree.ts` → a rail model, `ui/sidebar*.ts` replaced, Main gains the investigation sections. No API, record or stored-data change. Reverting restores the tree adapter. |
| UI-25a — what is cut | The deep tree and its glyphs; the body project dropdown (moves to the head); the "Live from the daemon" footer and the shell-header Export (per-pane Export stays); the five-step New project stepper (draft UI-22/UI-23); the custom 320px width and label measuring (draft UI-24): the rail owns width (drag 220–600, collapse, stored preference). | Agent-proposed. UI-21's intent stays: Devices always present with a red count and no badge at zero; it moves into the rail foot. | The UI-21–UI-24 rows and the sidebar-B implementation text are uncommitted drafts from this thread's cancelled child (17:47–18:34 UTC), as are `html/ui/sidebar-{glyphs,model,styles}.ts` and the `sidebar*.ts` edits. A later Codex child (stopped 20:58 UTC) edited `new-project*`, `project-setup*` and `html/e2e/sidebar-flow.ts`. All stay on disk, unused, until the operator says to discard them. |
| UI-25b — New project and Devices | New project: head **+** opens one page in Main (name, simulator template, Create), not a stepper. Devices: the rail foot row opens the pairing cards in Main, moved out of Configuration's details. | **Operator decision needed:** whether Create may also start an investigation in the browser. Commit 8920386 (Change-Id I423ed2e9a9428496dccf, server-only, not deployed) adds browser-created thermal projects and a built-in scripted run loop on the daemon. Keep it and wire **Start investigation**, or revert it and keep New project as the SDK snippet and pairing page. | Not built. Reverting 8920386 removes `src/http/workbench.rs` and its test; nothing depends on it. |

**UI-25 withdrawn (2026-11-04).** The operator dropped this proposal: a Codex subagent from the autophys/master thread is building the sidebar, restyled after the artifacts app's, plus a New project screen without a Details panel and aligned panel headers. Its commit and record supersede UI-25, UI-25a and UI-25b. The uncommitted sidebar-B drafts named in UI-25a are unchanged on disk; commit 8920386 remains on master, unused by the UI.


### Artifacts sidebar implementation — operator decision, 2026-11-04

| Decision | Resulting behavior | Authority and scope | Validation and reversal |
| --- | --- | --- | --- |
| UI-26 — compact workspace tree and aligned headers | Keep the app bar and three separate Workspace, Main and Details panels. A frame-hosted `std-rail` contains New project, Devices, a divider and a small-caps Projects count in `std-rail-section`, then one `std-tree-list` with guides. Project folders carry muted investigation counts; Configuration carries its version; investigations are newest first and retain Data, Fit, Sensitivity, proposals, Validate, their verdicts/values and Approve pills. Pending Devices has a red count with a descriptive accessible label, absent at zero. No project dropdown, Investigations heading, bottom creation button or Live footer. The reconnect alert appears only while broken. New project uses the existing Main stepper and hides Details and its focus targets until a selection needs it. All headers share a 48px band, 13px/600 text and 12px left inset; sidebar labels and icons use that same column. | **Operator-decided (2026-11-04, final).** Supersedes UI-21, UI-24 and withdrawn UI-25/a/b. Reference: rwc-01 artifacts `project-rail.ts` and `ref-artifacts.png`. App code only; no vendor edits, live deployment or push. | HTML type-check and 77 tests pass; fixture flow 63 checks, daemon flow 21, null-state flow 36, browser project flow 37; visual geometry checks plus all eight required desktop/phone captures. Evidence: `rwc-dev-01:~/workspace/fleet/evidence/autophys/ui-sidebar-artifacts-20261104/`. Reversal is a local presentation/model change; no persisted-data migration. |

UI-26 follow-up (2026-11-04, round 2): remove cookbook body padding and override the rail’s white `--bg` fallback and scroll gradients so rows sit directly on the grey panel, keeping the 12px text inset. Supply neutral cap metrics for an actual 10.5px muted uppercase Projects label/count, with .07em label tracking. Nav and tree hover/selection now use translucent `--ck-hover` (5%) / `--ck-selected` (8%) overlays. HTML tests: 82 passed; sidebar flow: 37 checks; appearance/geometry: 37 checks across all eight captures (including hover). Evidence: `rwc-dev-01:~/workspace/fleet/evidence/autophys/ui-sidebar-artifacts-20261104/round2/`. The initial boundary-test failure was fixed concurrently; the initial Create timeout passed with the newer scratch daemon.

Draft reconciliation: `sidebar.ts` and `sidebar-markup.ts` retain the useful existing
workspace tree, accessible badge and recovery rendering; the adapter now uses the
reference rail/section primitives and top navigation. `sidebar-glyphs.ts` is reused
with a folder project mark and 13px sizes. `sidebar-model.ts` is reused unchanged.
`sidebar-styles.ts` is replaced with the approved row/header presentation.
`e2e/sidebar-flow.ts` is adopted with the approved order, native Devices selector,
1280×800 desktop coverage, hidden-Details assertions and keyboard field entry.
The 10:00 UTC preimages are preserved under the evidence directory's `baseline/`.
New-project/controller work, Configuration card work, signed-out handling and other
sessions' staged changes remain outside this sidebar commit. The one project-count
expectation in the existing untracked `project-setup.deno.test.ts` was updated and
left uncommitted with that file's owner. Scratch daemons use ports 47981–47983 and
external web output; they are stopped after verification. No browser was left running.


### New project wizard adoption — UI-27, 2026-11-04

**Agent-chosen, pending operator review: wizard vs SDK stepper vs both.**
The built-in Thermal experiment wizard is committed as-is: name/model,
parameters/experiment, then create and start the daemon's simulated investigation.
This completes the drafts already reached by the artifacts sidebar instead of
leaving HEAD dependent on untracked files. It does not settle the product choice.
The strongest alternative is the SDK-device stepper (or offering both); that
supports operator-owned devices but requires a separate setup flow and a choice
of entry points. UI-22/UI-23's earlier five-step SDK draft is historical; the
committed wizard has three steps and runs through the existing workbench API.

New project has no Details panel; the existing aligned panel header bands and
New project → Devices → divider → PROJECTS → tree order remain authoritative.
The integration includes API calls, controller/draft state, snapshot refresh,
MainBody/renderer, stepper hydration and styles. Snapshot refresh preserves pairing
approvals that complete during a read and ignores read completion after close.
The two races have regression tests. Boundary assertions still prohibit network,
storage and application timers in view components; Stepper is an explicit allowed
presentation dependency.

Reversal: replace the setup model/controller/renderer and its root hydration with
an SDK flow, or add a chooser and keep this wizard alongside it. Restore the
onboarding empty-state action if removing the wizard entirely. This is local
browser code and test work; no data migration or server rollback is needed.
Projects already created remain ordinary persisted projects, and the workbench
API can remain available independently. Expected cost: a small UI workstream,
before investing in device-specific steps. Do not remove the MainBody variant
while the renderer or root still tests for it.

Qualification uses a clean Git archive plus only the adopted files/hunks, followed
by a clean archive of the resulting HEAD: root type-check, deployment Deno test
command and build-web. Desktop 1280×800 and phone 390×844 browser-flow captures
and logs live at `rwc-dev-01:~/workspace/fleet/evidence/autophys/new-project-stepper-20261104/`.
The installed task-board CLI is unavailable on PATH; task state is retained in the
workstream cache, with no direct task-database edits. Remaining work is the
operator's wizard/SDK/both decision; this commit does not redesign that choice.


## Sign-in opens without forced field focus (2026-11-05)

Opening the standalone sign-in page previously focused Email immediately,
which could open browser credential suggestions before the user chose a field.
The login and invitation pages now retain native page focus. Tab reaches Email
first, then Password; credential autocomplete hints and ordinary form submission
remain intact. The form enters with a 160 ms opacity fade (0.6 to 1), disabled
for reduced-motion preferences. Phone-sized inputs use 16 px text to avoid
iOS input zoom; page padding and small-viewport height keep the form stable.

Prior art: [GitHub Primer's page-navigation focus guidance](https://primer.style/product/ui-patterns/loading/#focus-management)
recommends native focus behavior when navigation loads a new page.
[MDN's autofocus accessibility concerns](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/autofocus#accessibility_concerns)
describe forced scrolling, mobile keyboard activation and skipped context.
This is a standalone document, so dialog focus-trap guidance does not apply.

Validation: release build passed, with existing dependency warnings.
Focused browser checks at 1280×800 and 390×844 confirmed BODY retains initial
focus after load, Tab reaches Email then Password, autocomplete attributes remain,
and mobile layout has no horizontal overflow. An isolated demo login reached
the app. Invalid credentials retained the email, cleared the password, displayed
the existing alert and left initial page focus alone. Invitation fields retained
new-password autocomplete without autofocus. No test suites were run, per the
operator's build-only instruction. Native password-manager popup rendering with
stored credentials and physical iOS Safari were not exercised.


## Header sign-in uses the lona-js modal and overlay (2026-11-05)

The header Sign in control now opens the shared `Dialog` and `Overlay` from
lona-js (vendored here under `@tento-ui`) over the current landing page or
workbench. The shared panel takes initial focus, leaving credential fields
unfocused until the user chooses them. Tab stays inside; Escape, the shared
close control and the backdrop dismiss it and restore header focus. Background
surfaces are inert and page scrolling is held while open. Dialog keys do not
change the deck or drawer underneath.

The dialog uses the same native fields, autocomplete hints and in-place auth
submission as the workspace card. Login errors stay inline, repeated submissions
are blocked while pending, requests time out, and a dismissed form cannot steal
focus on a later failure. Success updates the server-rendered account badge and
starts the user's store without navigating. The normal
login link remains a fallback for navigation without the app handler.

Motion uses the shared overlay with a short dialog entrance and an opacity-only
reduced-motion variant. At narrow widths the panel retains 16 px gutters, scrolls
within the viewport and uses 16 px credential inputs.

Validation: Deno checks and web bundling passed. Isolated browser checks covered
panel initial focus, keyboard Tab, Escape and backdrop dismissal/focus restore,
inline invalid-credential errors, the 390×844 layout without horizontal overflow,
and successful demo sign-in followed by loading server records. No test suites were run, per the operator's build-only direction.
Release and live deployment evidence is in workstream `autophys-signin-modal`.


## Demo access and data architecture — 2026-11-05

The operator established that demo access means signing in as the demo account.
The app now has a single daemon Source and Controller. Synthetic browser workspace
selection, controller replacement, screenshot previews, their assets and obsolete
browser drivers have been removed. The cookbook receives an empty tutorial list;
opening the drawer reveals the account workspace or the sign-in card immediately.
The existing drawer movement and shared lona-js sign-in modal remain.

The page's server-rendered account badge resolves initial authentication before
client startup. Signed-out pages defer workspace API calls. The demo button posts
to `/api/auth/demo`; the daemon selects its configured demo user, writes a normal
session in `server.db`, and sets the HttpOnly cookie. In-place login updates the
badge and starts the same Store. Read-only account permissions are enforced by the
server independently of presentation.

`Api::open` opens one collection and stores one SDK Client. The workspace handler
checks authentication, then snapshots that Client's workbooks. It does not filter
by account: all authenticated accounts currently share the deployment collection.
The demo account is an access identity, not a project owner namespace. Per-account
collection isolation would require a separate backend ownership/routing change.
No seeded workbook records or account data are removed by this frontend cleanup.

The record flow is SDK → workbook SQLite record log/projections → authenticated
workspace snapshot and SSE → wire mapping → Store → Controller/derive → UI slots.
Proposal decisions return through the API and become records in the same stream.
The browser formats and interpolates recorded numerical results; numerical
simulation and fitting occur in the SDK or server workbench jobs.

Removal boundary: maintained app source, route assets, active documentation and
runtime entry points. Generic shared cookbook tutorial primitives and numerical
fixtures used only by tests remain. Git history and immutable prior qualification
receipts retain their historical meaning and do not describe the current app.

The cookbook drawer now stops a superseded stage transition if an empty tutorial
completes synchronously. This prevents the initial transition from overwriting
the app position after the empty list immediately opens the workbench. The
committed vendor delta is authoritative; preserve it during vendor regeneration.


Validation for account-only access: Deno type checks passed for the composition
root, changed daemon/derive coverage and maintained browser drivers; diff checks
passed. No test suites ran, per the operator's build-only direction. The release
Cargo build and web bundle passed with existing dependency warnings. Live health
reports commit `4dc81bf9baa6ae78b8377c86679b4c687f9f15ec`.

Focused public browser checks at 1280×800 and 390×844 confirmed that an anonymous
visitor sees sign-in, makes no workspace requests, and cannot select an alternate
data source through a query parameter. Header modal demo login and in-pane demo
login both read `battery_cycler_demo`, its two investigations and 29 stored records.
The down arrow reaches the app with Details open on desktop; the landing cover
finishes below the viewport and panels become ready. Mobile shows the sign-in card
and then the stored investigation without horizontal overflow. No console errors
were observed in the checked rendered states. Deleted worker/image URLs return
404; the served app bundle contains none of the removed source-selector, worker,
controller-swap, image or chip identifiers. Owned source snapshots were removed
after deployment. No account or workbook data changed; no source push was made.


## Account walkthrough retained — operator clarification, 2026-11-05

The operator chose to retain the guided walkthrough using account data. This
supersedes the empty tutorial list described in the removal record above. The
fixture worker, synthetic workspace, controller swap, chip and static screenshots
stay removed. The cookbook tutorial now borrows the one account Controller and
Store, sharing its in-flight load and continuing its normal record stream.

Lessons use real row IDs in the selected project, preferring the selected
investigation and finding available measurements, converged fits, proposals and
validation in that project. Missing record types are skipped; empty collections
receive workspace and project-creation guidance, and unconfigured projects stop at
configuration guidance. Proposal lessons explain that explicit edits/approvals are
real actions enforced by the account's normal server permissions.

The drawer moves independently of the initial account load. Anonymous entry
finishes the tutorial immediately and keeps sign-in visible; in-place sign-in
starts the account walkthrough. The Walkthrough action reopens it later. No tour
starts over an unfinished project setup. Exit restores navigation, panel state
and outer viewer scroll without replacing the Store or discarding edits/results.
The Controller's preserveNavigation callback captures navigation only. Shared
cookbook Back/Next/Done, keyboard navigation and dismiss remain authoritative.
