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

## GitHub link in the header

The header now reads Try now, Docs, the GitHub mark, then the profile. The mark (20 px in a 32 × 44 px target, labelled “Autophys on GitHub”) links to https://github.com/yuzuquats/autophys and hovers to the secondary ink. Below 480 px it is hidden: with it, Try now ran into the wordmark at 390 px and narrower. Opening the app fades it out while its width and the gap before it close over 700 ms on the shell's ease, so Docs slides beside the profile; closing reverses it, Docs from the workbench settles it with the cover and wordmark, and reduced motion switches the transition off. Source: `html/routes/brand.ts` only.

Deno checked the header module. Browser checks on the live page with the maintained CSS injected confirmed the order, 32 px target, hover color, hidden at 479 px and shown at 480 px, the collapse timeline (Docs moving from the first frame, 0 px at about 700 ms) and its reversal. The release served at dev--autophys.lona.so (yuzuquats `autophys-dev`, master's web over the production binary, isolated demo data) confirmed the mark, the collapse on Try now, demo sign-in and no console errors. On an export of the published prefix, Deno checked the entry modules and the web suite passed (141 tests).

Published to origin master as `fcc0ff0` (8126d47, bc80719, 12288d0, fcc0ff0) after two read-only agent review rounds, both ready. Deployed on 2026-11-08 as release `21edee0-web-fcc0ff0-20261108`: the native prefix of `21edee0` byte for byte with only the web payload replaced. Public health reports commit `21edee0` and web ID `43d66f97d6dd68d4ec3804993473e0205996ea421a85af2f90fccbf5be8059da`. Live checks on autophys.lona.so and dev--autophys.lona.so confirmed the mark, its collapse on Try now and return, hidden at 390 px, and no page errors. The previous release `21edee0-20261108` and the unit backup `autophys.service.pre-web-fcc0ff0-20261108` are retained for rollback.

## Account button kept out of the first paint

With sign-in enabled the server appends the account button to `<body>`, and the module script runs after parsing. The browser therefore first painted that button unstyled at the top-left of a body with the default 8 px margin for about 80 ms. The page then shifted when the shell mounted and moved the button into the header. `html/routes/index.anon.html` now hides a body-level `#ap-account` (absolutely positioned, not visible) and zeroes the body margin. Once the shell moves the button into `.ck-nav-links` the rule no longer matches. No Rust change was needed.

On dev--autophys.lona.so a layout-shift observer recorded no shifts at 1280 or 390 px, where it had previously recorded one body shift at about 70 to 105 ms. Screencast frames go from blank straight to the finished page, and the button is visible in the header on `/` and `/app`. The web suite passed (141 tests). Production still serves the earlier release and keeps the flash until this is deployed.

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

## Superseded build cleanup and sign-out deployment, 2026-11-06

At the operator's request, removed 31 superseded installed Autophys releases after an explicit per-file manifest, ELF/contents inspection, runtime-selector scan and privileged process/open-file checks. The two removal passes reclaimed 672,100,352 bytes of observed filesystem space (640.97 MiB); larger concurrent free-space changes belong to other work. Only the new live package and its immediate rollback remain. Source, databases, dependency caches, SDK campaign artifacts and qualification evidence were preserved. Removal manifests retain metadata, hashes and provenance at `scratch/autophys-account-deploy-3e79416b743e417ba9000675932916f6.scratch-entry/content/old-build-prune-20261106/`.

Capacity recovered, so the in-place sign-out refinement is now live at `6efe1f3-auth-c58c041-web-d629592-20261106`. It reuses the unchanged qualified native binary from the prior sign-in deployment. The web overlay carries account/header and session-reset changes from `d629592`, plus the browser-context extraction dependency from `132bd8f`; the retained baseline and all overlay hashes are recorded in `SOURCE.json`. No native/Cargo build or database migration ran. The web-only allocation stayed within the declared bounds.

The staged Deno entry check, offline web build and pack passed. Focused browser checks exercised the full packaged bundle on cloned account state: closed-drawer logout preserved query/hash/history/time origin and 120px scroll, open-workspace logout cleared prior account data and showed inline sign-in without reload, and signing back in restored persisted records. Public-site checks confirmed both drawer states preserve the page, with no credential autofocus. No test suites ran. Local/public health matched web ID `1f3352cf33b665b2c5fdeaedf9e9d4b840913f8906dacee59b87fac5c7282e60`. The owned qualification daemon, tunnel and preview tab were stopped.

Evidence, unit rollback and native/dependency correspondence: the same scratch entry's `content/signout-deploy-d629592/`; the completed window companion is `~/.local/state/productionize/autophys-sdks-20261105/repair-round-1-qualification/deploy-window-signout-d629592.json`. The prior `6efe1f3-auth-c58c041-20261106` package remains the immediate rollback.


### Publication review and account walkthrough teardown — 2026-11-06

The independent review of the 35-change account/auth scope returned changes
required. Account transitions now cancel the cookbook tutorial, discard retained
steps, lesson text, progress, previews and highlights, and return an open tutorial
to app stage without changing URL/history. The controller then resets for the new
account. TypeScript checking and an offline web build passed. Focused browser
qualification on copied account state verified clearing at initial and later
lessons, preserved URL/history/document, and a different account's workspace and
newly started walkthrough. No test suite, Cargo build or deployment ran.

Evidence: the registered account-deploy scratch entry's
`content/account-publication-20261106/`: scope and exact patches, independent
round-one review, source/allocation and browser qualification receipts. The
reported live Continue as demo error was not reproduced: both public inline and
modal paths established the persisted read-only user and one project; repeated
public/loopback requests returned 303. Its cause remains unresolved.

Publication stays held: the selected walkthrough requires the separately owned
8fe65c2 cookbook contract, and sign-out requires 132bd8f's context extraction.
The preserved merge 35b68ed prevents the skill's required linear sink, and 21
selected messages need one final trailer block. Do not flatten ancestry, adopt
peer work or treat the deployed composed bundle as validation of the selected
prefix. No sink or push has occurred.

Custody: the five tutorial/consumer source edits are owned by this auth session.
An uncoordinated edit interrupted the peer native qualification window; that
executor stopped before release/package/install. Finish this scoped commit and
read-only review, stop isolated browser/daemon/tunnel callers, then record exact
commit/tree/file hashes and release the source-write hold for the next native
admission. No additional source writes, Cargo or deploy during that admission.


### Demo sign-in hardening — 2026-11-06

Fetch sign-in now returns the resolved account context and the shared
server-rendered profile control in the session-cookie response. The workspace
can enter immediately without waiting for a second context or badge request;
profile images load independently. Native form submissions still redirect.
Against an older daemon's 303 response, the client resolves context, enters the
workspace, and gives its cosmetic badge refresh two seconds. Session changes
and sign-out cancel that refresh so late account markup cannot overwrite the
new identity.

Errors distinguish invalid credentials, throttling, unavailable demo/workspace,
temporary server failure and failure to confirm an accepted session. Only fixed
public messages are shown. Internal handler errors stay in the server log with
an opaque request reference; browser diagnostics contain only stage/status/code
and that reference. Demo submission sends only its destination and never selects
the password field on failure. Demo continues to be an ordinary persisted
read-only account, with no bundled records or special walkthrough.

Session rotation now performs expiry cleanup, previous-token removal and
replacement insertion in one SQLite transaction. Random-token generation happens
first. Any failed write rolls back all session changes. No schema or dependency
change is required.

Deno application-entry checking and the offline sign-in module bundle passed.
Native and regression sources compile; an offline debug build passed with
incremental compilation disabled. Eight focused browser cases checked error
messages, focus, retry controls and single-response entry; additional delayed
and stale-badge checks verified timeout and identity cancellation. Seven manual
checks against an isolated daemon and synthetic account DB covered invitation,
ordinary sign-in, demo read-only rotation, native redirect, Origin rejection,
disabled demo, and forced insertion failure with retained old session and
rolled-back expiry cleanup. The new store regression is compiled but unrun.
No test suite, installation, service restart or deployment was performed.
The original reported incident remains unconfirmed; deployment-time 502s were
separately established in the drawer deployment record.

Evidence and custody are at fleet/evidence/autophys-auth-hardening/.
Both native operations used the two shared locks and bounded allocation;
compile/build growth was approximately 0.47/1.63 GiB, free space stayed above
136 GiB, and no new incremental cache was created. Owned temporary daemon and
browser callers are stopped. At this qualification checkpoint, source remained
uncommitted under the operator's ref/commit hold for polish's publication; the existing 36 completed auth
Change-Ids are separately offered for joint review in
joint-prerequisite-scope.json. This hardening delta is excluded from that
handoff. Publication readiness of a newly assembled prefix is not inferred.


### Sign-in review recovery classification — 2026-11-06

Independent review found that missing membership and a changed canonical
workspace path both return 403, which had been classified as an Origin failure.
Workspace resolution now reports the fixed workspace_unavailable recovery code
before any session mutation; Origin refusal retains its separate reload message.
Internal details remain server-side with the same opaque reference as the
response. This also applies to native form fallback errors.

The one admitted offline debug/manual qualification attempt passed in 8.4 seconds.
All nine isolated account checks passed, including both workspace403 cases with
the previous account's session retained, rollback after forced insert failure,
ordinary/demo sign-in, native redirect and Origin refusal. No production account
data was copied. Free before/minimum/after was
146,105,520,128 / 145,523,593,216 / 146,105,118,720 bytes; peak target growth was
581,853,184 bytes, final growth 311,296 bytes. Both locks and all owned callers
were released. No suite, deployment or automatic retry ran. The scoped forward
fix and earlier hardening remain excluded above polish's joint prerequisite
prefix; the final publication boundary still needs independent review.


### Pitch-to-workspace tutorial continuity — 2026-11-06

Pitch navigation now keeps the current account walkthrough visible when it opens
the workspace, including ArrowDown, right-arrow slide navigation and reopening
during the closing animation. The previous explicit-launch flag returned no
lessons for pitch entry, so the shell immediately lowered the tutorial away.
Only an initial direct workspace URL skips the walkthrough; later drawer
navigation and the Walkthrough action use the ordinary account-backed source.
Sign-in itself still only signs in, and identity changes still discard lessons.

The entry module passed its cached/frozen Deno typecheck and browser bundle.
Thirteen focused collaborative-browser checks passed against the exact bundle,
including desktop/390px visibility, next/back, dismissal/restart, direct app
entry, fast reversal, sign-out teardown, and sign-in without an automatic tour.
The browser used the persisted read-only account; no records were seeded.
Evidence: fleet/evidence/autophys-tutorial-header/validation.json. At that source
checkpoint, commits were held and no native build, test suite, push or deployment
had run. The operator subsequently requested deployment; productionize released
one scoped local commit slot. The bounded build, exact source/artifact identities
and deployment outcome are recorded in the same evidence directory under
deployment.json. Git publication remains a separate coordinated operation.


### One sign-in surface in the signed-out workspace — 2026-11-06

The header account action now reuses the signed-out workspace form instead of
opening a second form over it. The workspace owns this decision while mounted;
returning to the pitch uses the existing lona-js modal. On phones the action
first closes the sidebar or details sheet. Focus moves to the form heading,
without opening credential autocomplete, and Tab proceeds to Email. Existing
input values and the URL are preserved. Teardown removes the workspace handler.

The cached/frozen entry typecheck and browser bundle passed. Ten focused browser
checks covered desktop and 390px reuse, keyboard activation, preserved input,
phone sheets, drawer reentry, pitch modal/dismissal, one demo request and sign-out
recovery. The exact revised bundle ran only in an owned incognito preview using
the persisted read-only account; its session was signed out afterward. Evidence:
fleet/evidence/autophys-single-sign-in/validation.json. No native build, suite,
deployment or push ran. The scoped local commit remains separate from
productionize’s reviewed publication prefix.


### Compact account dropdown — 2026-11-06

The approved dense menu is 220px wide with 4px outer padding and 26px desktop
action rows. Name and read-only status share one line, with email beneath.
Long names truncate with their full escaped value in a title; email wraps.
The existing profile bubble and native sign-out form remain. Shared action
and divider styles leave room for future options; no placeholder actions ship.
Coarse-pointer devices retain 44px action targets.

Nine focused browser checks covered desktop and 390px layout, keyboard focus,
Escape/outside dismissal, long escaped profiles, local profiles without sign-out,
the coarse-pointer rule and actual sign-out. Checks rendered the exact extracted
Rust template/CSS into the existing live header in an owned incognito tab; they
do not qualify a newly compiled daemon. Sign-out cleared the session and the tab
was closed. Edition-2024 rustfmt and diff checks passed. No native build, suite,
deployment or push ran. Evidence: fleet/evidence/autophys-compact-account-menu/.


### Compact account source publication — 2026-11-06

Published the reviewed account-menu presentation change as
[`663de859`](https://github.com/yuzuquats/autophys/commit/663de859d062a2d94cb632f6fed49ceb92305418),
directly above public base `6853e551`. Independent review found no actionable
issues; its exact source boundary and nine existing extracted-template browser
checks are recorded under yuzuquats
`~/.local/state/productionize/autophys-outstanding-review-20261106/`.
The guarded prefix-only push was verified remotely; the two existing local
publication receipts were preserved. No new tests, build or deployment ran.
This outcome note was initially kept local.
