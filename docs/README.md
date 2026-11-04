# Repository map

Autophys has one source checkout. The daemon stores and projects workbook
records; SDKs run simulations and numerics; the browser renders SDK-authored
display metadata and asks people to approve experiments.

| Path | Responsibility |
| --- | --- |
| `src/`, `sql/` | Rust daemon, HTTP/SSE admission, server keys/accounts and database migrations |
| `sdks/python/`, `sdks/rust/` | public numerical and workbook APIs; Python is the numerical reference |
| `html/routes/` | document routes and application composition |
| `html/client/`, `html/ui/` | wire models, presentation derivation and browser views |
| `tests/` | daemon contracts and shared workbook/numerical conformance inputs |
| `examples/` | runnable lab examples and their own setup instructions |
| `e2e/`, `html/e2e/` | optional daemon/browser flows; use a temporary collection and a spare port |
| `plugins/` | optional agent integrations; Muse is not a daemon dependency |
| `train/sft/` | optional policy dataset, provider and evaluation workers |
| `ops/package.sh` | Linux single-file packaging with an explicit destination |
| `ops/deploy.sh`, `ops/systemd/` | opt-in Linux user-service installation; not a contributor build requirement |
| `vendor/` | checked-in local dependencies; see provenance and licensing notes there |
| `autophys.project.docs/content/` | development decisions, plans and historical verification; not a setup prerequisite |

The root Cargo workspace contains the CLI and Rust SDK. The vendored Rust
workspace is excluded as a member but supplies local path dependencies and three
crates.io patches. Browser import aliases in `html/deno.json` (Deno) and
`html/tsconfig.json` (esbuild) resolve inside `vendor/tento`; keep both aligned.
There are no product submodules or tracked symlinks to a sibling checkout.
A checkout nested in the operator's workspace is not required.

[CONTRIBUTING.md](../CONTRIBUTING.md) is the current build/test entry point.
[Workbook format](../autophys.project.docs/content/workbook-format.md),
[SDK design](../autophys.project.docs/content/sdk.md),
[Rust SDK](../autophys.project.docs/content/rust-sdk.md) and
[display metadata](../autophys.project.docs/content/display-manifest.md) describe
contracts. Older project pages also describe superseded layouts and private
fleet operations; those examples do not establish contributor requirements.

Generated Cargo targets, node modules, Python package output, datasets and
training runs are local state. They do not travel with a fresh clone. Keep
private environment files and credentials outside Git. The repository-local
battery skill under `.claude/skills/` is an optional workflow aid and runs no
setup automatically; it is not generated host agent configuration.
