# Autophys browser architecture

The workbench uses the daemon's `/api/v1/workspace` snapshot and resumable record
stream. Signing in as the demo account opens the seeded server workbooks through
exactly the same API. There is one production Source and one Controller; an empty
or disconnected collection stays empty or shows recovery UI.

## Layers

- `routes/index.root.ts` composes the cookbook shell, account state and views.
  The header sign-in uses lona-js Dialog/Overlay and the shared native form.
  `routes/guided-tour.ts` runs the cookbook walkthrough on that same Controller.
  Its lessons adapt to the selected project's recorded data and restore navigation
  on exit. The Walkthrough action reopens it; signed-out visitors sign in first.
- `client/api.ts` owns authenticated network calls: workspace, SSE, decisions,
  project creation and device pairing. The browser carries an HttpOnly session cookie.
- `client/wire.ts` maps server records and configuration into plain domain objects.
- `client/store.ts` holds the snapshot, folds records in sequence order, deduplicates
  POST responses and SSE echoes, and notifies subscribers.
- `client/controller.ts` converts UI intents into selection changes or API calls.
- `client/derive/` converts snapshot plus selection into sidebar, main and details
  models. It formats uploaded numerical results and interpolates proposal outlooks.
- `ui/` renders those models and emits intents. It does not fetch or simulate.

`client/fixtures/` contains deterministic inputs for numerical and rendering tests
only. No route imports them and they are not bundled into the app. The SDK's
built-in simulators remain available for creating real persisted investigations.

## Account and persistence boundary

The daemon stores accounts and sessions in `server.db`. `POST /api/auth/demo`
creates a normal browser session for the configured demo user. Its read-only flag
is enforced by the server on writes. The bootstrapped context binds the Source to
its workspace and principal; snapshots, reference refreshes and reconnect probes
verify both identities. The controller is replaced when account context changes.
Workbooks are resolved within the authenticated workspace; login does not grant
access to an arbitrary collection.

A dropped record stream immediately reports a connection error while retrying from
the last cursor. Existing records stay visible, and decisions pause. The current
Store retains this error until an explicit workspace refresh or the page's Retry
reload; a successful EventSource open alone does not clear it.

The sidebar's project roots replace the old select-input switcher. New project
setup uses the shared Stepper and preserves SDK configuration guidance, including
the thermal starter. These controls use the signed-in Controller and never swap
in a fixture data source.

Each workbook holds configuration versions, investigations, measurements, fits,
proposals, decisions and validation records. The Rust/Python SDK computes results
and records them; the browser presents them.

## Build and checks

```sh
deno check --config html/deno.json html/routes/index.root.ts
autophys build-web --out <owned-output>/web/autophys
```

The maintained daemon/browser drivers in `tests/e2e/` use isolated SDK-seeded daemons.
Test suites require separate authorization when the operator requests build-only
validation. See [contributor setup](../CONTRIBUTING.md) and
[the UI implementation record](../autophys.project.docs/content/ui.md).
