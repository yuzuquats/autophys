# The account selects the data; the workbench stays the same

Status: revision 1, proposed implementation (2026-11-05). The user-facing contract below is agreed. The workspace context, storage migration and delivery choices are recommendations awaiting review. This change writes the spec only.

Autophys should open the active user's workspace through one workbench and one guided walkthrough. A local daemon supplies its configured collection; a cloud session supplies the signed-in account's collection. “Continue as demo” signs into a real, read-only account whose data is stored on the server. Neither authentication nor the walkthrough substitutes browser fixtures.

## What the current code actually does

The operator's constraints are explicit:

> “the goal is to remove hardcoded ‘demo’ data from the bundled app. the idea is that cloud has a ‘demo’ user with data. in headless mode, the tutorial walks through the current user's account”
>
> “no ‘this computer’ or ‘cloud computer’. we need a profile picture bubble for both. ‘continue as demo’ is the allow demo affordance and all it does is log into the demo user's account as read-only”

Code evidence was checked against `59f64a7` in the owner checkout. These findings describe source, rather than a fresh production inspection.

| Source | Current mechanism | Remaining gap |
| --- | --- | --- |
| `src/http.rs:59`, `:88`, `:354` | `Api` owns one `Client`; `/workspace` authenticates and reads that client. | Accounts gate the same collection. Signing into a different account does not select different data. |
| `src/accounts.rs:34`, `:272`, `:321` | User stores email, read-only and demo flags; demo configuration clears credentials but does not set read-only. | Demo and read-only can disagree; no avatar or workspace binding exists. |
| `src/login.rs:316` | Demo endpoint calls the normal session creator. | This is the right authentication path to retain, with permissions enforced. |
| `src/http/auth.rs:195` | Read-only members are rejected on non-GET/HEAD API requests. | Bearer keys, device pairing, jobs and future mutation routes need the same workspace/capability boundary. |
| `html/routes/account-header.ts:37`, `src/login.rs:500` | Header rehomes server-injected account HTML; cloud badge uses an initial. | Local mode has no equivalent control; profiles cannot supply a photo. |
| `html/routes/index.root.ts:32`, `:193` | Composition root hardcodes `USER = "james"`; successful sign-in starts the tutorial. | Identity is inconsistent and tutorial launch is coupled to authentication. |
| `html/routes/guided-tour.ts:36`, `guided-tour-steps.ts:21` | Walkthrough reads the existing Store and chooses available investigations. | Preserve this behavior; make permissions, missing records and account changes explicit. |
| `html/routes/content.ts:10` | Landing/pitch content still contains labeled mock charts. | Workspace fixtures are removed; illustrative marketing numbers remain a separate bundle concern. |

The principal architecture gap is the distinction between authentication and data ownership: the server knows who signed in, but its collection is process-wide. A new profile bubble alone cannot make “the current user's account” true. The server must resolve both the caller and the caller's workspace before opening data.

## The agreed product contract

| Question | Agreed answer | Consequence |
| --- | --- | --- |
| Where does example workspace data live? | In the cloud demo account's persisted collection. | No sample project IDs, synthetic snapshots, fixture workers or data-source overrides in the workbench. |
| What does Continue as demo do? | Authenticate as that account, read-only. | Normal session and normal workspace loading; no special page, demo-specific tutorial trigger or data swap. |
| What does the walkthrough explain? | Records in the active workspace. | Works for local, normal cloud, demo, sparse and empty accounts. |
| What identifies the user? | A profile-picture bubble in both local and cloud. | Same header component and geometry, with a fallback when a photo is absent. |
| Does the header name the deployment? | No. | No “This computer,” “Cloud computer,” or local/cloud header badges. |
| How does sign-in open? | The existing lona-js Dialog and Overlay. | Preserve focus containment, background inertness and return focus; do not autofocus credential fields. |

The mock's Local/Cloud scenario controls belong to the design artifact. They do not become application UI. Its stock profile photograph and illustrative records do not become product data.

## One server context supplies identity, access and workspace

**Recommendation AW-1 — agent-chosen, pending operator review:** introduce a server-resolved workspace context. Start with one default workspace per cloud account, plus one configured workspace for a local daemon. A minimal membership table supports the association; a team-management interface and workspace switcher are deferred.

```text
Local document session ─→ local profile + configured collection ─┐
                                                               ├─→ resolved context
Cloud account session ──→ account + workspace membership ────────┤       │
Scoped API key ─────────→ owner + workspace + granted actions ───┘       ↓
                                                        workspace Client
                                                               │
                                                        snapshot + stream
                                                               │
                                                          one Store
                                                               │
                                                     workbench + walkthrough
```

