# The drawer should move over a stable workbench

The operator reports that Up/Down in `/app` shifts the content behind the
drawer and makes it disappear and redraw. Live Chromium samples on a777ad1
show the main pane shrinking from 708px to 508px over 380ms at 1280×800.
Tour exit additionally marks every region hidden, then fades it back in.
Closing the landing clears main readiness before the covering surface arrives.

Keep the main pane at its viewport height, leaving the deck to cover its lower
200px. Keep the outgoing workbench painted while the deck returns. Deferred
restoration retains its old content until replacement can paint atomically,
without a separate hide/reveal animation. The demo/user controller switch and
existing tutorial interactions remain intact. App teardown still occurs only
after the landing covers it; no new background service or polling lifecycle.

These changes are scoped to this Autophys vendored cookbook and its app-owned
content transition, on yuzuquats master, preserving the deployed a777ad1 worker
and surface-depth fixes. The committed vendor tree is authoritative during the
rwc-dev-01 outage; retain the patch in subsequent vendor reconstruction.

DM-1 — **agent-chosen, pending operator review**: a tutorial covers the existing
full-height workbench rather than shrinking it. This prevents chart/container
resizes on every toggle. The strongest alternative reserves a shorter viewport
for the tutorial, preserving a visible footer at the cost of relayout. Reversal
is a small CSS change. Scroll padding must still allow lesson targets to clear
the covering sheet.

Validate actual Up/Down, settled and interrupted returns, tour navigation,
main height/opacity samples and phone layout. Type-check changed entry points,
run the existing HTML suite and package/deployment gates, then verify the live
commit and browser result. Current task: rwc-01:01m6ndqqbat4k6h676w40kepx7.

## Candidate verified, 2026-11-05

The implementation retains the old rendered workspace during deferred restoration,
then replaces it without opacity or translate animations. Main is painted from
opening onward. Closing keeps panel layout, readiness and tour content until the
cover arrives; the app layer becomes inert immediately. Teardown still removes
its DOM and listeners after coverage. App-owned CSS fixes main bottom to zero;
a scroll-tail spacer and scroll padding retain access below the tutorial.

Chromium frame samples of the built candidate at 1280×800 hold main height at
708px in both directions, full opening/closing, rapid reversal and the reduced
motion JS branch. All seven scenarios have zero blank/faded uncovered frames.
At 390×844 the height stays 752px, sheets remain mutually exclusive/inert and
there is no horizontal overflow. The tutorial's intentional demo/user selection
and Details changes remain; this change removes the repeated vertical resizing
and blank/reveal cycle, not those content changes.

Deno entry-point check, web bundle, diff whitespace and the design detector pass;
the HTML suite passes 107/107. Measurements: rwc-01
`fleet/evidence/autophys-drawer/candidate-results.json`; current packaged candidate and
HTML/Rust logs: yuzuquats `fleet/evidence/autophys-drawer/`.

## Live receipt

Private deployment is verified at `https://autophys.lona.so/app`, release
`56b0d1c-20261105`, native/source commit
`56b0d1c9fde05f8cd4a7efdba39f9e7b9a0f6de1`, web id
`a79c1e4b3bfe8cc03d211cf480ae81bb848d1f740512311dbab6657932a7b9d6`.
Public and loopback health match. Live samples repeat both Up/Down directions,
full return and reopening at a fixed 708px with zero blank uncovered frames.
Trusted keys and a 390×844 viewport also retain the proper phone sheet/inert
state and zero horizontal overflow. Native workspace gates pass: 207 passed,
0 failed, 2 ignored. HTML gates pass: 107 passed, 0 failed.

The normal deployment's broad clean-tree predicate would include a peer's
unfinished Python test/training batch. Instead, packaging used the same native
build, strip, web-build and pack steps on master after verifying committed
inputs across `src`, `sql`, `html`, `vendor`, `sdks/rust`, Cargo manifests/lock,
`tests` and `ops`, before and after building, with stable HEAD. No untracked
compiled inputs were present. A coordinated native-source hold covered that
interval and is released. Peer Python edits remain untouched and unpackaged.
The service is an embedded package, not a source/watch server. No source push.

