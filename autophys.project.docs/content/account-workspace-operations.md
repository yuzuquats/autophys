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

## Profile control refinement — deployed 2026-11-06

The signed-out server link is now hydrated before the header paints into the same `details > summary.ap-acct-btn > .ap-acct-avatar` structure as the signed-in control. Both use the existing 36 px circular button, hover and focus styling; the anonymous avatar shows a neutral profile silhouette. Sign-in still opens the shared modal, and dismissal restores focus to the summary.

Deno type-checking, a focused browser bundle and the design detector passed. An isolated collaborative-browser check using that actual module plus production server markup/CSS confirmed matching dimensions before and after normal demo sign-in, Enter/Escape handling, focus restoration and a 390 px mobile layout without overflow. Predeployment evidence: the deployment scratch entry's `profile-control/qualification.json`.

The avatar change (`c0f577a`) and 16 px header gap (`6550d2d`) are deployed in `6efe1f3-web-6550d2d-20261106`. The web tree uses the previous deployed browser baseline plus only `html/routes/account-header.ts` and `html/routes/brand.ts` from those commits; unrelated peer and SDK changes were excluded. The native executable prefix matches the prior qualified release byte for byte. Public health retains native commit `6efe1f3` and reports new web ID `9ecaf8db6ad61d186391fd6522d38c26cc73a36114d45242d30334ea156ff466`.

Live desktop/mobile checks confirmed a 36 px avatar and 16 px gap, sign-in and Escape focus restoration, demo's unchanged 29 read-only records, and Open app navigation. Temporary packaging ran in RAM after the initial disk gate stopped the build. The revised allocation capped disk growth at 48 MiB and stopped before 12.125 GiB free; no native/Cargo build or database migration ran. The prior release and service-unit backup remain retained. Deployment, build identity, allocation and browser receipts are in the same deployment scratch entry under `header-deploy-6550d2d/`.

## Try now and Docs navigation — deployed 2026-11-06

Release `6efe1f3-web-1daa409-20261106` deploys `1daa409`: the header reads “Try now,” and Docs links to `/#docs` from the landing and workbench. The existing avatar and 16 px spacing remain. Public health reports native commit `6efe1f3` and web ID `9907e1050b29e31ba12a6e5a30e2932310d792293be3b31ee5ba4e1a76e1fa1b`. Only the three maintained header/docs files differ from the original deployed browser baseline; the native prefix is unchanged.

Live checks confirmed both labels and destinations, app opening, documentation navigation, and no header overlap or horizontal overflow at 320 px. Evidence: the deployment scratch entry's `docs-deploy-1daa409/`. Web compilation and an isolated packaged-daemon rehearsal passed; no native/Cargo build, database migration or test suite ran.

A follow-up anchor alignment issue was found: a fresh Docs load from the app can clamp scrolling while the documentation is still empty, leaving the section 398 px below the viewport top. Fix `d8c9841` scrolls after documentation binding. Its package is retained at `6efe1f3-web-d8c9841-20261106`, but is **inactive**: activation stopped when unrelated host allocation reduced free space to about 11.8 GiB, below the mandatory 12 GiB floor and the 12.125 GiB activation guard. Receipts are under `docs-deploy-d8c9841/`, including `activation-held.json`. Restore capacity and recheck live identity before activating it; retain the prior releases, source and backups.

## Same-page Docs scrolling — pending deployment

The Docs click handler now scrolls the visible landing section smoothly in the current document, preserving query parameters and adding `#docs` without a reload. Repeated clicks do not add duplicate history entries. Reduced-motion preference uses immediate scrolling. Modified clicks and navigation from the workbench retain the normal `/#docs` link.

Type-checking and the design detector passed. Focused preview checks confirmed mouse and keyboard activation reached the section at viewport top without replacing the browser document or losing `?view=pitch`. Evidence: `profile-control/docs-same-page-qualification.json` in the deployment scratch entry. This source change remains undeployed alongside the earlier anchor-rendering fix; the host capacity gate remains in force.

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

## Pending Docs navigation refinement

The header now orders Try now, Docs, then the profile. Docs from the mounted app or walkthrough uses the shell's close path, settles its cover/header and panel exit animations before paint, and jumps directly to the existing documentation. It does not reload the document. The landing retains smooth same-page scrolling (instant with reduced motion); modified clicks retain the ordinary anchor behavior. Browser qualification with the current handler in the owned preview confirmed the documentation at y=0, closed panels and hidden toggles, focus on the documentation, unchanged timeOrigin, and a single history entry. Reopening and Back restored the app; desktop and 390px checks passed. Deno checked the header module; no test suites ran.

