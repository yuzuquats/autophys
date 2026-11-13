# Project overviews in the workbook and SDK

Status: plan, 2026-11-13. Operator approved the direction ("go ahead") after
an independent review. The decisions below marked agent-chosen are still
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

Pending.