The original mixed `hacks-carousel-align` evidence directory disappeared during
qualification for an undetermined external reason. Current test logs and the
package were rebuilt; both current measurement JSON files are retained on
rwc-01 and yuzuquats in `fleet/evidence/autophys-drawer/`. The obsolete isolated
server/tunnel are stopped. Its empty fixture-test database descriptors were
preserved separately by disk-issues at
`fleet/evidence/autophys-drawer-recovery-20261105/`; no user data was in that
isolated store. The deployed package and current verification are unaffected.

## Tutorial image depth — 2026-11-05

The operator requested a little shadow on the tutorial images. Replace the
preview frame’s explicit shadow suppression with a soft two-layer shadow
(2px/4px at 6%, 8px/20px at 10%). Applying elevation to the frame preserves
its rounded clipping and the narrow-screen image panning. Image dimensions,
drawer geometry and transition behavior stay unchanged. Validate the rendered
desktop and phone previews, then package and deploy from clean owner master.

Validation and deployment: the preview remains 320×166px at 1280×800; at
390×844 it retains the native image with a pannable 113px frame and no page
overflow. Both renders show the soft shadow. The first packaging gate exposed
a stale store-mount test expecting the former /api session cookie. Its scoped
repair now checks the live root cookie’s HttpOnly/Strict attributes and expiry
of the old /api cookie, independent of Set-Cookie order.

The normal clean-master deployment passed native workspace tests (two ignored)
and all 111 HTML tests. Release 4fed4b5-20261105 is healthy locally and publicly;
the public browser confirms the packaged shadow and loaded image. The release
also includes peer-authored d74d9a8 already committed on master. No source push.
Deployment log: fleet/evidence/autophys-drawer/tutorial-shadow-deploy.log.

## Header alignment — 2026-11-05

The operator’s header screenshot shows collapsed panel controls above the
breadcrumb and a higher demo badge. The app uses a 48px header, but collapsed
32px buttons retain the cookbook’s top:0 for its original 32px toolbar.
Give all app panel toggles an 8px top inset, matching the open-panel controls.
Center the 22px demo badge in the desktop header (93px plus safe-area inset).
The phone badge keeps its separate row above the breadcrumb to avoid overlap.
Validate both panel states, desktop and phone, then deploy from clean master.

Verified and deployed as fa4a02d-20261105 through the normal clean-master
deployment. Native workspace and 111 HTML tests pass. Public health names
fa4a02d; at 1280×800 the breadcrumb, both collapsed controls and demo badge
all center at y=104px. At 390×844 both controls and the breadcrumb center at
104px, with the badge above them. The corrected desktop layout is captured in
the thread. Deployment log: fleet/evidence/autophys-drawer/header-alignment-deploy.log.
No source push.

## Static tutorial halo — 2026-11-05

The operator requested removal of the halo animation. The app-owned target
ring styling now disables the cookbook’s 180ms geometry transition. Halos
retain their color and outline and continue following the target’s current
bounds, including clipping above the tutorial sheet, without interpolating
between positions or sizes. Validate computed motion and package the change.

Deployed as 5130812-20261105. Native workspace checks and 107 HTML tests pass.
A public-site step change sampled over 20 frames reports transition:none and
zero halo animations; public health confirms 5130812. Evidence and packaging
log: fleet/evidence/autophys-drawer/static-halo-{live.json,deploy.log}.

Packaging uses the normal deployment steps, with its clean-input predicate
excluding only the project documentation directory: a peer’s SDK brief remains
dirty and untouched. All compiled source was committed on owner master, which
stayed at 5130812 throughout packaging. The exact deployment script is retained
beside the log. No source push.

## Periodic redraw investigation — 2026-11-05

