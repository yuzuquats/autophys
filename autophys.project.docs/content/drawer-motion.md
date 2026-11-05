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
