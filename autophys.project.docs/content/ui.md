# The workbench reads the daemon's recorded investigation

The browser now loads the real workspace, follows its record stream, and writes
proposal decisions and device approvals through the daemon. It retains the existing
cookbook shell and view-only surfaces. This joins the existing `autophys`
commit-project; it adopts and completes the stopped implementer's uncommitted
`html/` work. Scope is `html/**` and this page only; server, SDK, vendor and
other agents' changes remain theirs.

The composition root loads `daemon()` by default and shows a recovery banner when
its load fails. `?source=fixtures` explicitly selects the demo; `?source=daemon`
forces the daemon. The sidebar status names the source. A daemon that answers with
no projects stays an empty workspace, including controls to approve the first
device. It never substitutes sample investigations for an empty daemon.

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
No successful empty daemon load is replaced with demo data. Demo mode has a small
indicator and a link back to live data. A refused connection has an in-flow alert,
retry action and demo link. Retrying reloads the document, retaining AX-9's cookie
minting and UI-10's automatic reload guard.

With no projects, the sidebar explains what a project is and omits the selector
and empty investigation header. Main gives a copyable Python SDK recipe and a demo
link; Details explains how to connect a device and shows pending approvals. The
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