Live observation found a five-second context/pairing poll. Each unchanged context
response called Controller.updateAccess, which always notified the composition
root; all three views then redrew, replacing and hydrating the main contents.
Three observed cycles each produced 55 DOM mutations. No page-level layout-shift
entries or viewport scrollbar changes accompanied these cycles, identifying the
unnecessary redraw as the measured trigger rather than document geometry.

Compare identity and capability values before notifying. Keep the periodic
session/access checks and pairing refresh; actual access changes still redraw.
Regression coverage checks fresh objects with reordered keys, every capability
revocation/restoration, and identity changes. Validate native and HTML gates,
then deploy and repeat the idle trace across multiple polling intervals.

Qualification receipt: controller tests pass 3/3, including the new unchanged-
access regression. A second public-page probe confirmed that the next poll
removed the original card and focused jump button, dropping keyboard focus,
while viewer scrollTop stayed 300 and dimensions stayed 656×616. Evidence:
`fleet/evidence/autophys-drawer/periodic-flash-{before,focus-before}.json`.

Deployment is held, not completed. The normal pipeline stopped on the current
master's three native login tests; the HTML suite reports 111 passed and three
failures in context-boundary, display-stream and closed-store fixture contracts.
The account/UI workstream owns their repair and preserves the controller fix.
Logs: `periodic-flash-deploy.log` and `periodic-flash-html.log` in the evidence
directory. The operator explicitly confirmed the native packaging hold until
repaired gates and capacity checks pass. Yuzuquats has about 4 GiB available,
below the recorded 12 GiB floor; the disk workstream is recovering capacity and
preserves the live Autophys target. Resume native qualification and packaging
only after those prerequisites, then repeat the live trace. No source push.

## Incremental UI reconciliation — 2026-11-05

The operator requested UI diffing and deployment. Compare serialized pane
models before entering shell reflow, then reconcile authored markup by stable
IDs/roles and sibling position. Patch changed text/attributes and retain
unchanged cards, SVGs, inputs, disclosures and hydrated controls. Keep grid
and list-cell light DOM adoption explicit; setup-step sections remain slotted
light DOM so field edits can patch existing inputs. Hydrate each new marker
once. Cache tree-row accessories by row ID/content and evict removed rows.
Actual controller access changes and streamed records still update the UI.

Validation includes controller and full HTML checks, browser DOM identity,
keyboard focus/caret, disclosure state, changed fields, keyed reorders, duplicate
class keys, and the deployed periodic-refresh trace. Native packaging remains
held for cache-maintenance exclusion and repaired gates. No source push.

### Planned native qualification window

Use the existing owner master and held target
`/home/james/ssd-mount/cargo-target/autophys`; preserve every existing output
and SDK artifact. Take both the SDK campaign's
`~/.local/state/productionize/autophys-sdks-20261105/build.lock` and the service's
`~/.local/state/autophys/deploy.lock`. One Cargo invocation at a time, at most
two compiler jobs. The full workspace-test stage is budgeted for **20 GiB new
debug allocation**, followed by **12 GiB new release/packaging allocation**;
combined target growth is bounded at **32 GiB**, release-root growth at
**512 MiB**, and operation evidence at **128 MiB**. Existing retained targets
are excluded from these growth allowances, never released or reclaimed.

Before admission take fresh stable capacity samples, require at least the
32 GiB growth budget plus a 13.5 GiB reserve, verify no other native writer,
and confirm default-DENO_DIR maintenance has released exclusion. Monitor
free space and output growth every five seconds. Stop the operation before
continuing a phase if reserve falls below **13.5 GiB**, and terminate at the
unchanged **12 GiB hard stop** or any output bound. Bound the window to 30
minutes and terminate only this operation's process group on violation. Run
normal workspace/HTML/package gates; the initial failure is not waived.
Current read-only measurement is about 110 GiB free after external cleanup.

Qualification before the admitted native window: all **117 HTML tests pass**,
the route and browser-suite TypeScript checks pass, and the browser diff suite
passes **13 DOM identity/focus/caret checks**. The browser unit suite lives in
ui/ to preserve the no-layer-import contract for e2e drivers. The context
fixture now supplies the complete capability/auth shape; the stale-stream test
compares redraws across stale callbacks, independently of the legitimate
reconnect-error notification.

