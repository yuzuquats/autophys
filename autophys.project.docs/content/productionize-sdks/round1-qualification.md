# Round 1 qualification before native repair

Historical assessed state: its two native failures are resolved and bounded
current evidence is recorded in [round1-native-repair.md](round1-native-repair.md).

Owner yuzuquats, canonical Autophys master; campaign `autophys-sdks-20261105`.
This continuation tests the implementation in `3bb0db9` and last_wait fix in
`8ca65206`. Assessed source inputs at `f6833a64153b62f330420d42d7638bce756dbd66`
have scope digest `31f5146908fc783a8f2a5c9d7643de5b5b8d2a463e47c149619bf21448af5a2b`
and native vendor digest `b7dbbdda8cb38c78ebc11b1f5f9360ed4c8f6eea0f197a142fd0c307c8b88ad1`.
Peer UI/docs commits advanced HEAD while these inputs stayed identical. No
product source, golden, deployment, service, database or peer staging was changed.

Current Python HTTP/client/review/core boundary command: **143 passed, 1 intentional
live-provider skip**. Explicitly identified daemon/peer batch: **38 passed, zero
skips**, including Py/Py, Rust/Rust, Py/Rust, Python/local-Python and Rust/local-Rust
attachment races, concurrent reads, second-insert rollback, request/response loss,
restart/retry and retained blob/image references. Exhausted scripted researcher:
**1 passed**. Deduplicated current source: **152 passed +1 skip +568 unexecuted
=721 collected**. Earlier 567 passes precede the wait fix and are historical.
Neither this continuation nor the interrupted baseline is a whole-suite pass.

All eleven requested native suites compiled and executed sequentially. Aggregate:
**119 passed, 2 failed, zero ignored**. The real-daemon Rust client suite passed
**7/7**; workbook **15/15**, numerics **3/3**, conformance **3/3**, curves/reveal
**7/7**, vectors **1/1**, battery **12/12**, display **5/5**, candidate/outlook **1/1**.
SDK units were **53/54** and investigation loop **12/13**:

- `remote::tests::paired_target_normalization_before_effects` fails because Rust
  accepts `https://localhost:99999` and produces `https://localhost/api/v1`.
  The underlying URI API returns no parsed port for invalid port text, defeating
  the existing check. Python's corresponding refusal passes. Q7/A4/T01 stay open.
- `core_validation_requires_finite_samples` fails its partial-data expectation:
  `chi2_per_n=63.39010055320683, n=300, passed=false`, expected true. Absent,
  empty and all-missing branches were reached successfully before that assertion;
  the normal branch later in that loop was not reached. Whether the fixture's
  fitted prediction or product behavior needs repair remains untriaged. Do not
  weaken scientific expectations or claim paired partial/normal acceptance.

T05 independently refuses **both missing and empty numerical corpora**, exit101
with `shared numerical corpus is missing or empty`. The same canonical test source
was compiled with an external corpus root; ordinary scientific goldens stayed
unchanged and the normal shared corpus passed. These expected refusals are
separate negative checks, not extra native suite passes.

Current installed wheel proof: **204 passed**, CLI help/import/version/default
playbook/prices smoke passed; all **38 package members** match source and installed
bytes. Wheel SHA256 `1c6242c8da8ee9bfe09996f30402ffdc0193f2af77c6224312121661dd418580`.
Package tests are separate from unique source counts. Two expensive T04 research
shards remain unexecuted. The current Rust doctest was not rerun.

No repair was attempted after these failures: retaining replacement SDK/library,
daemon and peer plus requalification outputs cannot fit the remaining continuation
allocation. The 256-MiB cap includes receipts and temps; aggregate proactive7.5GiB /
hard8GiB and boot proactive13GiB / hard12GiB remain mandatory. Parent needs a new
bounded artifact/retention plan before a repair/refreeze; no cleanup is authorized.
A5/A6 capability parity, FS01/FS02 docs, PERF01 HTTP resource bounds and PERF02
scientific repetitions remain open without waiver. No readiness score, final-ready
claim or judge launch follows from this core pass.

Evidence is external under `~/.local/state/productionize/autophys-sdks-20261105/`
`repair-round-1-qualification/resume-core-20261105/packet.md`, with per-command
argv, source/dependency/artifact guards, failure logs, node accounting, capacity and
quiescence receipts. Linux x86_64/Python3.12/retained Rust1.98 nightly only; direct
rustc artifact qualification does not claim a Cargo workspace/platform matrix.
The parent owns subsequent repair/rejudge scheduling. The campaign is unfinished.
