# Autophys browser architecture

The workbench uses the daemon's `/api/v1/workspace` snapshot and resumable record
stream. Signing in as the demo account opens the seeded server workbooks through
exactly the same API. There is one production Source and one Controller; an empty
or disconnected collection stays empty or shows recovery UI.

## Layers

- `routes/index.root.ts` composes the cookbook shell, account state and views.
  The header sign-in uses lona-js Dialog/Overlay and the shared native form.
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
is enforced by the server on writes. All currently authenticated accounts access
one collection of `<slug>.ap-workbook` SQLite files; project ownership and per-user
collection isolation are not implemented. Login grants access to that collection.

Each workbook holds configuration versions, investigations, measurements, fits,
proposals, decisions and validation records. The Rust/Python SDK computes results
and records them; the browser presents them.

## Build and checks

```sh
deno check --config html/deno.json html/routes/index.root.ts
autophys build-web --out <owned-output>/web/autophys
```

The maintained daemon/browser drivers in `e2e/` use isolated SDK-seeded daemons.
Test suites require separate authorization when the operator requests build-only
validation. See [contributor setup](../CONTRIBUTING.md) and
[the UI implementation record](../autophys.project.docs/content/ui.md).