Cache maintenance released exclusion. The operator admitted one native window
with the recorded output budgets and existing retained target. The wrapper adds
before/after filesystem identity, sampled peak allocation and minimum free
space to the receipt. No Cargo retry is authorized. Source freeze and a clean
owner checkout remain prerequisites.

### Admitted window stopped on custody conflict — 2026-11-06 02:43Z

The exact executor release admitted owner HEAD
`8e3e848021b042a1ea2f1174e977a48aa0525294`. Fresh clean-source, no Cargo/rustc,
both nonblocking locks and three stable capacity samples passed. Dependency
identities: Cargo.lock SHA-256
`a213e9bf85f9dd72a9f0a8fe80be1eff6b6be4ab44e490f1387892ff35bc1d0f`,
html/deno.lock SHA-256
`a75c57a30c27a5e9903000176ea62efb9f8e8ff320654390440f3a4bb515e474`,
and vendor Git tree `ce9f77dd5d1e0c0bcd8dcbfdf98055ed19974880`.

All native workspace suites completed: **238 passed, 2 ignored, 0 failed**.
During the subsequent HTML run, concurrent account/tutorial UI changes appeared
in index.root.ts and vendored cookbook drawer/shell/tutorial/types. At 45.7
seconds the source monitor terminated this operation's process group. Those
peer edits are preserved, with autophys/auth asked to finish and commit them.
The one-attempt admission is consumed: **no retry, release build, packaging,
installation or service restart occurred**. The live service still reports
`6efe1f3-auth-c58c041`; incremental UI fixes are not deployed.

Free bytes before/after: **141,656,895,488 / 141,634,797,568**, sampled minimum
**141,634,613,248**. Peak target growth: **21,499,904 bytes** (debug only);
release and installation growth **0**. Evidence growth **36,864 bytes**.
All measured paths stayed on device 66306, ext4 UUID
`08226818-6142-43a3-8ab8-8f94fdee7d8e`. Existing targets and SDK artifacts
remain retained. Both native locks were verified released and Cargo absent.
The source freeze and native window are returned to productionize; a future
native attempt requires a new explicit admission and exact source freeze.

Evidence: `fleet/evidence/autophys-drawer/diff-native-{admission,window,handoff}.json`,
`diff-deploy.log`, `diff-html.log`, `diff-types.log`, and
`diff-browser-results.json`. No source push.


### Writer attribution corrected — 2026-11-06 02:48Z

Polish's initial attribution of the five endTour hunks to autophys/ui was an
unsupported inference and is withdrawn. The UI run denies owner writes and
retains only its local ignored mocks; its last owned source commit is 132bd8f.
The monitor proves a source change, not which agent wrote it.

