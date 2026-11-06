# Account workspace operations and qualification

The account selects one persisted collection. A local daemon uses its configured collection without cloud login. Cloud sessions and device keys resolve an account/workspace binding on every request; clients never select a server filesystem path. “Continue as demo” creates the normal session for the configured read-only account. It does not seed records, change data sources or start a walkthrough.

Native implementation checkpoint: `82831c6`; frontend checkpoint: `8f83b70`. Production was deployed on 2026-11-05 from `6efe1f3`. The implementation qualification below predates that cutover; the production result is recorded next.

## Production deployment — 2026-11-05

Live at https://autophys.lona.so/app. The native binary and embedded browser payload are pinned to commit `6efe1f3eb0659c27dd0f8c092f183b5826aca1a8`; later peer edits were excluded. Public `/api/healthz` reports web ID `503e4624bcd29e72e240c5fd19bea7a0c22a8cc8140badbba117f5622295ee3a`.

Schema v5 repaired the demo account's read-only flag. Its existing collection at `/home/james/autophys` was registered in place: `battery_cycler_demo`, project `prj_63f1a2034c21136b`, all 29 records and their IDs were preserved. No seed import ran. James's account was assigned its own initially empty collection at `/home/james/.local/share/tento/autophys/workspaces/u_027e68487fca`. Mapping revoked previous sessions; there were no existing keys or pairings.

The packaged release passed a focused real-daemon rehearsal against isolated production copies: demo writes/job starts/device approval were denied, ordinary workspace writes and a native investigation succeeded, and foreign project access was refused. Public browser checks confirmed normal demo sign-in, 29 persisted records, write denial, explicit walkthrough launch, all ten walkthrough steps using account records, and a 390 px mobile layout without document overflow. Reload restored the demo session without starting the walkthrough. The owned preview tab was closed. No test suites ran; SDK campaign acceptance remains unverified.

Deployment evidence, source/build identity, qualification and owner-only SQLite backups are retained at:

`/home/james/workspace/scratch/autophys-account-deploy-3e79416b743e417ba9000675932916f6.scratch-entry/content`

See `deployment.json`, `build-result.json`, `release-qualification.json`, `public-browser-qualification.json` and `backups/`. The installed release is `/home/james/.local/share/tento/services/autophys/6efe1f3-20261105`; the previous release remains retained. Recovery must preserve matching ownership metadata and collection state, as described below.

The exclusive native build window is closed. Its completion receipt at `~/.local/state/productionize/autophys-sdks-20261105/repair-round-1-qualification/deploy-window-completion.json` records 17.805 GiB free at handoff, unchanged native inputs and retained SDK artifacts, and no further auth Cargo/native source or target writes. The SDK owner received the handoff and must freshly check its gates before resuming.

## Profile control refinement — pending deployment

The signed-out server link is now hydrated before the header paints into the same `details > summary.ap-acct-btn > .ap-acct-avatar` structure as the signed-in control. Both use the existing 36 px circular button, hover and focus styling; the anonymous avatar shows a neutral profile silhouette. Sign-in still opens the shared modal, and dismissal restores focus to the summary.

Deno type-checking, a focused browser bundle and the design detector passed. An isolated collaborative-browser check using that actual module plus production server markup/CSS confirmed matching dimensions before and after normal demo sign-in, Enter/Escape handling, focus restoration and a 390 px mobile layout without overflow. Evidence: the deployment scratch entry's `profile-control/qualification.json`. No native source, Cargo target, service or deployed browser bundle was changed by this refinement.

## Configure a profile or workspace

All examples run on the server with its intended server database. Replace the paths and account addresses deliberately. Mapping, key, profile and seed commands preview by default; add `--apply` only to apply that specific operation. Opening an older server database applies the additive metadata schema migration even for `workspace list`; dry-run refers to the requested mapping/profile/import.

```sh
autophys workspace list --server-db /srv/autophys/server.db
autophys workspace profile local --name 'Operator' --avatar /profile.png --server-db /srv/autophys/server.db
autophys workspace profile person@example.org --name 'Person' --server-db /srv/autophys/server.db
autophys workspace bind person@example.org --collection /srv/autophys/collections/person --server-db /srv/autophys/server.db
autophys workspace key KEY_ID person@example.org --write --server-db /srv/autophys/server.db
```

Profiles use a photo URL or initials; no stock portrait or external avatar service is inserted. Avatar values must be HTTPS or same-origin image URLs. The menu has the same account control in local/cloud mode, generic Read-only text when appropriate, and cloud sign-out when available.

Newly created cloud users receive empty default collections beside the server database under `workspaces/<user-id>`. Existing users are deliberately left unassigned until an operator reviews and applies their mappings. Unmapped cloud credentials fail closed. Local legacy keys retain compatibility only with local daemon mode. Bind or reissue legacy cloud keys explicitly; a key's grant cannot exceed its owner's current access.

## Migrate an existing installation

Before running the new binary against production, inventory the current server database, collection, active keys and intended owners. Stop writers for the cutover and retain a consistent SQLite backup including WAL contents. Do not use an ordinary copy of only the main database while writers are active. Retain the corresponding collection and mapping inventory for recovery.

Run `workspace list`, review each `workspace bind` dry-run, then apply each approved mapping. The report lists existing project IDs/names without opening workbooks for write/migration. Each applied bind first creates an owner-only SQLite server-database backup beside the server database and reports `server_database_backup`. It registers the existing collection in place, preserving workbook records and IDs. Overlapping registered collections are refused. A changed root revokes the account's sessions and delegated keys.

