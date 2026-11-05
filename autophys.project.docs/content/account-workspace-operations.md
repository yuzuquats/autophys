# Account workspace operations and qualification

The account selects one persisted collection. A local daemon uses its configured collection without cloud login. Cloud sessions and device keys resolve an account/workspace binding on every request; clients never select a server filesystem path. “Continue as demo” creates the normal session for the configured read-only account. It does not seed records, change data sources or start a walkthrough.

Native implementation checkpoint: `82831c6`. Frontend and this record accompany that checkpoint. Production accounts, mappings, data and services were not modified.

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

At the SDK owner's request, native/Cargo builds, native source/Cargo input changes and target/dependency writes are quiet after `82831c6` until explicitly coordinated resumption. The only cache custody released is:

`/home/james/ssd-mount/cargo-target-scratch/autophys-gaps/debug/incremental`

Operator approval and fresh identity/caller checks govern its deletion by the recovery delegate. No deletion was executed here. Executables, dependency artifacts, fingerprints, source, databases and evidence stay retained.

The existing SDK capacity-audit record links `auth-custody-release.md` and `auth-custody-release.json`, recording source/artifact hashes, the current rusqlite 0.32.1 `backup,bundled,modern_sqlite` fingerprint, quiet-window terms and writable paths. Cargo.lock is unchanged; the older SDK dependency selection lacking `backup` must be replaced and independently qualified.