The server database stores profiles, workspace registrations and memberships beside account sessions. A workspace registration maps an opaque ID to a server-controlled collection root. Cloud accounts receive a default workspace on provisioning. The local workspace registers the existing configured collection in place; it does not require a cloud user or move local workbook files.

Resolve this context once per request. HTTP handlers, blob reads, streams and background jobs receive the resolved workspace Client instead of reaching for a global `api.client`. Retain the existing project and record APIs inside that scope. A project ID, blob hash, filesystem path or stream cursor supplied by the browser never selects another collection.

Expose the same public shape to the UI through a proposed `GET /api/v1/context` and a safely serialized document bootstrap:

```ts
type AppContext = {
  principal: { id: string; displayName: string; email?: string; avatarUrl?: string } | null;
  workspace: { id: string } | null;
  capabilities: {
    read: boolean; createProject: boolean; startInvestigation: boolean;
    approveProposal: boolean; manageDevices: boolean;
  };
  auth: { canSignIn: boolean; canSignOut: boolean; allowDemo: boolean };
};
```

A signed-out cloud document has no principal or workspace and no data capabilities; it may expose the sign-in and demo affordances. A local document has a persisted local profile and workspace, with no cloud sign-in prerequisite. A cloud account has its profile and authorized workspace. The workbench does not need a demo flag to render records or permissions.

Use a single resolver for bootstrap and API responses to prevent contradictory initial states. The server remains authoritative; the serialized context is presentation input. A cloud account with missing membership fails closed with an account-configuration error, rather than opening a shared or demo collection.

**Recommendation AW-2 — agent-chosen, pending operator review:** keep optional display name and avatar reference in the server profile store for both identity types. Configure the local profile through the daemon's configuration/CLI initially. Render initials when no photo exists or loading fails. Do not use a stock portrait or an external avatar service as a default. Cloud avatar references must be validated HTTPS URLs or owned same-origin assets; never accept arbitrary HTML or filesystem paths. Photo upload and crop controls are deferred.

A collection per workspace is recommended because the existing Client already scopes reads and writes to a root. The strongest alternative is one collection with ownership checks on every record; that introduces a second boundary inside the existing workbook API. Replacing the proposed registry is inexpensive before migration; changing it after data adoption requires another migration and SDK review. Neither recommendation is implemented by this spec.

## Demo access is a read-only session

Keep `/api/auth/demo`, the normal HttpOnly account session and the shared sign-in fields. `allowDemo` controls whether “Continue as demo” appears. The endpoint also checks availability server-side; hiding a button is insufficient.

Make the demo invariant explicit: an account enabled for public demo sign-in cannot receive write capabilities. Set `read_only` when configuring it, repair existing inconsistent flags in migration, and reject attempts to make an enabled demo account writable. Effective permissions also intersect the demo restriction at request time, so an inconsistent stored flag cannot grant writes. Enabling/disabling the demo identity invalidates affected existing sessions and delegated credentials as needed; disabling public demo sign-in prevents new demo sessions immediately.

Authorization checks the operation's required capability. Retain method-level rejection as a backstop, while auditing every mutating operation. Block project creation, approvals, configuration changes, pairing approval, key creation, blob writes and experiment/job starts for a read-only account. Ordinary reads, navigation, walkthrough controls, permitted exports and logout remain usable. Auth/session operations must still function for read-only accounts.

Bearer keys bind to an owner and workspace, carry an explicit grant, and cannot exceed the owner's effective permissions. Pairing approval binds the resulting device key to the approver's workspace. Pairing start/poll must not enumerate workspace data; read-only users cannot mint write-capable devices. Job queue entries, status, results, notifications and stream subscriptions all retain workspace identity. Recheck access on reconnect and stop streams/jobs from retaining privileges after revocation according to the job policy; do not let account changes keep delivering previous-account events.

Seed the demo workspace using an operator-run server command or SDK import with privileged credentials. Make seeding repeatable by seed version and stable server-side identifiers; rerunning the same version must not duplicate records. Seeding must never run from login, page load or the walkthrough. The shared demo data remains stable because visitors cannot mutate it. A reset/reseed operation is explicit and must not overwrite real users' workspaces.

## The header and workbench consume the same capabilities

Replace the cloud-only HTML badge branch with a shared profile control driven by AppContext. Keep the bubble's size and placement consistent between local and cloud. It displays the configured image or initials, has an accessible account label and opens with click, touch or keyboard. Hover may provide a tooltip, but cannot be the only way to reach its menu.

