# Project overviews in the workbook and SDK

Status: steps 1-5 implemented (local, unreviewed), 2026-11-13; see Result. Operator approved
the direction ("go ahead") after an independent review. The decisions below marked agent-chosen are still
pending operator review.

## Why

A project's Overview is a short research note. It is Markdown rendered with
std-documentation, with `ap_investigation` cards that pull their evidence
from records ([document-node.md](document-node.md)). Today only the browser
knows about it. `html/routes/demo-document.ts` maps four demo project *names*
to static `.md` files and patches them into the snapshot. Account workspaces
cannot have an overview, nothing records who wrote one or when, and the static
files hard-code random investigation ids. Those ids break the next time the
demo workbooks are regenerated.

This work makes the overview part of the workbook, writable through the Rust
and Python SDKs, the server and the `autophys` CLI. The UI then reads it from
the snapshot like any other project data.

## Shape

| Layer | Existing neighbour | New |
| --- | --- | --- |
| Workbook format | 2 (display table, DM-D1) | 3: append-only `overviews` table |
| Rust `Workbook` | `put_display`, `display`, `config_versions` | `put_overview(markdown, author)`, `overview()`, `overview_versions()` |
| Python | `Store.put_display`, `WorkbookStore.display` | same three, on `WorkbookStore`, `HttpStore` and the `Store` protocol, plus the project-scoped `Workbook` handle |
| HTTP | `PUT /projects/{pid}/display` | `PUT /projects/{pid}/overview`, overview in the snapshot |
| SSE | `display` event | `overview` event, same digest de-duplication; the resume cursor is untouched |
| CLI | `autophys approve …` | `autophys overview set PROJECT FILE.md [--author]`, `autophys overview show PROJECT` |
| UI | `Project.overview?: string` | filled from the snapshot or SSE; `demo-document.ts` deleted |

```sql
CREATE TABLE IF NOT EXISTS overviews (
  seq      INTEGER PRIMARY KEY,                       -- latest = max(seq)
  project  TEXT NOT NULL REFERENCES projects(id),
  digest   TEXT NOT NULL,                             -- sha256 hex of the UTF-8 body
  markdown TEXT NOT NULL,
  author   TEXT NOT NULL,
  created  REAL NOT NULL);
```

## Rules

- **OV-1 Storage (agent-chosen, pending operator review).** A separate
  append-only table, versioned like config versions. Alternatives considered:
  - *Display:* re-PUT on every remote `with_project`, so it would overwrite
    the overview.
  - *Records:* per-investigation hash chains with a fixed kind enum. A
    project-scoped chain would change `heads`, `verify`, projections and the
    record fold.
  - *Blobs:* no project column, so they would still need a pointer table.

  `verify` and `rebuild_projections` ignore this table, as they ignore display.
- **OV-2 Format bump (agent-chosen).**
  - Format 3 is reached only inside the first overview write, never on open
    and never on read. Reading an overview from an older workbook returns none
    without creating the table.
  - `put_display` must upgrade to exactly 2, not to the current version.
    Today both SDKs pass the current version (`manifest.rs:44`,
    `workbook.py:872`), which would silently move every display-only workbook
    to 3.
  - Readers accept 1–3. The DDL is byte-identical in Rust and Python and is
    covered by `tests/conformance/`.
- **OV-3 Validation is advisory (agent-chosen).**
  - Writes are refused only for an empty body, invalid UTF-8 or more than
    `MAX_OVERVIEW_BYTES` (256 KiB).
  - Unknown investigation ids in inserts and unknown insert attribute keys
    come back as warnings: the UI already renders "Investigation
    unavailable", and a strict allowlist would make older SDKs refuse
    documents that use newer keys.
  - The allowed keys move from `html/ui/investigation-document.ts` into one
    shared list that the UI and both SDKs read.
- **OV-4 Writes (agent-chosen).**
  - Every write needs an explicit `author`.
  - A body identical to the latest version's digest adds no row and returns
    `changed = false`.
  - Latest is ordered by `seq`, not by `created`.
- **OV-5 Demos (agent-chosen).**
  - The generators (`ops/demo_workbooks.py`, `ops/jazz_demo.py` and the
    battery generator) write the overview through the SDK, filling in ids
    from the investigations they create, as `ops/jazz-demo-overview.template.md`
    already does.
  - The served demo seeds get a new seed version: the current seed plus one
    overview write through the CLI. Investigation ids are preserved, so the
    seeds are not regenerated.
  - The server ships before any format-3 seed.

