# Back-button performance — 2026-11-04

The header arrow and browser Back both close the cookbook drawer. Returning
while the guided tour was active blocked the main thread for seconds: each
scroll restore walked the whole document (including the large documentation
shadow tree), and searched all saved paths for every visited element. It ran
immediately, on the next animation frame and again after 400 ms.

Restore now resolves saved child/shadow paths directly, within `.ck-app` only.
Window scroll remains the separate snapshot field. Zero offsets are preserved;
missing nodes are skipped. The tour's next-frame readiness, reused halo and
static preview images remain intact.

App-owned CSS in brand.ts also keeps the viewport-height landing in document
flow while translated away, reserves the arrow space and shares header gutters.
This removes the docs/logo jump. The landing's full-surface radius/shadow CSS
transition is disabled; its compositor transform animation remains. No vendor
files changed.

The docs shell uses content-visibility with its measured intrinsic content height
while the app is open. This preserves document height and natively suppresses
focus/accessibility of hidden contents without toggling inherited inert over the
entire documentation shadow tree. A live injected candidate reduced the 6×
plain-app return to 16.8 ms, zero long tasks and zero raw layout shift.

## Measurement and validation

Chrome 130 on yuzuquats, 1440×900, live demo sign-in. `withHeadless` owns the
browser; rAF deltas plus longtask, layout-shift and long-animation-frame
PerformanceObservers run across each return, alongside a DevTools timeline.
No tests or e2e were run, per operator direction. `deno check --config
html/deno.json html/routes/guided-tour.ts html/routes/brand.ts html/routes/docs.ts` passed.

Baseline live commit: 6ae89e75ff1f6c7889768444f46544fcc5e0d00f.

| Transition | CPU | Worst rAF gap | Long tasks | Raw shift sum | CLS |
| --- | --- | ---: | ---: | ---: | ---: |
| App arrow | native | 16.8 ms | 0 | 0.625 | 0 |
| Browser Back | native | 16.8 ms | 0 | 0.625 | 0 |
| Active-tour arrow | native | 6066.4 ms | 2 | 0.625 | 0 |
| App arrow | 6× | 66.7 ms | 1 | 0.625 | 0 |
| Browser Back | 6× | 83.3 ms | 1 | 0.625 | 0 |
| Active-tour arrow | 6× | 40281.8 ms | 2 | 0.625 | 0 |

CLS excludes recent-input shifts; raw shift sum is recorded too so the visible
jump is not concealed by that exclusion. The slow-CPU plain-app trace also
shows an approximately 49 ms docs style recalc when native inert is removed;
that is distinct from the quadratic tour stall.

Full before/candidate traces, the measurement script, and final live deployment
receipt are retained on yuzuquats under `~/.cache/autophys/back-perf/`. Final
verification is healthz matching the committed clone plus one live measurement
of each back path, with the same viewport and observers. No source push.

## First live receipt and browser-scroll follow-up

Commit 304bb3e was live at 17:00 PST. At native CPU speed all four returns
(app arrow, app history Back, active-tour arrow and active-tour history Back)
measured 16.8 ms worst rAF gap, zero long tasks and CLS 0. The active-tour
arrow fell from 6066.4 ms to 16.8 ms. Tour exit retained only about 0.0012
raw shift from panel content moving during the exit animation.

History Back exposed a second scroll owner: native history restoration ran
after the drawer's popstate callback and moved to scrollY 900 (app) or 700
(tour), making the newly visible docs appear in the viewport. App-owned manual
history restoration leaves the drawer in charge. A live injected measurement
of this correction returned to the deck with a 16.8 ms worst frame, no long
tasks, CLS 0 and raw shift 0. The final committed deployment receipt and all
four repeat measurements live in the evidence directory linked above.

The optional 6× CPU stress run of 304bb3e retained up to a 116.6 ms frame on
tour exit (down from 40281.8 ms); native-speed runs meet the requested 50 ms
frame target. Those remaining throttled costs are synchronous tour redraw and
layout, rather than the removed quadratic restore. No extra tests were run.

## Initial Details drawer flash — 2026-11-04

Opening the workbench briefly exposed Details before the first tour lesson
closed it. The shell defaults to Details open, while the opening lesson needs
it closed; the lesson previously applied its layout only after awaiting the
fixture and preview image. A live browser trace measured an 87 ms open/close
gap on c2bd1c7.

The tour now captures the user's panel state and applies its opening layout
synchronously before loading data or images. That layout is shared with the
first lesson, so the two cannot drift. Tour exits still restore the captured
state, including an exit while the preview is loading. No vendor files changed.