The successful SSH Python write is established in the rwc-01 provider log at
02:43:21.612–02:43:21.688Z, command
`exec-f342e1c8-5039-46d8-ba66-067aa53470b6`, provider session
`01a1aa99-72e6-7d53-9b7b-013723828bf2`. Its exact five replacements match the
retained patch. That session maps to
[autophys/auth](t3-thread://v1/6b67785d-927e-4f2a-9044-9898649f5b9e),
in a different T3 project; its transcript confirms the walkthrough fix.
The auth owner has been asked to finish/review/commit its own hunks and return
custody before a new admission. UI has no action to commit those files.
Structured evidence, log lines, writer preimages pointer and corrected handoff
are under `fleet/evidence/autophys-drawer/endtour-writer-attribution.json` and
`diff-native-handoff.json`. No source hunks were changed, no native retry.

### Renewed operator deployment request — 2026-11-06 02:49Z

The operator explicitly requested deployment again after the stopped attempt.
Auth committed the five walkthrough-clear changes as 288b2e6. Full HTML
qualification on this source passes **117/117**, with route/browser TypeScript
checks passing. This is a new single bounded attempt, retaining the same
existing target, two shared locks, 20 GiB debug + 12 GiB release growth bounds,
45.5 GiB conservative fresh entry gate, 13.5 GiB stop reserve / 12 GiB hard
floor, filesystem/peak/before-after receipts, and 30-minute duration. Previous
attempt evidence is retained; the new wrapper and receipts use the diff2 prefix.
No automatic retry.

Before starting Cargo, require auth's completed review and exact source/test
quiescence, productionize's runtime executor release, and no competing writer.
The independent scientific protocol reviewer remains read-only and does not run
tests/imports/builds or change source/refs. Disk coordination has been notified
to exclude overlapping cleanup. All native outputs and SDK artifacts remain
protected. Source remains current owner master; no source push.

### Deployment and live stability verified — 2026-11-06 03:04Z

Deployed **8aa0252dc693852b9fd88a6a8c11192c6ecd554a**, installed release
`8aa0252-20261105`, through normal clean-owner-master deployment.
Auth independently reviewed/released 288b2e6; productionize returned exact
runtime quiescence; fresh source/capacity/competitor checks and both shared locks
passed. Full native workspace suites pass **238 tests, 2 ignored**; all
**117 HTML tests** pass. Release build, web build, pack and public health pass.
Public web ID:
`b6bd61050a77924b833229726add18540f62035103ba3a2abde209d661cdc919`.
Installed binary SHA-256:
`769071aec98d2010ca2ee33bd0f51579ba49ebeace01403e79c3c745e0976e8f`.
Exact source tree, dependency lock hashes and vendor tree are in the handoff.

The window ran **96.5 seconds**, with no source drift or limit violation.
Free before/after/minimum: **141,598,814,208 / 141,329,182,720 /
141,329,182,720 bytes**. Sampled peak debug growth **0**, release/total target
growth **69,599,232 bytes**, install growth **22,216,704 bytes**, operation
evidence growth **61,440 bytes**. Filesystem identity remained unchanged.
Both build/deploy locks were verified free, no Cargo/rustc remained, and prior
targets, SDK artifacts and installed releases are preserved. No automatic retry.

After loading the public deployment, desktop 1280×800 and phone 390×844 each
observed four actual five-second context/pairing polling cycles over 17 seconds:
**zero viewer DOM mutations, zero layout-shift entries**, retained original
card/button nodes and keyboard focus, scrollTop fixed at 300, and unchanged
viewer/document dimensions. All **13 browser reconciliation checks** also pass,
including actual Main/Details updates, charts, hydrated buttons, input caret,
disclosures, reorders and removed nodes.

The operator's reported root failure was triaged before closure. Nginx records
502s for `/`, `/app` and polling requests during the controlled restart at
18:56:16–25 PST (02:56:16–25Z), with upstream 127.0.0.1:4794 refusing connections.
Systemd restarted the new service at 18:56:25; no crash or further restart is
recorded. Current repeated public `/`, `/app` and `/api/healthz` checks all
return 200 both anonymously and using the existing signed-in demo session.
Failure session class is unavailable because proxy logs omit cookies; no
continuing 500 was reproduced. No account/database mutation, extra restart or
second build was used. Current and prior releases remain available.

Source freeze is released. The UI workstream has the disjoint header paths and
cached/frozen Deno validation window; productionize may edit the operator's
proposed SDK README/fixture-guide/project documentation scope without runtime,
test, config or lockfile changes. Drawer/account receipts remain polish-owned
through this closure. Scientific/SDK readiness and source publication are
independent; no Git push occurred.

Evidence under `fleet/evidence/autophys-drawer/`:
`diff2-deployment-handoff.json`, `diff2-native-{admission,window}.json`,
`diff2-deploy.log`, `diff2-{html,types}.log`,
`diff2-{desktop,phone}-stability.json`, `diff2-browser-checks.json`,
`diff2-root-error-triage.json`, `diff2-{public,signed}-route-checks.json`.
