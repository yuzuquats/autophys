# Autophys contributors should need one checkout, not a fleet host

Status: **R1–R4 repairs verified, independent re-review pending.**
Assessed code: `256360ebe01278a89bf632cd1e267b2bc7f74d18`; this receipt is a later
documentation-only commit. No completion or production-readiness verdict is claimed.
The original checked code revision was 189a4ddd12f618882bcea00417dad8c9a026ffe5.
The repair round is bounded to the four findings and installed Python packaging;
it does not start the five-judge campaign.
User authorization is folder structure and host/fleet portability before open source.
The five-judge productionize campaign remains unstarted. Read this page first;
[productionize-prep.md](productionize-prep.md) carries the earlier baseline.

At inventory HEAD 6830211e577e7067a499471eff5679c2970f359f, the product already
has daemon `src/`, browser `html/`, SDK `sdks/`, `tests/`, `examples/`, optional
`plugins/` and `train/` boundaries. Moving those established trees would create
churn without removing a dependency. The inventory includes 2,812 tracked paths,
30 untracked paths and recursively listed ignored inputs (16,727 target entries,
4,538 vendor entries, 107 SDK entries, 103 training entries). Live peer edits and
staging are retained. Raw identities and inventories are outside the checkout at
`~/.local/state/productionize/autophys-oss-layout-20261104/` on the owner.

The concrete coupling is in defaults and entry points: `ops/deploy.sh:27`
assumes a private service namespace; deployment doubles as the only documented
packaging workflow; `src/train.rs:212` assumes `~/autophys-train/.venv/bin/python`;
the example environment selects a private hosted server; plugin and training
instructions assume named hosts and an operator credential store. Root discovery
leads to historical internal design pages instead of contributor commands.

```review-table
| Boundary | Change in this batch | Retained contract |
| --- | --- | --- |
| Product source, SDKs, workbook, API and UI | Keep established folders; add contributor discovery and reproducible commands | No public SDK, data or API changes |
| Packaging versus operation | Add an explicit-output Linux package command; put the service template under ops/systemd; document deployment as optional | ops/deploy.sh invocation, installed service name, legacy release location and restart behavior remain compatible in one atomic commit |
| Training and integrations | Resolve Python through explicit flags/environment or PATH; replace host-specific instructions with user configuration; local example default | Provider work stays optional; no live calls or training |
| Vendored libraries | Document actual roles, provenance and licensing gaps | Keep vendor source and attribution; no dependency substitution |
```

**OSS-1 — agent-chosen, pending operator review:** keep the existing source layout
and vendored reusable libraries, while separating contributor build/package work
from opt-in service operation. Replacing the router, shell or command runtime
would be an architectural investment requiring orchestration. The strongest
alternative is publishing those libraries first and consuming versions; that
requires licensing and distribution decisions that this batch cannot make.
Reversing this small layout choice takes scoped file/reference changes without
a persisted-data migration. AppDirs defaults and their TENTO_APP_* overrides are
retained for compatibility with existing server keys/cache; changing them would
need an explicit migration decision, not a rename.

1. Inventory callers, dependency resolution, ignored state and concurrent ownership.
2. Commit this plan, then implement the bounded contributor, ops and training cleanup.
3. Verify the owned committed state in a read-only fresh export with no sibling checkout; use offline Cargo/Deno caches and the existing Python environment. Check package/deploy argument flow with isolated stand-ins, not the real service.
4. Defer library extraction, license selection, publication, builds on other platforms and the full productionize campaign to orchestration.

Checks will cover Cargo metadata and relevant Rust tests, cached Deno tests/root
imports, Python packaging/imports and focused plugin contracts, shell syntax and
package/deploy flow. Capture HEAD plus scoped digests before and after checks.
For the original batch, no dependency install, network requirement, GPU, running
service/data mutation, push or deployment was authorized. The repair assignment
subsequently authorized acquisition of declared public build/test dependencies
into an isolated external environment/cache; live services, providers, GPU,
publication and deployment remain outside this repair. A failed offline build or missing license is a
reported blocker, not a waived check.