Validation: Deno type checks and diff whitespace checks pass. In an isolated
browser build at 1280×800, animation-frame sampling with image decode delayed
by 1500 ms showed Details closed from the first open frame through lesson
readiness. The next lesson still opened it, dismissal restored the original
open state, and immediate dismissal during loading preserved a manually closed
state without a late tour restart. At 390×844, direct launch showed the sidebar
lesson and dismissal returned to the main pane with no horizontal overflow.
No test suites were run, preserving the earlier operator direction.

## Immediate Down-arrow layout and content reveal — 2026-11-04

Down from the tour synchronously rebuilt the restored workspace before the
shell could start its transition. Down in the full app had no action at all,
so a closed Details panel stayed closed. The app now opens Details on Down in
either state, ignoring editable fields, modifiers, composition and key repeats.

Tour exit restores the controller and panel flags immediately, then schedules
the workspace rebuild in a task after the first animation frame. Pending regions
are hidden and inert; the current controller renders once without repeated
view FLIP measurements, and the contents enter with a 180 ms opacity/4 px reveal.
Panel frames move in 240 ms. Reduced motion removes panel transitions and uses
an 80 ms opacity-only content reveal. Pending work and animations are cancelled
on replacement or teardown. No cookbook vendor files changed.

Focused browser verification at 1280×800 measured the tour-to-app key handler
at 4.9 ms, down from 30.6 ms on the live baseline. The first frame at 6 ms already
had Details open and content pending. The following render produced a 51.7 ms
frame gap; this change moves that work after the initial layout paint rather
than claiming to eliminate chart rendering cost. Content animations were active
after rendering and pending markers cleared. Down also reopened a manually
closed panel; repeated Down left it open, and a focused input retained native
Down behavior without opening Details.

At 390×844 the first frame selected the Details sheet, with main inert and
Details interactive after rendering, and no horizontal overflow. Desktop and
mobile visual checks passed. Rapid Up/Down reversals returned to the app with
current content and no pending markers; Back during deferred rendering settled
on the landing with no pending content or late tour revival. Deno type checks,
diff whitespace checks and the Impeccable detector passed. No test suites run,
preserving the operator's build-only instruction.

## Remaining tour-entry stall and surface finish — 2026-11-05

The follow-up measurement found the earlier fix covered tour exit but left
entry blocked by seeded scientific computation. Live ArrowDown from the landing
took 553 ms; ArrowUp from the app took 482–509 ms before its first frame.
The fixture Source built its simulations synchronously inside Store.start().
Returning to the landing also removed shadow and radius immediately.

Browser fixture consumers now share a dedicated worker's computed workspace.
Each Source retains its own record stream and decisions; the worker terminates
after completion, and failed loads can retry. The pure fixture Source accepts
an optional precomputed workspace and retains its existing default. Tour entry
yields a paint even with cached data, coalesces selection/layout into one draw,
and no longer draws an intermediate controller state. Each workspace redraw
derives the three surfaces once rather than four times. Opening an already
rendered Details panel no longer rebuilds its content.

The surface retains its 32 px corners and full shadow throughout a return.
An app-owned observer waits for the actual transform animation to finish,
then lets radius and shadow dissipate over 650 ms. Reversals invalidate the old
completion callback. Reduced motion keeps the immediate final state.

Focused browser measurements at 1280×800 on the final isolated build:

| Transition | Handler | First frame | Worst frame gap | Long tasks |
| --- | ---: | ---: | ---: | ---: |
| Landing → tour (cold worker) | 10.3 ms | 10.5 ms | 44.4 ms | 0 |
| Tour → app | 4.1 ms | 9.5 ms | 21.4 ms | 0 |
| App → tour (cached worker) | 1.6 ms | 3.9 ms | 24.0 ms | 0 |
| Tour → landing | 4.2 ms | 13.5 ms | 31.2 ms | 0 |

Frame sampling held radius at 32 px while the return transform was nonzero.
Only at y=0 did it begin reducing (28 px, 14 px, 4 px, then 0), with the shadow's
opacity decreasing alongside it. Desktop and 390×844 mobile visual checks,
reversal during ascent, leaving while worker execution was delayed, cached
reentry and unavailable-worker retry passed. Delayed completion did not revive
the tour, and its worker terminated. The zero-duration reduced-motion branch
settled at y=0 without retaining the returning flag. Deno checks, web bundling,
diff whitespace and the design detector passed. No test suites run.
