# Round 2 phase A: local control and distribution repairs

Phase A is implemented on **yuzuquats master**. Implementation HEAD is
**1f816a67d906569d7bc820b6f53fb9602415956d**; the external packet records the
subsequent record-only commit and full final identity. All five round-1 judges
completed at ba42ce20; their quality/architecture/testing/folder/performance
scores remain **7.8 / 8.1 / 7.5 / 8.4 / 7.5, all unverified**. This executor
assigns no score or readiness verdict. Phase B and a same-state five-way
independent rejudge remain pending. Historical baseline 460f5d0 was never reset.

## What changed

**1fd54e0 — training controls and local model assets.** The original blocked
parent-stderr case was reproduced offline before repair: planner and live CLI
workers were still alive after 9 seconds despite 5-second deadline, 2-second
grace and 1 MiB output limits; the live manifest remained running. Worker
forwarding now opens an independent nonblocking stderr description, drops the
rest of a chunk on backpressure, and fails on a broken sink. No queue or writer
thread is added. The explicitly authorized adjacent change is only
`src/scripts.rs::train_result`'s error print call, using the same diagnostic
boundary; unrelated CLI output is unchanged. Native reservation, retry history,
long-run defaults, budgets, primary errors and remote-unconfirmed semantics are
preserved. Filesystem/kernel stalls on regular-file stderr are outside the
pipe/terminal guarantee. A non-reopenable/nonblocking-unsupported sink fails
closed; macOS behavior still needs qualification.

Planning now requires a verified local tokenizer/config/template manifest.
`model_assets.py acquire` deliberately downloads public files at an immutable
40-hex model revision, separately from planning. Plan summaries record all file
hashes and the manifest digest. Loops live launch checks the planned digest
before remote acquisition and compares actual provider token IDs before
training. Missing/tampered/wrong-model assets fail before client creation.
Actual Jinja and tokenizers, with synthetic valid model assets and independent
render/numeric-ID/token-count expectations, qualify this local path. No real
provider, public model weights or cloud runtime was used. Existing
transformer-based helpers can use their explicitly provided tokenizer and its
own in-memory template; **Modal plan-to-remote asset binding remains unqualified**.

**bd6aa2f — document-session retention.** Document requests reuse the browser's
existing cookie rather than minting a token on every reload. API use renews an
idle lease; document/admission checks reclaim 30-day idle entries. A 4,096-entry
cap refuses new admission without evicting active clients. The HttpOnly,
SameSite=Strict cookie now reaches document routes; the old /api cookie is
expired so it cannot later shadow the replacement. Persistent sign-in sessions,
API keys, origin/JSON/Host/loopback rules retain their separate admission paths.

**88f88df — Muse strategy binding.** Both generated launchers pass the packaged
playbook SHA-256. MCP checks it before trusted project import or workbook/client
acquisition, and checks adopted bytes again. Distinct remote ambient/default
strategies refuse explicitly; matching custom configuration works. Pinned
resume still refuses a different strategy and closes an acquired client on
resume refusal. The stale expanded-argv assertion now checks the actual
package-relative executable/resources, alongside real wrapper execution.
No SSH configuration, keys, host or remote artifact was changed.

**1f816a6 — SDK contributor example.** The benchmark uses the canonical activated
environment's `python -m autophys.cli`, retaining `--seeds 5 --jobs 4`.

## Acceptance evidence

Linux x86_64; current Rust nightly, Python 3.12.3. The isolated SDK environment
remains NumPy 1.26.4 / SciPy 1.11.4, with original dependency bytes unchanged.
Actual local planning uses a **separate** task-owned environment with
Jinja2 3.1.6, MarkupSafe 3.0.3 and tokenizers 0.21.4; public wheel hashes and
transitive identities are retained externally. Scientific goldens, cassette,
solver, prompt/schema and strategy fixture bytes were not rewritten.

- One locked/offline native build reused the existing target/cache with
  debug=0, incremental=false and two jobs: **6.01 seconds**. Seven selected
  executables report **62 passed, 0 failed**: library31, training CLI11,
  HTTP9, workbench2, login3, CLI5, namespace boundary1. These backend workbench
  checks are not product-browser proof. Training suite maximum reported RSS:
  **21,440 KiB**, including timed process/children, not provider memory.
- Independent held-open, undrained-stderr probes now exit/reap planner/live in
  **5.052 / 5.097 seconds** at the deadline, and **0.093 / 0.123 seconds** on
  interruption after the sink saturates. Live state is failed/unconfirmed;
  all CLI/state/reaping assertions precede release of the sink. Regression
  tests also cover live stdout forwarding, normal output and closed pipes.
- Controlled-clock tests run **10,000 reloads over 100 days** while renewing an
  active client, reclaim the stale token after 30 days and retain one token.
  Capacity/admission tests preserve valid clients and bound retained entries.