The menu shows the profile name and available account actions. A cloud session can sign out; a local profile has no meaningless sign-out action. Show a generic “Read-only” permission label where useful, with the same treatment for every read-only account. Avoid a special demo chip, demo mode banner or alternate navigation. The demo account's own configured name can naturally identify it.

Use capabilities to derive controls in the view model and to guard controller dispatch. Disable writes with a concise permission explanation while leaving their context visible. Remove the hardcoded `USER = "james"`; use the context principal for local attribution and display, while the server records the authenticated actor for cloud writes. Device actions retain their device identity.

Separate these rendering states explicitly: signed out, resolving context, loading workspace, ready, empty, connection failure and expired session. Unknown identity is not signed out. Server bootstrap supplies the first state so a returning session never paints a sign-in form while awaiting workspace data.

Keep the layout transition independent of authentication and snapshot fetch. ArrowDown opens the shell/details layout immediately; loading or error content occupies the destination until records arrive. Content animates in without reopening the drawer. Retain the existing shadow/radius return motion and reduced-motion behavior. A stale response must not replace a newer account's state.

On sign-in/out or identity change: cancel the walkthrough, close streams, stop polling, clear account-scoped snapshots/cursors and pending selections, refresh context, and initialize the Store for the resolved workspace. A full document reload is an acceptable first implementation for sign-out. In-place sign-in must use the same reset boundary. Failures stay in the modal without switching data or losing entered email; credentials are never persisted by the app.

## The walkthrough follows the workspace

Keep the existing Store/Controller and adaptive step generation. Tutorial navigation may select real projects/investigations, open panels and explain records. It never creates, approves or resets records just to complete a lesson. Finishing restores navigation/panels without discarding real updates received while it was open.

Use the selected investigation when it contains the relevant evidence. When a lesson selects another investigation, name that project/investigation in the step so the transition is understandable. Omit lessons without an appropriate record. Empty workspaces explain how to begin; read-only empty workspaces explain the absence without offering an impossible create action. A connection failure offers retry rather than pretending the workspace is empty.

**Recommendation AW-3 — agent-chosen, pending operator review:** launch the walkthrough only from the Walkthrough action, including after demo sign-in. This removes tutorial startup from normal authentication and matches the latest mock. The user approved keeping an account-backed walkthrough; automatic versus explicit launch remains a separate product choice. Keeping automatic launch is the strongest alternative for first-time discovery. Reversal is small before adding persistent onboarding state; no such state is proposed here.

## Migration preserves records and removes shared fallbacks

**Recommendation AW-4 — agent-chosen, pending operator review:** introduce workspace ownership through an explicit operator-reviewed mapping of existing accounts, collections, keys and devices. Do not infer ownership from a username, workbook filename or the fact that a demo account exists.

Inventory the current collection and server database first. Produce a dry-run mapping and backup/recovery receipt before any data migration. Register the existing collection once, preserve project/record IDs and cursors, and assign its intended workspace membership deliberately. Place demo seed records in the designated demo collection; provision ordinary accounts with empty collections unless an explicit import/membership says otherwise. If records must be split, perform a verified workbook copy/import without deleting originals as an implicit step.

Bind existing API keys and devices only when their intended workspace is known. Unmapped credentials cannot silently become instance-wide credentials. Report them for explicit adoption or reissue. Validate migration counts and permissions before cutting over. Recovery restores the matching database and collection mapping together; an old server that exposes a shared collection is not a safe rollback for an already-enabled multi-account deployment. Reversal after cutover costs a maintenance window and verified data reconciliation.

The rollout can add metadata before enforcing it, but must not present cloud data as private until all reads, mutations, streams, blobs, pairings and jobs use the same scope. Do not register the same collection under different workspace IDs as a shortcut to isolation.

## Implementation sequence and evidence

