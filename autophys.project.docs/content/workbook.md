# Workbooks: the `.ap-workbook` file is the record

Status: decision page, rev 2, 2026-11-04. Operator decisions from an
`/open-questions` walkthrough. Nothing here is implemented yet. It changes
the direction of `store.md` and `sdk.md`: the daemon's database stops being
the only store, and the store becomes a workbook format that both Rust and
Python implement.

## The model

```
 Python SDK
   ap.connect("~/autophys")             ──sqlite3──►  heated-block.ap-workbook, battery-cell.ap-workbook …
   ap.connect("https://gb10…/autophys") ──HTTP /api/v1──► Rust server ──rusqlite──► the workbooks it hosts
 Rust viewer/server (local or remote)   ──────────────────────────────────────────► the same files
```

A workbook is one SQLite file per project. It holds the project's config
versions and all of its investigations. A client connects either to a local
collection (a directory of workbooks, opened directly) or to a remote URL,
where the Rust server writes the workbooks it hosts. The browser viewer
(`autophys open`) appends approvals and edits to the same file through the
same rules.

## Decisions

```review-table
| Id  | Question                         | Decision (operator, 2026-11-04)                                                                                                         | Reason                                                                                         | Implementation |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------- |
| W-1 | What "cloud" means               | Remote compute: move the workbook (and the simulator) to a compute host, process, move it back. No hosted multi-person review for now.  | The cloud is where results are processed; the operator is the only reviewer.                  | none           |
| W-2 | System of record                 | The workbook. The SDK and the viewer both write it. One owner at a time: sending to compute MOVES the file; the local path becomes a pointer (plus an optional read-only snapshot as backup); it returns after a check that the sent records are an unchanged prefix. No merge code. | One file moves everywhere; a new process can resume an investigation from it; move semantics remove forks. | none |
| W-3 | On-disk format                   | One SQLite file: `src/store`'s schema without API-key and pairing tables, a hash-addressed `blobs` table for arrays, WAL mode, `VACUUM INTO` before a move. | The only option safe for two concurrent writers; reuses the store crate; stdlib `sqlite3` in Python. | none |
| W-3a | Client model (operator direction) | SDK clients connect to a database: a local collection of workbooks (Python reads and writes directly) or a remote URL (the Rust server writes the workbook). Both Rust and Python read and write workbooks. | Operator, in answer to W-3.                                                             | none           |
| W-4 | Keeping Rust and Python consistent | Two native implementations of one spec (Python `sqlite3`, Rust `rusqlite`). The Rust crate is the reference. A shared conformance suite (hash vectors `tests/vectors/chain.json`, golden workbooks, cross tests where each side verifies the other's writes) runs in CI. The SDK stays pure Python. | The shared rules are small; `pip install` stays simple. | none |
| W-5 | Merge rules for copies           | Retired by W-2: move semantics, no merges.                                                                                              | —                                                                                              | —              |
| W-6 | Workbook granularity             | One workbook per project. A collection is a directory (or a server's set) of `<project>.ap-workbook`; `client.project(p)` opens or creates it. | The project is already the UI's grouping and the natural unit to move.                   | none           |
| W-7 | Client API                       | A client object: `client = ap.connect(target)`; `wb = client.project(project)` opens or creates that project's workbook; `wb.investigate(...)`, `wb.investigations()`, `wb.investigation(id)` resumes an investigation from its records. `target` is a directory (local collection), a `.ap-workbook` path, an `http(s)` URL, or nothing (`AUTOPHYS_HOME`, default `~/autophys`). `store=` injection stays for tests. | The workbook is a visible object; resuming has a home. | none |
| W-8 | Moving workbooks between hosts   | No send/fetch API for now. Workbooks live with the server that holds them: connecting to a URL works on that server's workbooks. The server can run as a daemon, including locally, and Python connects to it on localhost. W-2's move machinery (pointer, snapshot, prefix check) is deferred until a workbook must change hosts. | Operator, 2026-11-04. | none |
```

## What changes for the existing work

- `src/store` becomes the reference workbook library. Its append-only
  `records` table, triggers, projections and `user_version` migrations stay;
  key and pairing tables move to the server's own database.
- `/api/v1`, `HttpStore`, pairing and API keys stay, scoped to remote
  connections. SD-1 (SSE waits) applies only to remote connections; a local
  connection notices writes by polling `PRAGMA data_version`.
- The SDK gains a `WorkbookStore` (local) and `ap.connect(...)`. The
  `JsonlStore` and `MemoryStore` remain for tests.
- `sdk.md` contract question 2 is already settled in the working tree: POST
  responses return `{record, gseq}` (`src/http.rs`). Question 8 is answered
  by W-4's conformance suite.

## Still open

- W-2's move between hosts (deferred by W-8).
- Agent-chosen items awaiting review: store.md choices, SD-1, AP-3/4/8,
  E-1a..f, ML-8..ML-14.
