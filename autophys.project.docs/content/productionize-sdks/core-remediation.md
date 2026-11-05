# Attachment visibility and executable configuration must agree with the recorded workbook

Status: round 1 design, implementation and qualification pending. Baseline judges identify one shared atomicity blocker and paired trust/scientific boundary defects; scores remain baseline judgments, not acceptance evidence.

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
