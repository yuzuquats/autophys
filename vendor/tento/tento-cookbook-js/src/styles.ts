/**
 * The shell's stylesheet, installed once by run(). Tokens trimmed from the
 * hacks-site design system (client/design-system/tokens.ts, yuzuquats
 * workspace c9239fb): the platform UI stack, a neutral OKLCH ramp, no
 * webfont, light only. Every class is ck- prefixed so app components inside
 * the slots cannot collide with it.
 */
export const cookbookCss = `
:root {
  color-scheme: light;
  --ck-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif;
  --ck-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --ck-ink: #141414; --ck-secondary: #424242; --ck-muted: #8a8a8a; --ck-line: #d9d9d9;
  --ck-hover: rgb(0 0 0 / 5%); --ck-selected: rgb(0 0 0 / 8%); --ck-fill-strong: #00000014;
  --ck-n100: oklch(97% 0 0); --ck-n200: oklch(92.2% 0 0); --ck-n300: oklch(87% 0 0); --ck-n400: oklch(70.8% 0 0);
  --ck-n500: oklch(55.6% 0 0); --ck-n600: oklch(43.9% 0 0); --ck-n900: oklch(20.5% 0 0);
  --ck-ok: #356250; --ck-down: #8a5944; --ck-focus: oklch(54.6% .245 262.881); --ck-wash: #f5f5f5;
  --ck-gap: 12px; --ck-ease: cubic-bezier(.22,.61,.36,1);
  --ck-safe-top: env(safe-area-inset-top, 0px); --ck-safe-bottom: env(safe-area-inset-bottom, 0px);
}
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; height: 100%; background: #fff; }
/* Let the landing document follow native vertical scrolling/browser chrome,
   like Hacks. Clip horizontal decoration without creating a Y scroll trap. */
html { overflow-x: clip; overscroll-behavior-x: none; scrollbar-width: none; }
html::-webkit-scrollbar { display: none; }
html[data-ck-stage="tour"], html[data-ck-stage="app"],
html[data-ck-stage="tour"] body, html[data-ck-stage="app"] body { overflow: hidden; overscroll-behavior: none; }
body { font: 14px/20px var(--ck-font); color: var(--ck-ink); -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--ck-focus); outline-offset: 2px; }
[hidden] { display: none !important; }
.ck-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* header */
.ck-header { position: absolute; top: 0; left: 0; right: 0; z-index: 12; height: calc(80px + var(--ck-safe-top));
  padding: var(--ck-safe-top) var(--ck-gutter, 20px) 0; display: flex; align-items: center; pointer-events: none; }
@media (min-width: 640px) { .ck-header { --ck-gutter: 24px; } }
@media (min-width: 1024px) { .ck-header { --ck-gutter: 32px; } }
.ck-header[data-app] { position: fixed; --ck-gutter: calc(var(--ck-gap) + 16px); }
.ck-nav { position: relative; isolation: isolate; flex: 1; height: 56px; display: flex; align-items: center; justify-content: space-between;
  gap: 16px; pointer-events: auto; font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: -0.025em; }
.ck-menubar { position: absolute; inset: 0 -16px; z-index: -1; border-radius: 16px; background: #fff;
  filter: drop-shadow(0 0 1.5px rgb(0 0 0 / 38%)); opacity: 0; transform: scaleY(.86); pointer-events: none;
  transition: opacity 360ms ease, transform 700ms var(--ck-ease); }
.ck-header[data-app] .ck-menubar { opacity: 1; transform: none; }
.ck-nav-start { display: flex; align-items: center; min-width: 0; }
.ck-brand { position: relative; display: inline-flex; align-items: center; min-height: 44px; color: var(--ck-ink); text-decoration: none; flex-shrink: 0; }
.ck-header[data-app] .ck-brand { padding-left: 28px; }
.ck-wordmark { display: inline-block; }
.ck-brand-back { position: absolute; left: 0; top: 50%; width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.6;
  stroke-linecap: round; stroke-linejoin: round; opacity: 0; transform: translate(8px, -50%);
  transition: opacity 240ms ease, transform 700ms var(--ck-ease); }
.ck-header[data-app] .ck-brand-back { opacity: 1; transform: translate(0, -50%); }
.ck-crumbs { display: flex; align-items: center; min-width: 0; white-space: nowrap; opacity: 0; transform: translateX(-6px);
  transition: opacity 240ms ease, transform 700ms var(--ck-ease); }
.ck-header[data-app] .ck-crumbs { opacity: 1; transform: none; transition-delay: 120ms; }
.ck-header:not([data-app]) .ck-crumbs { visibility: hidden; }
.ck-crumb-divider { margin-inline: 10px; color: var(--ck-muted); }
.ck-crumb-current { overflow: hidden; text-overflow: ellipsis; }
.ck-nav-links { position: relative; display: flex; align-items: center; justify-content: flex-end; min-height: 44px; }
.ck-open-link { display: inline-flex; align-items: center; min-height: 44px; color: var(--ck-ink); text-decoration: none; white-space: nowrap;
  transition: opacity 180ms ease, visibility 180ms; }
.ck-open-link:hover { text-decoration: underline; text-underline-offset: 4px; }
.ck-header[data-app] .ck-open-link { opacity: 0; visibility: hidden; pointer-events: none; }
.ck-export { position: absolute; right: 0; min-height: 32px; padding: 6px 12px; border: 0; border-radius: 8px; background: var(--ck-fill-strong);
  cursor: pointer; font-size: 13px; opacity: 0; visibility: hidden; transition: opacity 240ms ease 120ms, visibility 0s linear 360ms, background-color 160ms; }
.ck-export:hover { background: rgb(0 0 0 / 12%); }
.ck-header[data-app] .ck-export { opacity: 1; visibility: visible; transition-delay: 120ms, 0s, 0s; }

/* landing surface: deck + tutorial peek */
.ck-landing { position: relative; width: 100%; height: 100vh; z-index: 11; background: #fff; overflow: clip; border-radius: 0; will-change: transform;
  transition: border-radius 700ms var(--ck-ease), box-shadow 700ms var(--ck-ease); }
.ck-landing[data-lowered] { position: fixed; inset: 0; border-radius: 32px 32px 0 0; box-shadow: 0 0 1.5px rgb(0 0 0 / 38%), 0 -8px 32px rgb(0 0 0 / 8%); }
.ck-landing-content { position: absolute; inset: 0; transition: opacity 180ms ease; }
.ck-landing[data-lowered] .ck-landing-content { opacity: 0; }
.ck-tour-peek { position: absolute; inset: 0 0 auto; height: 200px; opacity: 0; transition: opacity 240ms ease; }
html[data-ck-stage="tour"] .ck-tour-peek { opacity: 1; transition-duration: 300ms; transition-delay: 180ms; }

/* landing footer: real document content below the viewport-height deck */
.ck-footer { padding: 12px var(--ck-gutter, 20px) calc(12px + var(--ck-safe-bottom));
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0 24px;
  border-top: 1px solid var(--ck-line); background: #fff; color: var(--ck-secondary); }
@media (min-width: 640px) { .ck-footer { --ck-gutter: 24px; } }
@media (min-width: 1024px) { .ck-footer { --ck-gutter: 32px; } }
.ck-footer-name { display: flex; align-items: center; min-height: 44px; color: var(--ck-ink); font-weight: 500; letter-spacing: -.025em; }
.ck-footer-links { display: flex; flex-wrap: wrap; gap: 8px 24px; }
.ck-footer-link { display: inline-flex; align-items: center; min-height: 44px; padding: 0; border: 0;
  background: transparent; color: inherit; text-decoration: none; cursor: pointer; }
.ck-footer-link:hover { text-decoration: underline; text-underline-offset: 4px; }

/* deck */
.ck-deck { position: absolute; inset: 0; display: flex; flex-direction: column; }
.ck-deck-viewport { position: relative; flex: 1; overflow: hidden; background: var(--ck-n100); touch-action: pan-y pinch-zoom; }
.ck-deck-texture { position: absolute; inset: 0; pointer-events: none; overflow: hidden; background: #202020; }
.ck-deck-texture canvas { display: block; width: 100%; height: 100%; }
.ck-deck-track { position: relative; height: 100%; }
.ck-deck-viewport::after { content: ""; position: absolute; inset: 0; pointer-events: none; }
.ck-deck[data-moving] .ck-deck-viewport::after { box-shadow: 0 0 6px 3px rgb(0 0 0 / 12%) inset; }
.ck-deck[data-moving] .ck-deck-page { box-shadow: 0 4px 24px rgb(0 0 0 / 12%); }
.ck-deck[data-dragging] .ck-deck-track { user-select: none; -webkit-user-select: none; cursor: grabbing; }
.ck-deck-page { position: absolute; inset: 0; width: 100%; height: 100%; overflow: auto; scrollbar-width: none; background: #fff; touch-action: pan-y pinch-zoom;
  transition: border-radius 800ms cubic-bezier(.16,1,.3,1);
  padding: calc(80px + var(--ck-safe-top)) 0 calc(96px + var(--ck-safe-bottom)); }
.ck-deck-page::-webkit-scrollbar { display: none; }
.ck-deck-controls { position: absolute; left: 0; right: 0; bottom: var(--ck-safe-bottom); min-height: 64px; display: flex; align-items: center;
  justify-content: space-between; gap: 20px; padding: 8px var(--ck-gutter, 20px); font-size: 13px; }
@media (min-width: 640px) { .ck-deck-controls { --ck-gutter: 24px; } }
@media (min-width: 1024px) { .ck-deck-controls { --ck-gutter: 32px; } }
.ck-deck-counter { font: 12px/24px var(--ck-mono); font-variant-numeric: tabular-nums; }
.ck-deck-arrows { display: flex; }
.ck-deck-arrow { min-width: 36px; min-height: 44px; padding: 8px 6px; border: 0; border-radius: 999px; background: transparent; cursor: pointer;
  font-size: 16px; line-height: 24px; }
.ck-deck-arrow:hover { background: var(--ck-hover); }
.ck-deck-arrow:disabled { opacity: .3; cursor: default; background: transparent; }

/* slide template: one 576px column; eyebrow, title and description reserve
   fixed heights so the body starts at the same place on every slide. */
.ck-slide { --ck-lead-h: 254px; --ck-slide-gap: 32px; --ck-body-h: clamp(200px, 100vh - 496px, 280px);
  padding-top: max(16px, (100vh - 176px - var(--ck-lead-h) - var(--ck-slide-gap) - var(--ck-body-h)) / 2); padding-bottom: 16px; }
.ck-slide-frame { width: 100%; max-width: calc(576px + 48px); margin-inline: auto; padding-inline: 24px; }
.ck-slide-wide { width: 100%; max-width: calc(904px + 48px); margin-inline: auto; padding-inline: 24px; }
.ck-slide-eyebrow { height: 40px; margin-bottom: 24px; display: flex; align-items: flex-end; color: var(--ck-n900); }
.ck-slide-eyebrow svg { display: block; fill: currentColor; }
.ck-slide-label { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; letter-spacing: .01em; color: var(--ck-n500); }
.ck-slide-title { margin: 0; min-height: 3lh; font-size: 26px; line-height: 32px; font-weight: 600; letter-spacing: -0.025em; color: #000; text-wrap: balance; }
.ck-slide-description { margin: 16px 0 0; font-size: 17px; line-height: 26px; color: var(--ck-n600); text-wrap: pretty; }
.ck-slide-body { margin-top: var(--ck-slide-gap); }
.ck-hook .ck-slide-lead { display: flex; flex-direction: column; justify-content: flex-end; min-height: var(--ck-lead-h); }
.ck-hook .ck-slide-title { min-height: 0; }
.ck-slide-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 16px 24px; }
.ck-button-primary { display: inline-flex; align-items: center; min-height: 44px; padding: 10px 20px; border-radius: 999px; background: var(--ck-ink);
  color: #fff; text-decoration: none; font-size: 15px; font-weight: 500; transition: background-color 160ms ease; }
.ck-button-primary:hover { background: #333; }
.ck-stats { display: flex; justify-content: space-between; gap: 16px; margin: 0; }
.ck-slide-actions + .ck-stats { margin-top: 56px; }
.ck-stat-value { font-size: 24px; line-height: 32px; font-weight: 500; letter-spacing: -0.02em; }
.ck-stat-label { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--ck-n500); }
.ck-person { display: flex; align-items: center; gap: 16px; }
.ck-avatar { width: 48px; height: 48px; border-radius: 50%; background: var(--ck-n200); flex: none; }
.ck-person p { margin: 0; }
.ck-person-name { font-size: 16px; line-height: 24px; font-weight: 600; color: #000; }
.ck-segments { display: flex; gap: 3px; margin-top: 40px; }
.ck-segment { min-width: 0; }
.ck-segment i { display: block; height: 16px; background: var(--ck-n200); }
.ck-segment:first-child i { border-radius: 999px 0 0 999px; }
.ck-segment:last-child i { border-radius: 0 999px 999px 0; }
.ck-segment.ck-emphasis i { background: var(--ck-n900); }
.ck-segment p { margin: 8px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ck-cmp { width: 100%; border-collapse: collapse; font-size: 16px; line-height: 24px; }
.ck-cmp th { text-align: left; font-weight: 400; padding: 0 16px 8px 0; }
.ck-cmp td { padding: 16px 16px 16px 0; border-top: 1px solid var(--ck-n200); vertical-align: baseline; }
.ck-cmp td:first-child { width: 25%; }
.ck-cmp .ck-row-label { font-weight: 500; color: #000; }
.ck-cmp .ck-before { color: var(--ck-n500); }
.ck-cmp .ck-after { font-weight: 500; color: #000; }
.ck-demo-panel { display: grid; place-items: center; height: var(--ck-body-h); border-radius: 16px; background: var(--ck-n100); box-shadow: inset 0 0 0 1px var(--ck-n200); }
.ck-bars { display: grid; grid-template-columns: minmax(0, auto) 1fr auto; align-items: center; gap: 16px 24px; }
.ck-bars p { margin: 0; }
.ck-bars .ck-track { height: 16px; border-radius: 999px; background: var(--ck-n100); overflow: hidden; }
.ck-bars .ck-fill { height: 100%; border-radius: 999px; background: var(--ck-n300); }
.ck-bars .ck-emphasis .ck-fill { background: var(--ck-n900); }
.ck-bar-value { font-size: 20px; line-height: 28px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--ck-n500); text-align: right; }
.ck-bars .ck-emphasis .ck-bar-value { color: #000; }
.ck-bars + .ck-slide-actions { margin-top: 56px; }
@media (min-width: 640px) {
  .ck-slide { --ck-lead-h: 216px; --ck-slide-gap: 40px; }
  .ck-slide-title { min-height: 2lh; font-size: 34px; line-height: 40px; }
  .ck-slide-description { font-size: 18px; line-height: 28px; }
}
@media (min-width: 768px) { .ck-slide { --ck-lead-h: 224px; } .ck-slide-title { font-size: 36px; line-height: 44px; } .ck-stat-value { font-size: 28px; line-height: 36px; } }
@media (max-height: 760px) { .ck-cmp td { padding: 12px 16px 12px 0; } }

/* tutorial */
.ck-tour { max-width: 840px; height: 100%; margin: auto; padding: 22px 24px 12px; display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 22px; }
.ck-tour-dismiss { align-self: start; margin-left: -6px; width: 40px; height: 40px; padding: 10px; border: 0; border-radius: 50%; background: none;
  color: var(--ck-secondary); cursor: pointer; }
.ck-tour-dismiss:hover { background: var(--ck-wash); color: var(--ck-ink); }
.ck-tour-dismiss svg { display: block; width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.ck-tour-lesson { min-width: 0; display: flex; flex-direction: column; }
.ck-tour-bars { display: flex; gap: 4px; max-width: 240px; margin: 2px 0 14px; }
.ck-tour-bars i { flex: 1; height: 3px; border-radius: 999px; background: var(--ck-n200); transition: background-color 200ms ease; }
.ck-tour-bars i.ck-on { background: var(--ck-ink); }
.ck-tour-title { margin: 0 0 6px; font-size: 21px; line-height: 26px; font-weight: 500; letter-spacing: -.025em; }
.ck-tour-body { margin: 0; max-width: 46ch; font-size: 14px; line-height: 20px; color: var(--ck-secondary); }
.ck-tour-actions { display: flex; gap: 8px; margin-top: auto; padding-top: 12px; }
.ck-tour-actions button { min-height: 40px; border: 0; border-radius: 999px; font: 500 13px/20px var(--ck-font); cursor: pointer; }
.ck-tour-show { padding: 10px 16px; background: none; box-shadow: inset 0 0 0 1px var(--ck-line); }
.ck-tour-show:hover { background: var(--ck-wash); }
.ck-tour-next { padding: 10px 18px; background: var(--ck-ink); color: #fff; }
.ck-tour-next:hover { background: #333; }
.ck-target-ring { position: fixed; z-index: 13; pointer-events: none; box-shadow: 0 0 0 2px var(--ck-ink), 0 0 0 8px rgb(20 20 20 / 12%); }
@media (max-width: 600px) { .ck-tour { padding-inline: 18px; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; } .ck-tour-title { font-size: 19px; line-height: 23px; } }

/* app: sidebar, main, details */
.ck-app { position: fixed; inset: 0; z-index: 10; background: #fff; visibility: hidden; --ck-peek: 200px; }
.ck-app[data-visible] { visibility: visible; }
.ck-panels { --ck-side-width: 204px; --ck-details-width: 256px; position: absolute; top: calc(68px + var(--ck-gap) + var(--ck-safe-top));
  left: var(--ck-gap); right: var(--ck-gap); bottom: calc(var(--ck-gap) + var(--ck-safe-bottom)); }
@media (max-width: 1100px) { .ck-panels { --ck-side-width: 188px; --ck-details-width: 236px; } }
@media (max-width: 900px) { .ck-panels { --ck-side-width: 176px; --ck-details-width: 220px; } }
.ck-panel { position: absolute; top: 0; z-index: 1; display: flex; flex-direction: column; width: var(--ck-side-width); height: 100%;
  border-radius: 16px; background: var(--ck-wash); opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateX(calc(-100% - var(--ck-gap) - 8px));
  transition: opacity 400ms ease, transform 600ms var(--ck-ease), visibility 0s linear 600ms; }
.ck-panel.ck-details { right: 0; width: var(--ck-details-width); transform: translateX(calc(100% + var(--ck-gap) + 8px)); }
.ck-panels[data-open][data-sidebar] .ck-panel.ck-sidebar,
.ck-panels[data-open][data-details] .ck-panel.ck-details { opacity: 1; visibility: visible; transform: none; pointer-events: auto; transition-delay: 0s; }
.ck-panel:focus, .ck-panel-heading:focus { outline: none; }
.ck-panel-header { flex: 0 0 44px; padding: 8px 12px 4px; border-radius: 16px 16px 0 0; box-shadow: inset 0 -1px 0 var(--ck-line); }
.ck-panel-heading { min-height: 32px; margin: 0; display: flex; align-items: center; font: 600 12px/16px var(--ck-font); }
.ck-sidebar .ck-panel-heading { padding-right: 40px; }
.ck-details .ck-panel-heading { padding-left: 40px; }
.ck-panel-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 8px 12px calc(var(--ck-peek) + 8px);
  scrollbar-width: thin; display: flex; flex-direction: column; transition: padding-bottom 380ms var(--ck-ease); }
.ck-status { margin: auto 0 0; padding-top: 16px; font: 12px/16px var(--ck-font); color: var(--ck-n500); display: flex; align-items: center; gap: 6px; }
.ck-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ck-n400); flex: none; }
.ck-status[data-tone="ok"]::before { background: var(--ck-ok); }
.ck-status[data-tone="down"]::before { background: var(--ck-down); }
.ck-toggle { position: absolute; top: 0; z-index: 2; width: 32px; height: 32px; padding: 6px; border: 0; border-radius: 8px; background: var(--ck-fill-strong);
  cursor: pointer; opacity: 0; visibility: hidden; pointer-events: none; transform-origin: 0 0;
  transition: opacity 240ms ease, visibility 0s linear 600ms, background-color 160ms ease; }
.ck-toggle svg { display: block; width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.ck-toggle:hover { background: rgb(0 0 0 / 12%); }
.ck-panels[data-open] .ck-toggle { opacity: 1; visibility: visible; pointer-events: auto; transition-delay: 0s; }
.ck-sidebar-toggle { left: 0; }
.ck-details-toggle { right: 0; }
.ck-panels[data-sidebar] .ck-sidebar-toggle { left: calc(var(--ck-side-width) - 44px); top: 8px; background: transparent; }
.ck-panels[data-details] .ck-details-toggle { right: calc(var(--ck-details-width) - 44px); top: 8px; background: transparent; }
.ck-panels[data-sidebar] .ck-sidebar-toggle:hover, .ck-panels[data-details] .ck-details-toggle:hover { background: var(--ck-hover); }
.ck-main { position: absolute; top: 0; left: 0; right: 0; bottom: var(--ck-peek); min-width: 0; display: flex; flex-direction: column; gap: 8px;
  opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 260ms ease, visibility 0s linear 260ms, bottom 380ms var(--ck-ease); }
.ck-main > * { transform-origin: 0 0; }
.ck-panels[data-ready] .ck-main { opacity: 1; visibility: visible; pointer-events: auto; transition-delay: 0s; }
.ck-panels[data-sidebar] .ck-main { left: calc(var(--ck-side-width) + var(--ck-gap)); }
.ck-panels[data-details] .ck-main { right: calc(var(--ck-details-width) + var(--ck-gap)); }

/* recipes for app content (CookbookClasses) */
.ck-toolbar { display: flex; align-items: center; gap: 8px; min-height: 32px; flex-shrink: 0; }
.ck-panels:not([data-sidebar]) .ck-toolbar { padding-left: 40px; }
.ck-panels:not([data-details]) .ck-toolbar { padding-right: 40px; }
.ck-btn { min-height: 32px; padding: 6px 12px; border: 0; border-radius: 8px; background: rgb(0 0 0 / 6%); color: var(--ck-secondary);
  cursor: pointer; font: 13px/20px var(--ck-font); transition: background-color 160ms ease, color 160ms ease; }
.ck-btn:hover { background: rgb(0 0 0 / 10%); color: var(--ck-ink); }
.ck-btn.ck-btn-primary { background: var(--ck-ink); color: #fff; }
.ck-btn.ck-btn-primary:hover { background: oklch(37.1% 0 0); }
.ck-btn:disabled { background: var(--ck-selected); color: var(--ck-n500); cursor: default; }
.ck-name { margin: 4px 0 12px; font-size: 16px; line-height: 22px; font-weight: 500; }
.ck-status-text { margin: 0; font: 12px/16px var(--ck-font); color: var(--ck-n600); }
.ck-decision { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ck-list { position: relative; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ck-list-item { width: 100%; min-height: 32px; padding: 6px 10px; border: 0; border-radius: 8px; background: none; text-align: left; cursor: pointer;
  font-size: 13px; line-height: 20px; color: var(--ck-secondary); transition: color 160ms ease, background-color 200ms ease; }
.ck-list-item:hover { background: var(--ck-hover); }
.ck-list-item[aria-current="true"] { color: var(--ck-ink); font-weight: 500; background: var(--ck-selected); }

/* phones: one pane at a time; sheets slide over the main column. */
@media (max-width: 760px) {
  .ck-panels { --ck-side-width: 100%; --ck-details-width: 100%; }
  .ck-panels .ck-main { left: 0 !important; right: 0 !important; }
  .ck-panels[data-mobile="sidebar"] .ck-main, .ck-panels[data-mobile="details"] .ck-main { opacity: 0; visibility: hidden; pointer-events: none; }
  .ck-panels[data-mobile="sidebar"] .ck-details-toggle, .ck-panels[data-mobile="details"] .ck-sidebar-toggle { opacity: 0; visibility: hidden; pointer-events: none; }
  .ck-panels .ck-toolbar { padding-left: 40px; padding-right: 40px; }
  .ck-panel { z-index: 3; }
  .ck-toggle { z-index: 4; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0ms !important; transition-delay: 0ms !important; }
}
`;