| Phase | Change and likely source | Completion evidence |
| --- | --- | --- |
| 1. Enforce demo permissions | `src/accounts.rs`, `src/login.rs`, auth and credential paths. Repair the demo/read-only mismatch; retain normal sign-in. | Demo session reads records; representative mutations and delegated-write attempts are denied. Logout still works. Can ship independently as a correction. |
| 2. Resolve and enforce workspace scope | New workspace registry/resolver; `src/http.rs`, `src/http/auth.rs`, `src/keys.rs`, `src/http/sse.rs`, `src/http/workbench.rs`, app bootstrap. Add local/cloud context, migration dry run and explicit mapping. | Two accounts, distinct projects/blobs/streams/jobs and device grants; neither can read or write the other's data even with guessed IDs. Local daemon still uses its configured collection. Schema expansion can ship early; enforcement and migration cutover ship together. |
| 3. Unify profiles and access presentation | `src/login.rs`, `html/routes/account-header.ts`, `index.root.ts`, shared view/controller types. Shared photo bubble, context-based identity/capabilities, explicit loading/session states. | Local/cloud/photo-fallback/read-only scenarios; no credential autofocus, initial sign-in flash or account-data leak during transitions. This phase consumes phase 2 context. |
| 4. Finish the account-backed walkthrough | `guided-tour.ts`, `guided-tour-steps.ts`, composition root. Apply the chosen launch policy, clear investigation context and capability-aware guidance. Audit route imports and compiled assets. | Full, partial, empty and read-only workspaces traverse without synthetic records or mutations; cancellation/restoration works during account changes. Depends on phase 3 identity lifecycle. |
| 5. Deferred: profile editing and teams | Upload/crop UI, profile editor, invitations to shared workspaces and a workspace switcher. | Separate product scope; not required for one configured profile and workspace per account. |
| 6. Deferred: marketing chart replacement | Landing/pitch content owner replaces illustrative benchmark claims with measured results. | This workstream keeps mock labels honest and separates landing illustrations from the workbench import graph; it does not invent benchmark evidence. |

The workbench bundle must contain no synthetic workspace fixture modules, fixed sample project/record IDs, data-source query switches, fixture workers or copied tour screenshots. Numerical fixtures used only by development tools may remain outside the route import graph. Separate landing illustration code from the workbench entry and audit both outputs: labeled marketing illustrations must not become tutorial or account data. If “bundled app” is intended to exclude illustrative landing numbers from every site asset as well, phase 6 must move into required scope.

For implementation, follow the standing validation approach: build Rust/web artifacts and perform focused manual/API/browser checks; do not add or run a test suite. Capture the following scenarios against an isolated validation database/collections, without mutating production during checks:

- Local daemon without cloud authentication: profile bubble, configured collection, useful walkthrough and attributed writes.
- Returning cloud session under delayed context/data responses: correct first state, immediate shell transition, no sign-in flash or drawer flash.
- Signed-out cloud with demo enabled/disabled: modal/overlay behavior, keyboard focus, correct affordance and server-side availability.
- Continue as demo: normal account session and persisted seed records; reload/restart retains them; walkthrough does not start as a login side effect if AW-3 is adopted.
- Demo and ordinary read-only accounts: identical capabilities; denied direct writes, pairing/key escalation and job submission; browsing/export/logout remain functional.
- Two ordinary accounts: isolation for snapshots, known project IDs, blobs, stream cursors/events, pending pairings and job results; no data retained after switching accounts.
- Empty, partial and failed workspace loads: honest guidance and retry; no automatic example records.
- Desktop/mobile, broken/missing avatar and reduced motion: usable account menu and modal, no overflow or unreachable controls.
- Seed replay and migration dry run: no duplicates, preserved IDs/counts, explicit credential disposition and demonstrated recovery mapping.

The spec itself requires only source-reference, Markdown-link and diff review. It does not authorize migration, implementation or deployment.

## Limits and choices still to review

The fixed contract is profile bubbles in both modes, read-only demo authentication and one current-workspace walkthrough. AW-1 through AW-4 record proposed implementation/product choices separately so they can be accepted or changed specifically. The unresolved operational choice is who owns the demo seed and when its content is refreshed; recommend an operator-run versioned seed with no automatic reset.

No new collaboration UI, local-to-cloud synchronization, benchmark claims, SDK numerical behavior or experiment policy is included. Workbook storage remains owned by the existing collection/SDK layer; this work adds server identity, access and collection selection around it.

This source inspection does not prove that the deployed demo account is read-only, that local mode has passed runtime qualification, or that collection-per-workspace scaling is sufficient. Measure Client/job resource use before expanding beyond the initial deployment. If the existing SDK requires a process-global collection for correctness, revisit AW-1 before migration; do not hide that limitation behind a browser-only account switch.

Documentation review: cited source paths and the new cover link resolve; Markdown fences are balanced and the scoped diff passes whitespace checks. No application build or runtime qualification was needed for this docs-only change. The review-tool fence validator is absent at its documented owner-checkout path, so parser validation is not claimed. The host layout audit still reports existing workspace/home inventory violations outside this spec; no layout entries were changed.
