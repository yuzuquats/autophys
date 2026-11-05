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
