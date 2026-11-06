# What autophys needs from tento-cookbook-js, and where the cookbook stands

The app is written against the `Cookbook` namespace (operator decision N-1). The composition
root is `routes/index.root.ts` (in tento it was `app/routes/index.root.ts`). It wires `ui/` into the cookbook through those calls and
uses the client as its state. `ui/` and `client/` never import the cookbook; the boundary
tests check this.

```ts
// tutorial is mountGuidedTour(...).source, bound to the signed-in Controller.
Cookbook.mount({ tutorial, status: null }).run(app);
// inside app.mount(shell):
const view = Cookbook.View.mount(shell, new AutophysMain(shell.slots.main, ctl.handle, shell.classes), () => ctl.view().main);
ctl.subscribe(() => view.redraw());     // in app.unmount: view.dispose()
```

## What autophys uses

| Member | Use |
| --- | --- |
| `Cookbook.mount(options).run(app)` | `options.tutorial` is a `Cookbook.Tutorial.Source` with `start`/`finish`; `status: null` keeps shell health polling quiet |
| `app.mount(shell)` / `unmount()` / `export()` | mount wires the three surfaces and starts the client's Store. unmount disposes them and leaves the client's state for the next mount. export returns the client's export document |
| `shell.slots.queue / main / details` | one ui surface each |
| `shell.scope`, `shell.addStyles` | `autophysStyles(shell.scope)`, removed on unmount |
| `shell.classes` | passed to the main and details surfaces: toolbar, button, primary, name, status, decision, cardNameAttribute |
| `shell.onSelect()` | after every tree or crumb pick, so phones return to main |
| `shell.download(name, type, data)` | Export JSON and the investigation report |
| `Cookbook.View.mount(shell, view, model)` | `redraw()` on every client change, `dispose()` on unmount |

The current walkthrough uses the existing account Store and Controller. Its source
starts only after sign-in, preserves navigation and restores panels, scroll and
focus on finish; generation cancellation rejects stale startup. Project navigation
uses the sidebar tree. Export/report actions belong to the relevant investigation,
and the shared header Export is removed at mount. The observations below describe
the earlier cookbook contract, not an instruction to restore fixture controllers.

## Historical gaps against the cookbook as built (tento 561cad2f5)

1. **FLIP reaches only the main slot's direct children, and only if they survive the
   change.** `Motion` measures `[...slots.main.children]` before and after `reflow(change)`.
   A view that rebuilds its children (`innerHTML`) leaves the measured elements detached, so
   nothing animates. `AutophysMain` now keeps its three children (toolbar, viewer, credit)
   and updates them in place, so they do move. Nothing deeper moves: the panels and charts
   inside the viewer, the tree rows and the Details sections all jump. The cookbook needs a
   way to FLIP elements inside slots that it did not create, for example a `[data-flip]`
   opt-in (key plus mode) that `reflow` collects and matches by key across the change.
   `View.mount` already routes every redraw through `reflow`, so no app change would be
   needed.
2. **The sidebar and details slots never FLIP.** A panel toggle animates only main's
   children. The queue and details contents do not move with their panel.
3. **Tutorial targets inside slots work, but only because the slots are light DOM.**
   `findVisible` uses `document.querySelectorAll`, so autophys's steps can point at
   `#ap-switch`, the tree, `.ap-viewer` and `#ap-action-approve` (`routes/content.ts`). The
   catches: a step whose target is not mounted yet (the app mounts only when the drawer
   opens) is skipped silently, and a slot rendered into a shadow root would break every
   target. Proposed contract: a target may name an element inside any slot, and the cookbook
   resolves it at the moment the step is shown.
4. **`options.tutorial` replaces the shell's steps**, so an app that wants both concatenates
   `Cookbook.Tutorial.shellSteps` itself, as autophys does.
5. **No phone review card.** The decision row is rendered for one (exactly two direct
   buttons, `classes.decision`, `data-card-name`, `classes.status`), but the cookbook does not
   mirror it yet. See the reply below.

## Reply from tento-cookbook-js (2026-11-04)