- Actual local Jinja/tokenizer assets plus ownership checks: **34 passed in
  0.13s**. Real native CLI planning records **60 billed tokens** for the tiny
  independently checked model/data, and refuses missing assets and an over-cap
  live request before provider acquisition. This is synthetic asset-contract
  proof, not qualification of every public model template.
- Final isolated SDK check of ownership, MCP and exact replay boundaries:
  **52 passed in 12.42s** (26 SFT, 18 MCP, 8 replay). A new custom-resume test
  first expected ValueError instead of the existing StoreError; its **1 failed,
  17 passed** receipt is retained. Corrected observable checks pass.
- A **newly rebuilt wheel** passes installed CLI/help/resource checks with
  PYTHONPATH absent and **18 MCP tests in 8.75s** with source imports excluded.
  Actual generated wrappers resolve relocated resources and lab cwd. The SSH
  stand-in executes the remote command locally through Unix stdio and proves
  exact custom/default agreement or refusal, with quoted/space-containing paths;
  it never contacts a host or provider. Wheel/source/installed bytes match.

Native executable SHA-256 is
**71b46568d26931fb982d6e6977eed688b0117f67a8107cc2552452f6696ae32e**
(100,899,056 bytes, debug/dev). Wheel SHA-256 is
**5215bfcbe861a65352c5160d59bd161fc02c66172a4f08537c9c7b32b8b7ec46**
(133,298 bytes). Neither was deployed or published. Compiler-input/source
correspondence and exact per-command guards are retained with the packet.

Fresh SDK collection is **680 nodes**, four new MCP regressions and no removed
nodes. Of the earlier 262 unrun nodes, the three plugin nodes now pass; all
**259 other nodes remain pending**. The cumulative unchanged-scope ledger has
421 passed nodes; **this is not a fresh 680-node round-2 suite pass**. Repeated
checks and the separate SFT/native suites are never added to that SDK union.

## Agent choices pending operator review

**R2-D1 — agent-chosen, pending operator review:** best-effort nonblocking
worker/error diagnostics replace synchronous forwarding. Losing saturated
output preserves supervision/state progress; bounded blocking writer threads
were rejected because joining a stuck writer would recreate the hang. The
terminal manifest remains authoritative for errors. Switching costs a focused
local forwarding change and fault requalification, no data migration.

**R2-D2 — agent-chosen, pending operator review:** reuse plus a 30-day idle lease
and 4,096-entry admission cap replaces lifetime retention. Activity renews the
lease; an idle tab with no API/document activity for 30 days must reload to
obtain a token. Existing streams are not independently lease-renewing. The
strongest alternative is reuse with idle reclamation only, allowing unbounded
admission within the idle window; a stateless signed token changes the auth
contract more broadly. These constants/policy can be changed in a small forward
patch with controlled-clock/auth tests; no persisted store or account-session
migration was introduced.

**R2-D3 — agent-chosen, pending operator review:** explicit prepared asset
manifests and a separate immutable acquisition step replace mutable implicit
planner downloads. This preserves identifiable numeric tokenization without
network fallback. The alternative is an immutable managed cache; moving to it
is a local loader/CLI change without altering scientific data or live budgets.

## Remaining work and custody

Q6/PERF1, PERF3, the local Q5 boundary, A3/T7 and FS2 have the bounded proof
above, pending independent review. Q1 strict replay, Q3 resource ownership and
Q4 manifest reservation remain in place. **Q2 display propagation, R4/A1/FS1
frontend dependency reproducibility, actual current product bundle/browser and
PERF2 collection/stream measurements are Phase B work.** PERF4 five-repeat
numerical component distributions, the remaining SDK partitions, original
600-second suite attribution and unexplained diagnostic SIGSEGV are not closed.
Python/runtime/platform matrix, macOS/Linux ARM packaging, actual provider
cleanup/billing and Modal live asset binding remain unqualified. Licensing and
vendor rights still require the rights holder; no new license was selected.

All source edits and commits used SSH on the owner and private indexes;
per-commit unrelated-index drift is empty. Reserved html/vendor/login and peer
records were untouched. No new service, push, deploy, branch/worktree, stash,
manual deletion, original-environment mutation, cloud/GPU/provider call or old
host contact occurred. The live product was not restarted. The managed task
CLI still reports no task command; external tasks.json is the authorized
fallback and no SQLite was edited. Full source/dependency/test/config/vendor
identities, failures, acquisition hashes, allocation/process audits and exact
commands are retained in
`~/.local/state/productionize/autophys-productionize-yuzuquats-20261104/repair-round-2-controls/packet.md`.
Parent takes custody only after source writes are quiescent, assigns Phase B
sequentially, and later rejudges all five dimensions at one completed state.