Review and explicitly adopt/reissue keys after collection assignment. Confirm each account's context, project counts, representative record/blob reads, denied foreign IDs and write permissions before admitting traffic. Do not map one collection to several accounts as an isolation shortcut. Restoring an older shared-collection server after multi-account cutover is not a safe rollback; recover matching server metadata, collection state and ownership together.

## Seed the persisted demo account

Configuring public demo access forces read-only and invalidates affected prior sessions/delegated keys. Attempts to make an enabled demo account writable are rejected. Disabling public demo access prevents new public sign-ins.

```sh
autophys users set demo@example.org --demo --server-db /srv/autophys/server.db
autophys workspace profile demo@example.org --name Demo --server-db /srv/autophys/server.db --apply
autophys workspace seed demo@example.org --from /srv/autophys/seed-source --version thermal-v1 --server-db /srv/autophys/server.db
autophys workspace seed demo@example.org --from /srv/autophys/seed-source --version thermal-v1 --server-db /srv/autophys/server.db --apply
```

The source is an operator-maintained collection of real recorded workbooks. Apply during a writer/serving maintenance window. SQLite online backup captures workbook WAL pages into a staging collection; an atomic directory rename adopts the seed only over an empty target. Same-version replay skips import. An occupied target is refused, including a different version; replacement/reset is a separate operation. Interrupted imports retain their stage for inspection. A failure after adoption but before version metadata can require explicit operator reconciliation; it does not overwrite the adopted records on retry.

No source seed dataset is embedded in the application, and this implementation does not seed production automatically. Existing demo users also need an explicit workspace assignment before sign-in can succeed.

## What was qualified

Evidence is retained on yuzuquats at:

`/home/james/workspace/scratch/autophys-account-qualification-acf0bc69aec140c89a46a2d6a32878c4.scratch-entry/content`

| Evidence | Result |
| --- | --- |
| Rust binary build | Passed against the shared owner checkout; two existing dead-code warnings. |
| Deno entry check and web build | Passed. No test suites ran. |
| `api-qualification.json` | Separate alpha/beta snapshots; foreign project/blob IDs refused; demo and ordinary read-only writes, job starts and device approval denied; paired key scoped to approver and loses write access when owner becomes read-only. |
| Persisted demo collection | Versioned import of one project and ten records from an isolated simulator run; replay skipped; browser reload uses persisted records. |
| `migration-qualification.json` | Schema v4 migration preserved legacy account and repaired demo read-only; mapping dry-run made no assignment; explicit mapping preserved the existing collection; writable demo override refused. |
| `final-qualification.json` | Applied mapping backup exists with mode 0600; dry-run created no backup; replacing a session closed its old SSE stream and old-cookie reads returned 401. |
| Collaborative browser | Local configured photo, broken cloud-photo initials fallback, mobile menu and toolbar, normal demo sign-in, explicit nine-step walkthrough using actual project/investigation names, Dialog/Overlay panel focus without credential autofocus. |
| `delayed-browser-qualification.json` | With workspace fetch delayed 1.8 s, app stage sampled at 33 ms and panels ready at 410 ms, before data at 1866 ms; no sign-in form flash. These are one-run observations, not latency benchmarks. |

The walkthrough only navigates records in the Store. Empty/read-only guidance and capability guards are shared with normal accounts. A new identity closes the old Store, clears snapshots/cursors/navigation and pending edit state, cancels the walkthrough and rejects stale callbacks. Snapshot provenance verifies the expected principal/workspace. Context polling detects changed identity or permissions; SSE revalidates server access once per second.

All owned temporary validation servers, the SSH tunnel and collaborative browser tab were stopped after checks. The production service and unrelated pitch-tour daemon were left running.

## Remaining limits

Profile upload/editing, team memberships and a workspace switcher remain deferred. The landing's labeled mock charts still share the composition bundle; they never supply account records or walkthrough data. Separating those marketing assets and replacing their illustrative numbers with measured results remain follow-up work; complete bundle splitting is not claimed.

The runtime cache retains one client/wake channel per visited workspace; collection scaling has not been measured. Background jobs recheck authorization before driver iterations and while waiting for approval; an individual in-progress SDK `inv.run()` is not interrupted mid-call. The global four-job limit remains shared across workspaces.

The SDK campaign has separate acceptance gates. This workstream's app build does not qualify its numerical or native direct-link campaign.

## Native build custody

Native/Cargo builds and target writes from this workstream are quiet after the completed deployment window. No new incremental cache was created. The SDK capacity-audit record at `~/.local/state/productionize/autophys-sdks-20261105/capacity-audit/` records custody release for only these two subtrees:

- `/home/james/ssd-mount/cargo-target-scratch/autophys-gaps/debug/incremental` — `auth-custody-release.md/json`.
- `/home/james/.cache/autophys/target/debug/incremental` — `auth-debug-incremental-release.md/json`.

These acceleration caches are unnecessary for the deployed release or retained debug proof. Auth has no future use planned during the cleanup window. The separately authorized cleanup delegate owns fresh identity, caller and lock checks and must serialize removal against every debug/incremental writer. No cache deletion was executed by this workstream. Executables, dependencies, build/fingerprint/release siblings, source, databases, campaign artifacts and deployment backups remain retained.

The receipts identify current rusqlite 0.32.1 with `backup,bundled,modern_sqlite`; Cargo.lock is unchanged. The older SDK dependency selection lacking `backup` must be replaced and independently qualified. The deployment completion receipt preserves the native/dependency identity correspondence; it does not qualify the SDK campaign.