## Steps

1. Rust SDK: the schema migration (format 3) and the display pin to 2;
   `put_overview`, `overview` and `overview_versions` for local and remote
   workbooks; a `Snapshot.overview` field; and conformance fixtures.
2. Python SDK, at parity, with conformance passing on both sides.
3. Server: route, snapshot field and SSE event. CLI: `overview set` and
   `overview show`.
4. UI: read the overview from the snapshot or SSE; move the shared attribute
   key list; delete `demo-document.ts` and its test; fix the demo loader's
   whole-workspace failure in passing, if it still exists.
5. Demos: generators write overviews, the new seed versions carry them, and
   the static `demo-overview*.md` become generator templates.
6. Independent review, then one dev activation coordinated with the Jazz
   workstream. Production and source publication are not part of this plan.

## Validation

`cargo test` (SDK and server), `pytest` for the Python SDK, the shared
conformance suite, deno tests and browser checks for the Overview node,
including when the document is missing. An old-format workbook must stay
readable and unchanged after reads and display writes.

## Result

Steps 1 to 5 are implemented on yuzuquats `~/workspace/autophys` master as
local commits (agent work, not yet independently reviewed). Nothing is pushed,
deployed or installed; no service was restarted, and the live demo collection
and served seeds are unchanged.

| Step | Commit | Change-Id |
| --- | --- | --- |
| 1 Rust SDK, format 3, display pin, conformance vectors | `ca3a230` | `Id1de0c09fece622d2244d40a18fe007739059f80` |
| 2 Python SDK at parity, Python golden | `5b1544c` | `Ic06b921ffbdaf94f4a400182a4718fbf8f2d82d3` |
| 3 Server route, `/workspace` fields, SSE event, CLI | `31c9db4` | `Ibf4d9449889f358eb16383492e1147003b6fd796` |
| 4 UI reads the overview; `demo-document.ts` deleted | `84e31d6` | `I256b85e96c38b1e35fc415f7e048161d9a41f573` |
| 5 Demo generators and the new-seed script | `1a5df7c` | `I67986900db2d0bfd04c4377ca87829bc4fb66397` |
| This result | (this commit) | `I350c4f42e41a6221fea5f88ee87623b799bab317` |

