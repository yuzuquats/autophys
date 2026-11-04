# tento-cookbook-js

A reusable app shell: **header**, **pitch deck**, **sidebar**, **details**,
first-visit **tutorial**, and the FLIP motion that joins them. It carries no
product content. An app fills three slots and, if it wants, passes its own
deck and tutorial; otherwise it gets neutral placeholders.

The pieces were pulled from the hacks-site client (yuzuquats workspace
`c9239fb`: `client/chrome.ts`, `home-deck.ts`, `home-carousel.ts`,
`app-drawer.ts`, `app-panels.ts`, `workbench/motion.ts`, `app-tutorial.ts`,
`design-system/tokens.ts`) and rewritten as plain TypeScript with no
tento-ui or tento-brand dependency. Project record:
`projects/tento-cookbook.project.docs`.

## Running an app

The whole public API is one namespace, `Cookbook` (the tento-ui convention,
as in `export namespace TreeList`; operator decision N-1, 2026-11-04).

```ts
// html/routes/index.root.ts (the browser entry point)
import { Cookbook } from "@tento-cookbook";
Cookbook.mount().run(myApp); // or Cookbook.mount(options).run(myApp, { root: someElement })
```

`Cookbook.mount(options)` returns a `Cookbook.Host`. `Cookbook.Options`
takes `deck(app)`, `tutorial` steps, `appPath` (default `/app`), `status`
(default GET `/api/healthz`; `null` hides it), panel `labels` and `onStage`.
`Cookbook.PlaceholderApp` is a vanilla app (neutral rows, text, status) to
start from.

The flow has three stops. The deck fills the screen. **Open app**, ArrowDown
or a URL under `appPath` lowers the deck to a 200px peek carrying the
tutorial, while the sidebar and details slide in. **Done**, the close button,
Escape or ArrowDown lower the peek away. The wordmark, Back or ArrowUp go
back. Opening and closing push history (`/` and `appPath`), so the server
must answer both with `index.html`.

## The namespace

```review-table
| Member | What it is |
| ------ | ---------- |
| `Cookbook.mount(options?)` | builds a `Cookbook.Host`; `host.run(app, { root? })` builds the shell and runs the app |
| `Cookbook.App` | `id`, `title`, `mount(shell)`, `unmount()`, `export()` |
| `Cookbook.Shell` | `slots`, `scope`, `classes`, `addStyles`, `onSelect`, `download`; extensions `setCrumb?`, `reflow?` |
| `Cookbook.Slots`, `Cookbook.Classes`, `Cookbook.Options`, `Cookbook.Host`, `Cookbook.Stage` | the types |
| `Cookbook.View.mount(shell, view, model)` | optional helper; returns `Cookbook.View.Handle` |
| `Cookbook.View.Renderer<M>` | `{ render(m: M): void; destroy(): void }` |
| `Cookbook.classes` | the class recipes, also on `shell.classes` |
| `Cookbook.PlaceholderApp` | the vanilla app |
| `Cookbook.Deck` | `Slide`, `Body`, `Stat`, `Bar`, `Cta` types; `placeholderDeck(title, appPath?)` |
| `Cookbook.Tutorial` | `Step` type; `shellSteps` (the default) |
| `Cookbook.Status` | `Line`, `Healthz` types; `readHealthz`, `parseHealth`, `describeHealth` |
| `Cookbook.Motion.settleIn(el)` | the short fade-and-rise used for new content |
```

### `Cookbook.View.mount(shell, view, model)`

Draws `view.render(model())` once, immediately. Each `handle.redraw()` reads
`model()` again and renders inside `shell.reflow`, so the main column's
children move with FLIP (a shell without `reflow` renders directly).
`handle.dispose()` calls `view.destroy()` once; later `redraw()` calls do
nothing. Call `dispose()` from the app's `unmount()`. It is optional:
the shell does not inspect slot contents, and an app may fill them however it likes. Views
that update their elements in place, rather than replacing them, let FLIP
follow those elements.

## The slot contract

The contract an external app implements is the `Cookbook.App` / `Cookbook.Shell`
types in `src/types.ts`, exposed through the public `Cookbook` namespace.

```review-table
| Member | What the shell does |
| ------ | ------------------- |
| `app.mount(shell)` | called as the drawer starts to open, with three freshly emptied slots |
| `app.unmount()` | called once the deck has settled back after closing; then the slots are emptied |
| `app.export()` | the header's **Export** button saves it as `<id>-export.json` |
| `shell.slots.queue` | sidebar body; the shell keeps the panel header, collapse toggle and status line |
| `shell.slots.main` | main column; its direct children move with FLIP when a panel opens or closes |
| `shell.slots.details` | details panel body |
| `shell.scope` | `.ck-app[data-cookbook="<id>"]`, an ancestor of every slot |
| `shell.classes` | `toolbar`, `button`, `primary`, `name`, `status`, `decision`, `cardNameAttribute`; extensions `list`, `listItem` |
| `shell.addStyles(css)` | appends a `<style>` to the document head; returns its removal |
| `shell.onSelect()` | on phones, returns from a sheet to the main pane |
| `shell.download(name, type, data)` | saves a file via a Blob link |
| `shell.setCrumb?(text)` | extension: breadcrumb after the wordmark |
| `shell.reflow?(change)` | extension: run a main-column layout change with FLIP |
```

Not provided: the phone "review card" that mirrors a two-button `decision`
row into main, and panel resize handles. No `globalThis.tentoCookbook` is
installed; import the module.

## Building and testing

```sh
deno test --no-lock tento-cookbook-js/
deno run --no-lock --allow-read --allow-write --allow-run --allow-env tento-cookbook-js/build.ts \
  --root <file.root.ts> --out <dir> [--title <name>] [--config <deno.json>]
```

`build.ts` type-checks the root, bundles it with `deno bundle`, and writes
`index.html` (from `index.anon.html`, with the title filled in) beside
`index.root.js`. The demo root is `demo/routes/index.root.ts`.

The deck uses the Hacks carousel's per-page depth and bounded endpoint pulls,
with a texture-js ASCII well visible during motion. The required dependency is
`tento-texture-js/backgrounds/canvas.ts` and its `palettes.ts` type import;
consumer vendor recipes must include both. No p5 runtime or network asset is
loaded. Reduced motion paints a static texture and skips navigation animations.

Evaluate `checks/check-deck.js` on a cookbook landing page at desktop and phone
sizes to check navigation, touch policy, interruption, endpoints and texture
pause behavior. Its pointer events are synthetic; trusted click/keyboard and
physical Safari checks are separate qualifications.

Evaluate `checks/check-page-scroll.js` to check whole-page header/control
movement and saved document offsets across app opening, closing and interrupted
reversal. Its taller landing probes a layout viewport exceeding the visible
area; physical browser chrome and elastic scrolling require device checks.
The landing allows native vertical document behavior; the app and tutorial
stages lock the document and keep their own scrollable panels.
