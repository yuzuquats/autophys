# Attachment visibility and executable configuration must agree with the recorded workbook

Status: round 1 implementation committed in `3bb0db904f44868847c7d7464632d31aa195bda4`; current qualification is blocked on resource/source stability. Baseline judges identify one shared atomicity blocker and paired trust/scientific boundary defects; scores remain baseline judgments, not acceptance evidence.

Two remote record POSTs commit independently. Retrying them can repair a partial attachment but cannot prevent a reader seeing it or another writer leaving an orphan. The daemon should expose an additive attachment operation using the existing workbook immediate transaction, keeping approval checks, global record identity/replay decisions, measurement and proposal projection under that transaction. Existing single-record endpoints retain their meaning. Format 1 and canonical hashes stay unchanged, and historical records are not migrated.

| Decision | Recommendation and compatibility | Alternative and reversal |
| --- | --- | --- |
| CORE-01, agent-chosen pending operator review | Add a dedicated atomic attachment endpoint accepting the existing record payloads and IDs; both SDKs use it. An old daemon returns 404/405, propagated without a two-POST fallback. | Broad batch transaction framework adds unnecessary surface. Reversal removes the additive route/client call; no data conversion is needed. |
| CORE-02, agent-chosen pending operator review | Reject executable configuration drift before run/approve/attach/resume. Keep simulator identity and legitimate free/fixed overrides. | Copying every simulator/callback can alter identity and budget ownership. Reversal is a small boundary change, no stored migration. |
| CORE-03, agent-chosen pending operator review | Normalize absent/empty targets to default collection; accept case-insensitive HTTP(S), normalize authority/default ports/trailing slash; reject userinfo/query/fragment and ambiguous URL-like targets before effects. Bind discovered saved keys to this normalized identity; explicit keys retain explicit destination authority. | Accepting ambiguous destinations risks unintended persistence or credential disclosure. Reversal affects input validation only. |
| CORE-04, agent-chosen pending operator review | Retain Rust project(name) creation and Python project(name) open-existing semantics; add explicit Rust open_project and Python ensure_project counterparts. | Breaking either established method is unnecessary. Additive methods are cheap to reverse. |

Qualification will use bounded paired negative-input checks and real-daemon attachment races/failure/restart/visibility checks where the storage ceiling permits a corresponding native artifact. No finite validation samples must never count as passed. Observation sigma must be finite and positive at use boundaries, including mutation. Invalid fit initial values, no starts without an explicit initial, and no finite samples must fail before simulations or persistence. Public HTTP errors retain optional paths.

Deferred without waiver: A5 ephemeral/JSONL capability, A6 visual policy, FS01/FS02 documentation discovery, PERF01 HTTP bounds, PERF02 repeated scientific measurements, and any uncompleted T04 research shard. These remain part of the campaign analogy/qualification obligation. No provider, training, frontend, deployment, push or release work is authorized by this batch.

The external round packet will distinguish changed code from proven acceptance, name artifact/source identity, exact tests and resource stops, and preserve unresolved objections for five independent rejudges. The campaign is unfinished.

## The additive transport preserves each existing record dialect

`POST /api/v1/investigations/{inv}/proposals/{pid}/attachment` accepts `measurement: {id, kind: "measurement", payload}`, `attachment_id`, and optional `attachment_payload`. Omitting the last field derives the Rust record API's `{proposal_id,event:"data_attached",measurement_version:<measurement hash>}` inside the transaction. Python supplies its existing measurement version/dataset digest/observation payload and event digest with integer linkage. Its content-derived IDs and Rust remote's proposal-derived IDs remain unchanged. The server validates the event/proposal/linkage and both global IDs, admits only approved/edited proposals, and folds both records under one immediate transaction. Complete identical retries replay before transition checks; changed content conflicts; a legacy orphan is not repaired or migrated implicitly. Existing `/measurements` and `/data` single-record routes keep their meaning.

An old daemon answers 404/405 to the new operation; the SDK surfaces the typed HTTP error and never falls back to independent writes. An upgrade is required for remote attachments. No workbook format or historical hash changes are intended.

| Intent | Python | Rust | Existing behavior |
| --- | --- | --- | --- |
| Open a named workbook without writing | `client.project(name)` or additive `open_project(name)` | additive `client.open_project(name)` | Missing project errors on both explicit open methods |
| Create or ensure a record workbook | additive `client.ensure_project(name)` | `client.project(name)` or `ensure_project(name)` (also returns created flag) | Existing Rust creation remains compatible |
| Bind executable configuration | `client.project(project)` | `client.project_with(project)` | Validates then creates/opens and binds config |
| Start/resume | `wb.investigate` / `wb.investigation` | `ProjectWorkbook.investigate` / `resume` | Same scientific concepts, language-specific signatures |

Absent and empty connection targets select the default collection (`AUTOPHYS_HOME`, else `~/autophys`). Explicit `.` selects the working directory; ordinary paths, home paths and `.ap-workbook` paths remain local. HTTP(S) scheme and hostname case, default port and trailing slash are normalized, with any path prefix retained. Userinfo, query, fragment, whitespace, backslash, unsupported `://` schemes and malformed HTTP(S) are rejected without requests or filesystem creation. Automatically discovered credentials must match this normalized identity. An explicit API key or environment key deliberately authorizes the selected destination; insecure saved credential files remain refused under the existing rule.

Each Python workbook/investigation gets a bound HttpStore view sharing auth/transport cursors while owning its project ID for blobs. The direct store's existing `ensure_project` selection API remains available. Resume binds from recorded project identity before restoring image references. Configuration drift checks retain the original simulator/callback and source hash, rather than copying code or rebinding the simulator budget.