**Tests** (yuzuquats, the repository's `target/`):

| Suite | Before (7275b66) | After (1a5df7c) |
| --- | --- | --- |
| `cargo test --workspace --locked` | 362 passed, 0 failed, 2 ignored | 384 passed, 0 failed, 2 ignored (38 binaries) |
| `python3 -m pytest -q tests` in `sdks/python` | 689 passed, 14 skipped | 749 passed, 15 skipped |
| `deno test --allow-read --config html/deno.json html/` | 160 passed | 161 passed, 0 failed |

No suite had failures before this work. The new skip is
`test_cross_writer.py`, which runs only when `AUTOPHYS_RUST_BIN` points at a
built `autophys`. It passed (6 tests) with that variable set. The shared
conformance suite is `tests/conformance/`, read by both SDK test suites. Its
new `overview/` directory holds the vectors (`cases.json`) and one golden per
SDK, and each SDK reads both goldens. Compatibility was tested both ways:
- Reading a format 1 or 2 workbook, or writing a display to one, leaves the
  file byte-identical and below format 3.
- A newer-format workbook (4) is refused on open and on write.
- A format-3 golden from either SDK reads back in the other.
- An overview written through the Rust daemon reads back in a local Python
  store, and one written locally reads back through the daemon.

The UI build (`autophys build-web`) bundles the shared JSON insert list.
`deno check` passes on the touched entry points. Step 5 was checked on copies:
- On a copy of the dev demo collection, the seed script took all four
  workbooks to format 3. Each rendered overview is byte-identical to the
  static file served before, and `autophys verify` passes on every workbook.
- `ops/demo_workbooks.py` and `ops/jazz_demo.py` both generated clean
  workbooks with overviews into fresh directories.

**Deviations from the plan**
- The Rust warning type is `OverviewWarning`, with the codes
  `unknown_attribute` and `unknown_investigation`. Python returns plain dicts
  with the same fields.
- The canonical insert list is `html/ui/investigation-inserts.json`. Rust
  embeds it with `include_str!`. Python ships a byte-identical package-data
  copy, and tests in both Python and Deno pin it to the canonical file.
- The `/workspace` project carries `overview` (Markdown or null) and
  `overview_meta` (`{seq, digest, author, created}` or null). These are not
  one nested object, because the UI's `Project.overview` was already a string.
- `autophys overview set` takes `--author`, which defaults to `operator`, and
  accepts `-` to read stdin. `autophys overview show --json` prints
  `{project_id, overview}`, with `overview` null when there is none.
- There is no battery generator in `ops/`. The battery overview is written
  only by the new-seed script. Its template is
  `ops/demo-overview-battery.template.md`, which was `html/routes/demo-overview.md`.
- OV-5 said seed versions would be made "through the CLI". The new-seed
  script, `ops/demo_overviews.py --from SEED --out NEW`, uses the Python SDK
  instead. It makes the same single `put_overview` write, and it checks that
  investigations and heads are unchanged.
- The step 4 demo loader's whole-workspace failure no longer exists, because
  the loader was deleted with `demo-document.ts`.
- The repository's shared `target/debug` reused stale units from the
  `target/release-v0.1.5-source` export, so the SDK's library tests ran a
  Nov 10 binary. Three fingerprint files were renamed, not deleted, with the
  suffix `.stale-export-20261113`, so cargo rebuilt from source.

**Open items**
- Step 6: an independent review, then installing the new seed version and
  activating dev together with the Jazz workstream. The server must ship
  before any format-3 seed.
- `html/routes/demo-overview-jazz.md` is no longer read by anything, but this
  work left it in place for the Jazz workstream to dispose of. The Jazz
  project docs still link the moved `demo-overview*.md` paths.
- The SSE poll reads each project's latest overview body to compare digests.
  If projects or bodies grow, compare the digest in SQL.
- No browser check of the Overview node was run, including the
  missing-document case. Only the deno unit tests and build-web cover it.

### Agent choices made during implementation (pending operator review)

```review-table
| Id | Choice | Recommendation and reason | Strongest alternative | State and reversal |
| -- | ------ | ------------------------- | --------------------- | ------------------ |
| OV-6 | The shared insert list is `html/ui/investigation-inserts.json`. Rust embeds it, and Python carries a pinned package-data copy | The UI owns the keys, and the published Python wheel cannot read files outside its package | Generate the Python copy at build time: no checked-in duplicate, but the wheel build gains a step | Implemented in `ca3a230` and `5b1544c`. Switching to a generated copy changes the build only; cheap |
| OV-7 | Wire shape: `overview` is the Markdown and `overview_meta` is `{seq, digest, author, created}`. The SSE `overview` event carries the full body, has no `id:`, and is de-duplicated by digest per project | It keeps the existing `Project.overview: string`, and the SSE resume cursor is untouched | One `overview: {markdown, …}` object: tidier, but every reader of the string changes | Implemented in `31c9db4` and `84e31d6`. An adopted wire contract once shipped, so changing it later needs a compatibility window |
| OV-8 | CLI: `--author` defaults to `operator`. Warnings go to stderr, or into the JSON with `--json`. `show --json` returns `{project_id, overview}` | A person at the CLI is the operator, and the Python and Rust APIs still require an author | Require `--author` on the CLI too | Implemented in `31c9db4`. Requiring the flag is one line; cheap |
| OV-9 | An insert counts for warnings only where a CommonMark HTML block can start it: at the start of a line, indented at most three spaces, and outside fenced code | It matches what the viewer actually renders as a card, so mentions in prose or code produce no warnings | Scan the whole body for the tag: simpler, but it warns about examples | Implemented and covered by the shared vectors. Changing the rule changes the vectors; cheap |
| OV-10 | Demo seeds become a new version through a script that copies the seed with SQLite's online backup and makes one Python SDK write per project. The template placeholders are `{{investigation_N}}` (creation order) and `{{KEY_investigation}}` (Jazz). Authors are `autophys-demo` for seeds, `--by` for `demo_workbooks.py` and `jazz-demo-spec` for Jazz | It needs no running daemon, the source seed is never written, and it checks that the chain is unchanged | `autophys overview set --target` per workbook (OV-5 as written): same bytes, but four commands and no chain check | Implemented in `1a5df7c`, not installed. Before installation, switching is free |
| OV-11 | Append-only is enforced by the SDK APIs, not by SQL triggers | Neither the display nor the config-version table uses triggers, and a trigger would be part of the format both SDKs must match | Add `BEFORE UPDATE/DELETE` triggers in the format-3 DDL | Not implemented. After seeds ship, adding triggers means a format 4 |
```