`tento-cookbook-js` now exists (tento `b9ea13c92`, project `tento-cookbook`). Its
`CookbookHost`, `CookbookApp` and `CookbookShell` assign to the types in
`cookbook-contract.ts` without errors (checked with a throwaway `deno check`), and
`import { cookbook } from "@tento-cookbook";` resolves through the root `deno.json`.
No `globalThis.tentoCookbook` is installed. Where it differs from this page:

- **Phone review card: not implemented.** `classes.decision` (`ck-decision`) styles the two
  buttons as a pair, `classes.status` and `classes.name` exist, and `cardNameAttribute` is
  `data-card-name`, but nothing mirrors the row into main on phones yet. The markup this page
  describes is enough for the mirror to be added in the cookbook later without app changes.
- **Resize: not implemented.** Panels collapse (with FLIP on the main slot's direct children)
  but have no drag handles.
- **Mount timing.** `run()` builds the shell immediately, but calls `mount(shell)` only as the
  drawer starts to open the app (Open app, ArrowDown, or a URL under `/app`), with freshly
  emptied slots. It calls `unmount()` once the deck has settled back, then empties the slots.
  Emptying them is the shell's only touch on slot contents after mount, apart from FLIP
  transforms on main's direct children.
- **scope** is `.ck-app[data-cookbook="<id>"]`. `addStyles` appends to `document.head`, so
  there is no shadow root.
- **Network.** The shell makes no calls for the app. Its own sidebar status line reads
  `GET /api/healthz`. `createCookbook({ status: null })` turns that off.
- **Extensions** (optional): `shell.setCrumb?(text)` sets the header breadcrumb after the
  wordmark, `shell.reflow?(change)` runs a main-slot layout change with FLIP, and
  `classes.list` and `classes.listItem` are the shell's list recipes.
- The deck and tutorial default to neutral placeholders named after `app.title`.
  `createCookbook({ deck: (app) => slides, tutorial: steps })` replaces them.

### Concrete API after N-1 (tento `561cad2f5`)

The public API is now one namespace, `Cookbook` (operator decision N-1). `cookbook` and
`createCookbook()` were removed with no aliases, so the snippet at the top of this page becomes:

```ts
import { Cookbook } from "@tento-cookbook";
Cookbook.mount().run(app);                  // Cookbook.mount(options?): Cookbook.Host
```

| Member | What it is |
| --- | --- |
| `Cookbook.mount(options?)` | returns a `Cookbook.Host`; `host.run(app, { root? })` builds the shell and runs the app |
| `Cookbook.App`, `.Shell`, `.Slots`, `.Classes`, `.Host`, `.Options`, `.Stage` | types; `App` and `Shell` still assign to `cookbook-contract.ts` in both directions (checked) |
| `Cookbook.View.mount(shell, view, model)` | optional. `view: Cookbook.View.Renderer<M>` is `{ render(m: M): void; destroy(): void }`. It renders `model()` once, immediately, and returns `Cookbook.View.Handle = { redraw(): void; dispose(): void }`. `redraw()` reads `model()` again and renders inside `shell.reflow` (FLIP on main's direct children), or directly if the shell has no `reflow`. `dispose()` calls `destroy()` once; later `redraw()` calls do nothing. Call `dispose()` from `unmount()`. Slots stay opaque (AX-1): apps may fill them without it. Views that update their elements in place let FLIP follow them |
| `Cookbook.classes` | the class recipes, also on `shell.classes` |
| `Cookbook.PlaceholderApp` | a vanilla app (neutral rows, text, status), drawn with `View.mount` |
| `Cookbook.Deck` | `Slide`, `Body`, `Stat`, `Bar`, `Cta`; `placeholderDeck(title, appPath?)` |
| `Cookbook.Tutorial` | `Step`; `shellSteps` |
| `Cookbook.Status` | `Line`, `Healthz`; `readHealthz`, `parseHealth`, `describeHealth` |
| `Cookbook.Motion.settleIn(el)` | the short fade-and-rise used for new content |

Everything else in the reply above is unchanged by N-1. The phone review card and panel resize
handles are still not implemented, and mount happens on open with unmount after close.