The active master owner accepted the reservation. Its children own UI tour,
wizard and sidebar work; they may call ops/deploy.sh from clean deploy clones.
All ops moves therefore land atomically with a compatibility harness. No Autophys
thread existed in the Agent Board snapshot; partition was agreed with the warm,
running autophys/master T3 thread. html/README.md and peer SDK/UI changes stay
outside this batch. Task CLI discovery again returned `error: no command task`;
external tasks.json is the documented fallback, session
2cc3ffde-2d92-46aa-8c1d-dd97dfa2909e. Board was not updated.

```review-callout
kind: risk
title: A portable checkout is not yet an open-source release
Root and Rust SDK Cargo manifests say UNLICENSED, Python says Apache-2.0, and most vendored Tento packages have no included license grant. Preserve all existing notices and obtain the owner's license/provenance decision before publication. Cached dependency success cannot prove cold-network acquisition or every supported platform.
```

## One checkout now builds and serves the product

The plan landed in `b879fff` (I6abb40f1454745339b38dec7683e6869), the atomic
layout/configuration batch in `b963d91` (I0a177e5bd5af4bd6bca61d5323834931),
and executable Python selection plus remaining contributor caller fixes in
`189a4dd` (I4964042f537649e6a014456807db33c1). The implementation adds
CONTRIBUTING.md, docs/README.md, ops/package.sh, ops/README.md and vendor/README.md;
updates root/SDK/plugin/training entry points; moves the unchanged unit template
to ops/systemd together with its deploy reference; and changes training's
interpreter and Modal SDK defaults. `ops/deploy.sh` remains at its old path.
The example environment no longer selects the private hosted server.

**OSS-2 — agent-chosen, pending operator review:** training now uses explicit
`--python` / AUTOPHYS_TRAIN_PYTHON, else executable `python3` from PATH, keeping
venv symlink spelling. The alternative is requiring a flag for every worker;
PATH supports normal activated environments without an operator home layout.
A user can restore the old interpreter through the existing environment override,
at no data migration cost. Modal's SDK defaults to this checkout; separately
shipped workers retain AUTOPHYS_SDK_DIR. Provider/account/model settings and
live budget gates are unchanged.

All final checks used a Git archive of the owned committed revision, not peer
working drafts, under the external evidence directory. Its **2,847-file manifest
SHA-256 is `4d713022ddf8f99a70c4833af37f7d9062362f3a0ccb10d0cd008310f17dda98`**,
identical before and after verification. Vendored tree:
`993f812519f8a55cfce96657996722981dad436f`. Raw command arrays, environments,
receipts and the export remain external for independent review.

```review-table
| Check at the committed identity | Actual outcome and limit |
| --- | --- |
| cargo metadata --offline --locked --format-version 1 | 544 packages resolve; all 41 local packages are inside the export; no sibling source path |
| cargo test --offline --locked -p autophys-cli --lib train::tests | 10 passed, 0 failed; includes PATH executable filtering and venv spelling; not the full workspace suite |
| cargo build --offline --locked --bin autophys | exit 0; existing unused/dead-code warnings remain |
| deno test --cached-only --allow-read --config html/deno.json html/ | 101 passed, 0 failed |
| deno check --cached-only --config html/deno.json html/routes/index.root.ts | exit 0; existing experimentalDecorators deprecation warning |
| Python pytest test_workbook.py test_conformance.py test_mcp.py test_muse.py | 74 passed, no skips, 23.79 seconds; existing Python 3.12.3 / NumPy 2.5.4 / SciPy 1.18.1 environment; no provider calls |
| Real build-web from final export | exit 0; bundle and per-file emitter both ok. Deno wrapper enforced cached-only, no node_modules generation and denied network; existing esbuild 0.24.0 used; no dependency installation |
| Real Linux pack and isolated HTTP smoke | health ok with embedded web_id; / and /index.root.js return 200. Source root deliberately nonexistent, Deno absent from PATH, fresh collection/server-db/cache. Child terminated in finally |
| Ops command harness on final committed scripts | deploy invocation, rendered unit, legacy release root/restart and Deno config pass; package orders build/strip/pack, touches no service commands and refuses existing output/dirty source. Cargo/Deno/systemctl/curl are stand-ins here; no real deploy run by this task |
| Python wheel via setuptools.build_meta | not verified: ModuleNotFoundError: No module named setuptools in both existing Autophys venvs; no install attempted |
| Static checks | shell syntax, rustfmt, contributor file links, Deno/esbuild alias confinement and Python module compilation pass; Modal SDK expression resolves inside checkout without importing Modal |
```

