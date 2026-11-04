# Autophys contributors should need one checkout, not a fleet host

Status: **bounded implementation plan, revision 1; no cleanup implemented yet.**
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
No dependency install, network requirement, GPU, running service/data mutation,
push or deployment is authorized. A failed offline build or missing license is a
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
