# Round 3 Phase A: completed-capture output and Modal asset binding

This bounded repair addresses Q-6/PERF-01 and A-04/Q-8/T-8 from the completed
round-2 review. It continues the existing autophys commit-project and its plan.
Only training implementation/tests and this page changed. The campaign and its
independent review remain unfinished; this page assigns no score.

## Completed captures cannot retain the CLI on a stalled pipe

Both remaining captured-stdout diagnostic writes now use the existing independent
nonblocking Diagnostics boundary. Pipe backpressure discards the remaining chunk;
broken/non-reopenable sinks return a failure. No writer queue/thread/join or
shared descriptor flag mutation was added. Normal structured stdout is unchanged.
Regular-file kernel/storage stalls remain outside this guarantee.

Before repair, an independent actual-CLI watchdog held stderr open without
reading while a worker wrote 262144 stdout bytes (below the 1048576-byte capture
budget) and exited. At three seconds both the nonzero planner and successful
dataset CLI were still blocked, although both workers were gone. The planner
still held its run reservation and published no plan.

Against the new immutable native CLI, the identical planner exits 1 in
0.051268 seconds and the dataset exits 0 in 0.040883 seconds. Before releasing
stderr, workers are gone, the planner reservation is reacquirable, no run plan
was published, and dataset stdout is valid structured JSON. Native regression
tests also preserve failed-manifest bytes and execute a same-name retry before
releasing the original sink. Closed pipes, floods, deadlines, interruption,
normal diagnostics, stale results and existing retry history pass.

## Modal consumes and verifies its planned inputs

The CLI forwards its plan's complete asset identity and the prepared directory
to the real Modal local entrypoint. That entry verifies the exact manifest/file
bytes and immutable 40-hex model commit before obtaining a remote call handle.
It transports the verified manifest and three asset files in cfg, avoiding an
ambient remote path. The remote entry revalidates that payload and identity
before acquiring a tokenizer; no heavyweight model acquisition occurs yet.

Tokenizer acquisition requests that exact model revision with remote code
disabled. The returned commit, template, special token strings, complete
tokenizers backend structure and actual training/validation/held-out token IDs
must agree. Encoder uses the prepared template/tokenizer. Model acquisition
also requests the same revision and checks the returned model configuration
before training methods run. The result records asset identity/model revision
without duplicating the large payload; the CLI requires matching result identity
before publishing completed. Its plan, explicit budget/time cap, failed state,
remote-unconfirmed semantics and retry archives are preserved. Loops' existing
digest binding remains intact.

Actual Jinja/tokenizers plus offline Modal/transformers transport stand-ins
exercise the real local entry, cfg, remote entry and Encoder. Missing/tampered
payload or identity, mutable/planned/returned revision mismatch, different
template/special tokens, and used/unused numeric token-ID differences refuse
before the training body. A model-loader stand-in observes the exact pinned
model call and refusal of a wrong returned commit before model methods run.
Nine native CLI dispatch cases observe actual argv/cfg/callee, explicit/env asset
paths, budget refusal before transport, mismatched inputs, mismatched result
identities and successful archived retries. No Modal/provider/GPU call occurred.

**R3A-D1 — agent-chosen, pending operator review.** Carry the already-prepared
assets as the cfg payload and require exact prepared-tokenizer correspondence,
rather than reacquiring a second remote asset bundle. This makes the existing
plan reproducible with the existing row transport and fails closed before model
work. The strongest alternative is a pinned remote download plus verification;
it avoids sending a tokenizer payload but adds remote acquisition/cache handling
and another correspondence boundary. The implementation is local/internal and
can be reversed with one bounded forward patch and focused tests; no persisted
data migration or external contract adoption is needed. Existing run history is
retained. The implementation commit's Change-Id is
I2ad318e67c5448d6972ca7a6a910e92c71ff65de.

## Qualification and remaining limits

Final focused Python receipt: **57 passed in 3.38s**, including all nine actual
native-dispatch cases and existing Loops failure/cleanup checks. Native receipts:
**31 library +13 training lifecycle passed, zero failed**. These are focused
training/control checks, not a rerun of the SDK/scientific/browser suite.

Locked/offline nightly-2026-06-24 builds reused the existing campaign cargo-home,
target and tmp, jobs2/debug0/incrementalfalse. Final build receipt is 4.535s wall;
the raw compiler log is authoritative. Immutable CLI SHA256:
0827f8b9e6a7607c5ca0f64737eb33c40d86792d397f89819e6d3d4017bb72e3.
All 541 lexically normalized conservative compiler-source rows match the compile
capture; config/dependency/dep-info and artifact guards accompany the external
handoff. No wheel or packed-web artifact was produced.

External resumable evidence:
~/.local/state/productionize/autophys-productionize-yuzuquats-20261104/repair-round-3-controls/packet.md.
It carries exact commands/environments, retained unsuccessful harness attempts,
source/manifest/commit identity, immutable artifacts and storage/process custody.

Real Modal/transformers/cloud/GPU execution, cancellation/billing, serving/eval
asset continuity, real SSH, Python minimum/macOS/Linux ARM64 qualification,
frontend pointer/display/timing findings, inherited provenance/redistribution
rights, and the historical timeout/diagnostic SIGSEGV remain unqualified or open
at their previous scope. Offline facades do not certify those boundaries.