The installed peer-managed service was separately observed healthy at commit
`b963d916d58c781546074d16889fed2b5de8dd45`; that read-only observation is not a
claim that this executor deployed it. Native macOS packaging, cold downloads,
full workspace/Python batteries, cross-writer parity, a real browser, Muse
launch and provider/training execution were not run in this bounded batch.
The prep's known Muse SSH wrapper/cwd issue remains an optional-integration
follow-up; changing its launcher was outside this layout batch.

## The closed inventory distinguishes dependencies from host assumptions

```review-table
| Remaining item | Disposition |
| --- | --- |
| Vendor Rust/JS runtime libraries | Retained under the operator's vendor decision. Actual offline bundle and source-free packed serving work; no Lona account, fleet CLI or private host is required. Upstream vendor source still contains Lona adapters, examples/docs and tooling; extraction/pruning is separate architectural work, not a word replacement |
| tento-dirs names and TENTO_APP_* defaults | Local compatibility paths for keys/cache; explicit standalone flags/overrides documented. AX-17 data locations were preserved without migration |
| Optional deploy release namespace | Legacy default retained for installed callers; AUTOPHYS_RELEASE_ROOT permits user-selected absolute layout. Systemd, tunnel and fleet self.toml callers remain external and untouched |
| Hostnames in auth/server/MCP tests and origin comments | Inert fixtures/examples; tests do not contact them. No product configuration selects those hosts |
| Hosted demo link in html/routes/content.ts | Intentional optional pitch navigation owned by the active UI/pitch workstream; not SDK or daemon configuration. Historical SDK/project host names and measurements remain attributed |
| Ignored target, SDK build metadata, node_modules, training data/runs, peer drafts | Inventoried recursively and preserved; not fresh-clone inputs. Existing real root target is still peer state and was not moved/deleted |
| Agent surfaces | Existing tracked battery workflow is optional; generated host configuration was not edited |
| Secret-shaped scan | No token/private-key-shaped matches in maintained source or relevant untracked/ignored SDK/training text. Seven credential-URL-shaped tracked matches were test fixtures; values were not copied to reports. This bounded shape scan is not a full security/history audit |
```

Release still needs the owner's license decision and complete vendored rights,
notices and upstream provenance. Rust says UNLICENSED while Python says
Apache-2.0; the vendor inventory has 32 named Cargo packages without a license
field. At the original revision, Deno had no dependency lock and Python wheel creation
was environment-blocked. R4 and the installed-wheel proof below supersede those
two gaps; local import tests alone were not treated as distribution proof.

Peer staging was protected with private indexes for scoped commits. A later
training-loop draft arrived in src/train.rs during the reserved batch and was
briefly included in this executor's tip; that tip was amended before any
success claim, excluding the peer draft while retaining its working bytes
byte-for-byte. The loop owner was notified to retain/recheck its unstaged work.
Only the corrected final export is assessed above. Subsequent peer changes to
src/train.rs, train/sft/README.md and modal_app.py remain outside this receipt;
no adoption of those drafts is claimed.

The external task fallback records implementation and verification done, with
the root awaiting the parent's independent review. The task board CLI remains
unavailable, and no SQLite write or board update is claimed. The full five-judge
productionize campaign remains unstarted. No push, release, dependency install,
real service deployment, GPU/training run or runtime-data cleanup was performed
by this executor.

## Review 1 repairs have bounded, committed verification

Independent review identified executable coupling that the original inventory
understated: DomainConfig unconditionally registers the upstream `/_` admin and
harness routes. Autophys now reserves the entire namespace with its own JSON
404 before those routes. The file router, bundled browser code and product
auth/API remain in use. This is a product boundary, not a vendor API removal.