These browser changes remain undeployed under the existing disk reserve hold. Package the maintained header source together with the pending initial-anchor and same-page scrolling fixes; the older inactive package is incomplete.

## Pending sign-in surface consolidation

The standalone login renderer is removed. GET `/login` is a compatibility redirect to `/app`, preserving only a safe workspace `next` address. The header keeps its existing lona-js Dialog/Overlay; signed-out workspaces keep their shared inline credential fields. Sign-out returns to `/app`, the anonymous badge falls back to `/app`, and session expiry reloads the current workspace address to refresh its signed-out context. No client navigation sends a user to `/login`.

Credential failures return no-store JSON for fetch submissions so the current modal/card owns the error. Native form navigations return to the inline form with a fixed, allowlisted error code, removed from the URL before shell initialization; no credentials are carried in that URL and the fallback does not autofocus a credential field. Origin validation, throttling, session cookies and demo read-only enforcement are retained.

Validation: Deno checked the application entry; rustfmt parsed/formatted the edited native handler and regression sources. Focused browser checks of the new error helpers preserved query/hash and focus, displayed the error inline, removed its code from the address, and ignored unknown codes. The existing header dialog was visually checked over the workspace. Regression expectations now cover the login alias, logout destination and JSON/native-navigation errors. No test suites or Cargo/native builds ran. The native route changes are **unbuilt and unqualified**; the current service still serves its old `/login` page until a qualified native release is deployed. This cannot ship solely by overlaying web files onto the retained native executable. Preserve SDK custody and obtain capacity/build-window prerequisites before native qualification.

## Sign-in consolidation deployed, 2026-11-06

Capacity recovered, and the sign-in changes are now live in `/home/james/.local/share/tento/services/autophys/6efe1f3-auth-c58c041-20261106`. The native source is deployed baseline `6efe1f3` plus only `src/login.rs` from `c58c041`; the web bundle carries the maintained account/header/Docs and sign-in files from that commit. Build health identifies `6efe1f3-auth-c58c041` with web ID `faeef347ab5fbe80995cc18374f646ec68d49ecf0fe9ef2872742f38abbfcb9e`. No peer SDK/native changes were implicitly deployed and no database migration ran.

The optimized native build, offline web bundle and packed-release checks passed. Isolated account-state qualification covered the legacy redirect and safe deep links, JSON credential errors, native error fallback, Origin rejection, normal demo sessions/read-only permissions, cookie clearing and denial of the ended session's workspace reads. On the public site, signing in as demo then clicking Sign out returned to `/app` with the inline form and no credential autofocus; direct `/login` also redirected to `/app`. No test suites ran.

Evidence and rollback unit/database backups: `scratch/autophys-account-deploy-3e79416b743e417ba9000675932916f6.scratch-entry/content/signin-deploy-c58c041/`. The deployment-window companion receipt records completion, free space, native source/dependency identity and no remaining native writers. Incremental compilation stayed disabled; SDK source and campaign artifacts were preserved.
## In-place sign-out refinement, 2026-11-06

Sign-out now submits with fetch and resets the account context in place. A closed workspace stays closed on the landing page; an open workspace clears the previous Store, selection, pending edits, polling and walkthrough, then renders inline sign-in. The header reuses the server-rendered anonymous avatar control. Normal sign-out preserves the address, history and scroll. A refused request displays an account-menu error; after confirmed logout, a failed context/header recovery reloads the same address.

The Deno application-entry check and whitespace check passed against the shared working tree, after aligning imports with the concurrent browser-context extraction into `html/routes/context.ts`. That extraction remains owned by its separate workstream and is a prerequisite for packaging these imports. A focused collaborative-browser check injected the exact new sign-out handler and avatar hydration helper into the currently deployed landing page, with a context-capture callback replacing the application integration. A real demo session ended without changing the URL/query/hash, history length, time origin, landing stage or submission-time scroll position (120px). Anonymous context and the server-derived demo affordance returned, and focus moved to the avatar summary without scrolling. This qualifies the handler only; the updated controller integration and full web bundle have not been browser-qualified. No test suites ran.

Deployment remains held: the fresh capacity check reported approximately 4.05 GiB available, below the operator-required 12 GiB floor. No build, packaging, service activation or cache deletion was performed. The existing live release remains `6efe1f3-auth-c58c041`. Once capacity recovers, package only these frontend refinements with the retained qualified native release, verify both drawer states and sign-in after sign-out, and retain the native/source/dependency identities and rollback path.

## Current deployment gate reconciliation — 2026-11-06

[Login and HTML gate reconciliation](login-gate-reconciliation.md) records the six current-master fixture/boundary repairs, reproduced native failures, and the remaining capacity and full-suite qualification prerequisites. Packaging remains held below the operator's disk floor; no gate is bypassed.
