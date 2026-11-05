# Round 3 frontend: coherent presentation and reachable review controls

The final planned frontend repair keeps display metadata consistent across a
snapshot/reconnect and keeps the lowered landing surface from intercepting
pointer actions in the workbench. It preserves scientific/configuration identity,
peer interface work, all vendor bytes and the exact deck.ts slide9 behavior.

The exact A/event -> snapshotB -> A/event test fails before repair (B/B instead
of A/A), then the focused client checks and complete frozen Deno suite pass.
The current full suite is111 passed. A retained snapshot digest is invalidated
when the installed body differs; equivalent bodies retain deduplication. Every
valid display receipt advances local presentation ordering even when its digest
is unchanged, protecting against a stale in-flight snapshot without redrawing.
Concurrent records/configuration and stale-generation checks remain in the suite.

The actual round2 product reproduces the pointer obstruction: body.scrollTop542
with window.scrollY0 places the translated landing at y458 in a1000px viewport;
hit-testing returns ck-landing above the approval button. The product composition
now clips body overflow in app/tour stages, preventing hidden-container focus and
scrollIntoView scrolling; native scrolling on the closed landing is retained.
No broad redesign or vendor/brand/tour/deck edit is needed.

Actual final packed-product pointer edit/approve/reject, stale409, SDK attach,
worker asset, native thermal resume/refit, keyboard rejection, metadata/cursor/
config preservation and tour return pass at1440x1000,1280x800,768x1024,390x844,
plus reduced motion at390x844. Closed-landing scroll/reopen and pointer disclosure
also pass. These are Chromium synthetic pointer/viewport runs, not physical
mobile/Safari/native-platform qualification. Unsuccessful harness assumptions are
retained externally, not converted to passing attempts.

The browser guide now accurately describes the restricted synthetic thermal
starter and points arbitrary simulator authors to SDK/contributor setup.

## R3B-D1: prospective useful-content and transport readiness diagnostics

**Agent-chosen, pending operator review.** Preserve the original warm usable
candidate1s and cleanup5s. Useful content/actual pointer readiness ends after the
requested investigation's populated UI has an enabled visible hit-tested summary
and a real pointer click toggles it, plus two frames. Original animation+100ms
inclusive settle timing is measured directly alongside it, with no subtraction.
CDP independently observes each native EventSource request and its terminal
loadingFailed/loadingFinished; native close states and active request counts are
separate from pooled HTTP sockets. A supplemental raw TCP probe uses Connection:close and matches each exact
server socket inode, excluding HTTP pooling without production instrumentation.
The strongest alternative is production transport instrumentation, which adds
diagnostic complexity.
This external measurement method can be reversed cheaply without changing data,
services or APIs. Candidate gates are not accepted SLOs; host/IPC uncertainty and
all misses remain reportable. Exact prospective inputs and raw receipts live in
the external packet; no operator confirmation is inferred.

Five fresh W-1 states each finish with 336 distinct records across three
workbooks, including the actual 2000-point thermal curves. Ten warm pointer
readiness samples have p95 1012.7320859999163 ms (four exceed 1000 ms); the
original inclusive settle interval has p95 1118.9223780000175 ms (all ten
exceed 1000 ms). Both candidate gates remain open. The earlier 1056.355 ms
warm and 5002.781830 ms aggregate-fd misses remain retained. No subtraction,
failed-sample dropping or budget increase is used. A bounded trace shows
inherited 700/380 ms landing motion plus startup tasks; it does not establish
a >1 s compute stall or justify a broad interface/worker/network rewrite.

All 50 native EventSource reconnect requests independently terminate via CDP
in at most 2.2081819999730214 ms; the polling observer sees completion within
13.21266800002195 ms. Three exact nonpooled server socket probes return in
12.179604964330792, 12.152103940024972 and 12.093238066881895 ms. These
are measured upper observation bounds with 10 ms polling and scheduling/IPC
uncertainty, not proof that every pooled socket closes simultaneously. Snapshot
p95 is 142.146467 ms, HTTP update max 262.247449 ms, SDK update max
1121.038550 ms, active pointer disclosure p95 41.400000 ms and navigation
p95 51.400000 ms. One/four-stream idle peak is 1.733239% of one daemon
core with 8536 KiB additional RSS; active longtask maximum is 194 ms.

Current native library checks pass 31 tests, embedded checks pass 7 with one
explicit packed test ignored in that invocation, and the separate final-web
packed test passes. Actual native offline build-web uses the unchanged
608-module config/lock graph; stripped and packed artifacts serve health, HTML,
JavaScript and the emitted worker without a source tree. Source/compiler
closure and dependency guards bind the retained dev-stamped native bytes to
current committed inputs. The 679-pass/one-skip SDK ledger and repeated
numerical evidence are retained with unchanged consumed-source correspondence,
not claimed freshly rerun. Separate Mac installed-wheel consumer evidence is
linked by protected rows; native macOS/Linux ARM64 and live Modal/provider
resource behavior, redistribution rights, historical missing vendor patches
and the original timeout/SIGSEGV attribution remain unqualified.

Evidence: yuzuquats:~/.local/state/productionize/
autophys-productionize-yuzuquats-20261104/repair-round-3-frontend/packet.md.
Only scoped local commits; no publication/deployment/readiness score. All five
independent judges must assess one final common guarded identity.