Release roots now have a documented literal character grammar before build or
installation. Muse manifests name an executable package source, and their
wrappers resolve config/playbook next to the installed executable without
changing lab cwd. `html/deno.json` and its integrity-checked lock land together;
the worker receives the same frozen config explicitly through fleet patch 0016.
The snapshot owner approved this tracked patch mechanism instead of hand edits.

**OSS-3 — agent-chosen, pending operator review:** share the product Deno config
and lock with the existing worker through an opt-in library constructor. The
worker otherwise starts below the vendor config, so a frontend-only lock cannot
freeze its graph. The alternative is a separate worker config/lock plus an
explicit launcher seam, which duplicates dependency resolution. Switching later
requires scoped constructor/config changes and cache reacquisition, with no
data migration. The existing upstream constructor and vendor pin are retained.

The executor acquired declared public dependencies into external task-owned
caches and a new Python environment, preserving peer SDK environments. The
affected checks below passed on the frozen committed revision; the parent can
now obtain independent re-review. Raw
receipts stay in the existing external evidence directory, `repair-round-1/`.


## Repair evidence for independent re-review

The executor's product commits are `b0c8ee2` (R1–R3), `2de1989` (R4), and
`3c5ea52` (driver type correction and repair record), with stable Change-Ids
I547929a86ef84cff9f669a6f6c56d277, Ia1f7582d02dd46d9895ff3fe3e6af14a,
and Ica24722c8a9744daab50d49dc9375ebd. Fleet commit
`cb84775b7fb0d788b7e370812df54b71ca1f08b6`
(I7d2d36393047403e84bb582c8ff10a51) adds patch 0016 and its generated vendor.lock.
The patch uses the owner-approved sync mechanism; no upstream API was pruned or
vendor pin changed. The pitch owner then committed its own seven 0015 vendor
files as `256360e`, producing the coherent assessed code revision above.
Its newer tutorial/style working drafts and prospective patch 0017 are excluded.

The read-only Git export contains **2,854 files**. Its full source/config/test/
runtime-input manifest SHA-256 is
`1a790e8a6c55c03c879e468410f7521bd44950cae20514a0ffbbac54f8c38621`,
identical before and after checks. Vendor tree:
`efc09d18037db61c694e8ea01a733c27413c1117`.
The Deno lock SHA-256 is
`99a44081d5e3fd006f6eb60a87bbae12fbd8e2ed2c92b881a66cbe88ac6dd362`,
unchanged through acquisition, frontend checks and the actual worker build.
Frozen fleet generator inputs have their own supplemental manifest at the fleet
revision above. Evidence, commands, return codes, tool/environment versions and
failed intermediate attempts remain under the existing external `repair-round-1/`.

```review-table
| Finding/check | Decisive result and boundary |
| --- | --- |
| R1: inherited system namespace | Packed HTTP smoke: 35 paths × 7 methods × 2 login modes = 490 product JSON 404s, plus hostname variants. Includes every current SystemRouter admin/harness/app endpoint, the bare prefix, encoded characters, duplicate/trailing slashes and queries. No redirects, Lona pages or missing-app-data responses. Future /_ routes are reserved too |
| R1: product behavior | Source-free packed executable with Deno absent serves /, /app, /login, /index.root.js, health and workspace API. With --login, /app redirects to product /login and workspace returns 401. Product auth/me returns its deliberate 401. Document resources are only /favicon.svg and /index.root.js. Both children terminated |
| R2: deploy root | python3 ops/test_deploy.py passes the legacy default, normal custom absolute root and 12 invalid character cases, including spaces, backslash, percent, both quote forms and controls. Invalid roots invoke no build/service command and preserve current/unit bytes. systemd-analyze verify exits 0 on the literal rendered template. All deployment commands are stand-ins |
| R3: installed Muse bundles | Native Muse 1.4.14-R7309.1 validates/installs/inspects local and SSH bundles in isolated profiles; ./mcp-stdio.sh is its package executable source. Relocated local bundle launches the installed wheel from a separate lab cwd, loads a lab module, writes the relative workbook in that lab and exposes nine MCP tools. Relocated SSH bundle records exact quoted remote argv through a stand-in; no real SSH/provider call. Canonical playbook bytes unchanged |
| R4: public acquisition | Frozen committed resolution acquired from an empty home and empty DENO_DIR via public JSR/npm/deno.land sources. No sibling/private source or existing Deno cache. esbuild 0.24.0 platform executable acquired in the isolated home; exact binary hash recorded |
| R4: actual worker | Real build-web returns status: ok and emitter_status: ok. Captured worker argv explicitly names the product config with --frozen and --node-modules-dir=none. Wrapper enforces --cached-only and --deny-net using the newly acquired public cache; lock identity unchanged |
| R4: snapshot reproduction | Frozen fleet sync.sh --check: matches rev 56389ac9d80c + 15 patches; vendor.lock current. The check uses committed generator inputs, excluding any later peer patch |
| Core regression | cargo test --offline --locked -p autophys-cli --test system_boundary --test http --test login --test embedded: 20 passed, 0 failed, 1 opt-in ignored. Native cargo build --offline --locked --bin autophys exits 0. Existing dead-code warnings remain |
| Frontend and browser-driver types | deno test --cached-only --allow-read --config html/deno.json html/: 106 passed, 0 failed. deno check --cached-only --config html/deno.json on the root and all five html/e2e drivers exits 0. No browser was launched |
| Python core | Focused workbook, conformance, MCP and Muse pytest files: 75 passed, no skips, 23.54 seconds in a new isolated environment |
| Wheel distribution | Public setuptools 84.2.1 builds autophys-0.1.0-py3-none-any.whl with pip wheel --no-deps --no-build-isolation --no-index. Installed outside source, with no PYTHONPATH: console --help exits 0, import comes from site-packages, prices.json and the canonical playbook match source hashes. Wheel contents inspected. SDK/plugin/ops Git trees are identical between the initial installed proof and final assessed revision |
| Packaging/ops regression | Real strip + pack and source-free HTTP proof pass. Separate stand-ins confirm package build/strip/pack ordering, no service calls, existing-output refusal and dirty-source refusal. Shell syntax and owned Rust formatting checks pass |
```

The additional attempt to run the repository's opt-in packed-serving test exited
101 **before spawning a server**: `127.0.0.1:4799` was already in use. That listener
was left untouched. This is retained as an environment-blocked check, not a pass;
the independent packed HTTP driver above uses ephemeral ports and covers both
login modes. The first broader driver type-check exposed a pre-existing generic
`Element.title` error; the small getAttribute correction is in `3c5ea52` and the
final root/all-driver check passes. Two external harness mistakes (relative
vendor patch paths and counting a Deno version probe as a worker) were corrected
before final verification; their failed receipts are retained. No peer history
was rewritten, and no transient failed identity is assessed.

Acquisition used Python 3.12.3 / pip 24.0, setuptools 84.2.1, NumPy 2.5.4,
SciPy 1.18.1, pytest 9.2.0 and MCP 1.30.0; full transitive versions are retained
in the external environment receipt. Deno is 2.9.8; Rust/Cargo are 1.98 nightly.
The committed lock pins the full Deno graph, including std/path 1.1.6,
std/fs 1.0.24 and std/dotenv 0.225.8. No global toolchain or peer environment was
changed. Public dependency acquisition is qualified here; cold Cargo acquisition,
native macOS packaging, full workspace/platform batteries, real-browser behavior
and provider/training execution remain unverified by this bounded task.

All source work and scoped commits were on the owner master over SSH. Private
indexes preserved peer staging; the peer train usage hunk in src/server.rs was
not adopted. The raw source export and review evidence are retained for re-review;
the task-owned Cargo scratch target is reclaimed after checking for live callers.
The task-board CLI still lacks task support, so the existing external tasks.json
fallback is reconciled: repairs and verification done, root awaiting independent
review. The board was not updated. The five-judge productionize campaign remains
unstarted. License/provenance decisions and OSS-1/OSS-2/OSS-3 operator review are
still open; there was no push, publication, real deployment, provider call, GPU
or training run.
