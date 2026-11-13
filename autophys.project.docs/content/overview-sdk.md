# Project overviews in the workbook and SDK

Status: steps 1-5 implemented, review rounds 1-3 applied, and active on dev since 2026-11-13 (see Dev activation);
production is unchanged. Operator approved
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
- Existing demo collections seeded from the current seed version never get
  an overview from the new seed, and with `demo-document.ts` deleted they
  show none (review finding 4; the fallback stays deleted). During the dev
  activation, after the format-3 server is running and the new seed version
  exists, give each existing demo collection the same notes with the CLI. No
  script is needed: the new seed already holds the rendered notes, and
  seeding preserves investigation ids, so the bytes carry over unchanged.

  ```sh
  for c in COLLECTION_DIR...; do
    for p in battery_cycler_demo mass_spring_damper_demo thermal_rc_demo jazz_performance_demo; do
      autophys overview show "$p" --target "$c" --json | jq -e '.overview == null' >/dev/null || continue
      autophys overview show "$p" --target NEW_SEED_DIR \
        | autophys overview set "$p" - --target "$c" --author autophys-demo
    done
  done
  ```

  The guard skips a project that already has an overview, so a user's own
  note is never covered. It also skips a project the collection does not
  hold: `show` then exits 1 with "project not found", `jq` gets no input and
  exits non-zero. (`jq` is `/usr/bin/jq` on yuzuquats.) `set` prints warnings: an
  `unknown_investigation` means that collection's ids differ from the seed's,
  so stop and render that collection's note from its own ids
  (`ops/demo_overviews.py`'s `render`) instead. Each write moves that
  workbook to format 3, so the server must already read format 3.
- Before release (review finding 8): the SDK package versions are still
  0.1.0 (the Rust `autophys` crate, the Python package and its
  `__version__`). An SDK that reads up to format 2 cannot open a workbook
  after its first overview write, so release the format-3 readers under new
  versions. They were deliberately not bumped in this work.
- No browser check of the Overview node was run, including the
  missing-document case. Only the deno unit tests and build-web cover it.

### Review round 1

An independent review of `7275b66..6c92cb9` raised eight findings. The fixes
are forward commits on yuzuquats master; nothing is pushed, deployed or
installed, and the live demo collections and served seeds are untouched.

| Finding | What changed | Commit | Change-Id |
| --- | --- | --- | --- |
| 1 The SDK scanners disagreed with the viewer | Both SDKs port the viewer's block pass and its attribute parsing (OV-9, revised). New warnings `insert_in_paragraph`, `unclosed_insert` and `html_block` carry a `line`. `cases.json` holds the reviewer's five cases and about 25 more, each with its card lines and whether the document renders. Both SDKs assert them, and `html/routes/overview-vectors.deno.test.ts` checks them against the bundled parser | `fa11be3` | `Ia2f2e4d3dee2cba9da45100e682832603f6c92e0` |
| 2 SSE read full bodies on every poll | `Workbook::overview_head` reads `seq` and `digest` only. The SSE read loads the Markdown only when the digest differs from the one already sent | `963cd6a` | `I5eb18f64d1d5559796b3a07bc68544066d2eb7b8` |
| 3 A remote `overview()` downloaded the whole snapshot | New `GET /projects/{pid}/overview` (OV-12), used by the Rust remote workbook, so also by `autophys overview show --target URL`, and by Python's `HttpStore.overview`. Tests cover the daemon route, the Rust remote client and the Python client, including the upgrade error from an older daemon | `963cd6a` | `I5eb18f64d1d5559796b3a07bc68544066d2eb7b8` |
| 4 Rollout ordering for seeded collections | Not a code change. Open items give the activation procedure for existing collections; the fallback stays deleted | (this commit) | `I860f836bb437370bc73e71000700b66ba14f17cb` |
| 5 The unchanged-digest SSE test was vacuous | The test wakes the stream with a display write, then waits 2.5 s, which is longer than the 1 s poll | `963cd6a` | `I5eb18f64d1d5559796b3a07bc68544066d2eb7b8` |
| 6 `cases["ddl"]` was never asserted | Rust (`schema.rs` unit test) and Python both assert the DDL byte-for-byte | `fa11be3` | `Ia2f2e4d3dee2cba9da45100e682832603f6c92e0` |
| 7 Memory and Jsonl stores dropped overview writes | `put_overview` raises `StoreError`; reads still return None and [] | `f449a30` | `I66f0c271f310e44ddb3ea280494c1ec6f16b6a36` |
| 8 SDK versions not bumped | Recorded as a pre-release item in Open items; not bumped | (this commit) | `I860f836bb437370bc73e71000700b66ba14f17cb` |

| Suite | Before (`6c92cb9`) | After (`f449a30`) |
| --- | --- | --- |
| `cargo test --workspace --locked` | 384 passed, 2 ignored | 387 passed, 0 failed, 2 ignored |
| `python3 -m pytest -q sdks/python/tests` | 749 passed, 15 skipped | 839 passed, 15 skipped |
| `deno test --allow-read --config html/deno.json html/` | 161 passed | 216 passed, 0 failed |

One full cargo run failed
`remote::tests::blocking_facade_inside_a_runtime_reuses_and_async_client_does_not_pool`
while the host's load average was 12. That test counts pooled connections and
does not touch overviews. It passed three times on its own and in the next
full run.

What the port did not cover (the port was replaced in review round 2; see
that section for what the lint does not cover):
- The deno test cannot check attribute values, because Deno has no HTML
  parser. The SDK tests and the fuzzing against the HTML rules cover them.
- Named character references other than the five XML names, and `&amp`,
  `&quot`, `&lt` and `&gt` without `;`, stay as written. Investigation ids are
  plain ASCII.
- `insert_in_paragraph` inside a link reference definition is not checked
  against the bundle, because the bundle leaves no token for it.
- No CLI test runs `overview show --target URL` against a daemon. It calls the
  same `Workbook::overview` as the Rust remote test.

### Review round 2

An independent review of `7275b66..d729e10` found no disagreement between
the round-1 ports and the viewer bundle. The ports were still rejected: each
viewer or markdown-it change would need three coordinated edits (bundle, Rust,
Python), and nothing beyond the vectors guarded drift. OV-13 replaces them with
a canonical-form lint. The fixes are forward commits on yuzuquats master;
nothing is pushed, deployed or installed, and the live demo collections and
served seeds are untouched.

| Finding | What changed | Commit | Change-Id |
| --- | --- | --- | --- |
| The ports would drift from the viewer | `overview_blocks.rs` and `_overview_blocks.py` and their tests are deleted. Both SDKs run a canonical-form lint (OV-13). An insert is silent only when it is alone on one line at column 0, after a blank line or at the start of the document, as `<ap-investigation ...></ap-investigation>`, outside fenced and indented code. If the line holds a `\|`, the next line must be blank, so it cannot become a table header. Any other line mentioning the tag outside code gets `noncanonical_insert`, with `line` and `reason`; a line that may start an HTML block gets `html_block`. `cases.json` is restated for the lint with 12 new cases and a seeded generator (3,000 documents, pinned by digest). The deno test runs the bundled viewer over every warning-free vector and every generated document, and pins the bundle's sha256 | `aee6beb` | `Ie792999850a909b7bfad3a0c14086a8dc1f23e76` |
| 1 Text after `</ap-investigation>` is hidden with the card | Canonical form allows only whitespace after the closing tag. The old vector "a closing tag later in the line closes the card", whose trailing text is hidden, now warns ("text after </ap-investigation>"). A new vector covers it too | `aee6beb` | `Ie792999850a909b7bfad3a0c14086a8dc1f23e76` |
| 2 The activation loop's skip was only a comment | The loop in Open items now guards with `jq -e '.overview == null' \|\| continue`. A dry run on two scratch copies of a freshly generated seed: the collection holding a user note was skipped and stayed byte-identical (sha256); the one without overviews got both notes with the seed's digests and no warnings; projects missing from the collection were skipped. The scratch copies were removed | (this commit) | `Iea86f551adc3f13a6e8560a2afe95ac3953079e7` |
| 4 20+ nesting levels | A nested insert is not at column 0, so it warns. Deep lists also reach the lint's limit of 64 readings, after which no line counts as canonical, so every insert below warns | `aee6beb` | `Ie792999850a909b7bfad3a0c14086a8dc1f23e76` |
| 5 Named character references | Still applies, but it can only over-warn. The SDKs decode numeric references, the five XML names and `&amp`, `&quot`, `&lt` and `&gt` without `;`; the browser decodes about 2,231 names. The SDKs decode only where the browser decodes the same way, and ids are `inv_` plus 16 hex digits, so an undecoded `&` never matches a known id. The worst case is a false `unknown_investigation` | (this commit) | `Iea86f551adc3f13a6e8560a2afe95ac3953079e7` |

| Suite | Before (`d729e10`) | After (`aee6beb`) |
| --- | --- | --- |
| `cargo test --workspace --locked` | 387 passed, 2 ignored | 388 passed, 0 failed, 2 ignored (38 binaries) |
| `python3 -m pytest -q tests` in `sdks/python` | 839 passed, 15 skipped | 864 passed, 15 skipped |
| `deno test --allow-read --config html/deno.json html/` | 216 passed | 230 passed, 0 failed |

`test_cross_writer.py` passed (6 tests) with `AUTOPHYS_RUST_BIN` and
`AUTOPHYS_RUST_WEB_ROOT` set. This commit changes only this page, so its code
tree is the same as `aee6beb`'s.

The lint was also checked, outside the checked-in suites, against the bundled
viewer: about 39,000 random documents (up to 60 lines, some biased towards
lists, fences and tables), each compared on whether it renders, the card
lines, the card nodes and hidden text. For every document without warnings,
the viewer agreed: 0 mismatches. The Rust and Python lints gave identical
warnings on 24,000 documents.

The lint over-warns on purpose. These reviewer cases give no warning, because
the viewer shows them as code and hides nothing: four-space and tab-indented
code, backtick and tilde fences (including a longer close and an unclosed
fence running to the end), a fence in a list item, and an empty list item
followed by a fence. These warn although the viewer shows a card or hides
nothing: an insert indented by up to three spaces, one directly after an ATX
heading, multi-line attributes, an insert inside a fence in a blockquote, one
after an indented fence that follows a lazy line, an insert named in inline
code, and anything below the 64-reading limit (about 8 nested list levels).

What the lint does not cover:
- Attribute values are not checked by the deno test, because Deno has no
  HTML parser. The SDK tests and the decoding rules cover them.
- Named references, as in finding 5.
- No CLI test runs `overview show --target URL` against a daemon. It calls the
  same `Workbook::overview` as the Rust remote test.

### Agent choices made during implementation (pending operator review)

```review-table
| Id | Choice | Recommendation and reason | Strongest alternative | State and reversal |
| -- | ------ | ------------------------- | --------------------- | ------------------ |
| OV-6 | The shared insert list is `html/ui/investigation-inserts.json`. Rust embeds it, and Python carries a pinned package-data copy | The UI owns the keys, and the published Python wheel cannot read files outside its package | Generate the Python copy at build time: no checked-in duplicate, but the wheel build gains a step | Implemented in `ca3a230` and `5b1544c`. Switching to a generated copy changes the build only; cheap |
| OV-7 | Wire shape: `overview` is the Markdown and `overview_meta` is `{seq, digest, author, created}`. The SSE `overview` event carries the full body, has no `id:`, and is de-duplicated by digest per project | It keeps the existing `Project.overview: string`, and the SSE resume cursor is untouched | One `overview: {markdown, …}` object: tidier, but every reader of the string changes | Implemented in `31c9db4` and `84e31d6`. An adopted wire contract once shipped, so changing it later needs a compatibility window |
| OV-8 | CLI: `--author` defaults to `operator`. Warnings go to stderr, or into the JSON with `--json`. `show --json` returns `{project_id, overview}` | A person at the CLI is the operator, and the Python and Rust APIs still require an author | Require `--author` on the CLI too | Implemented in `31c9db4`. Requiring the flag is one line; cheap |
| OV-9 | Superseded by OV-13 in review round 2. In round 1, warnings were to follow the viewer's own block pass: both SDKs carried a hand port of markdown-it 14.1.0 with std-documentation's insert rule (`overview_blocks.rs`, `_overview_blocks.py`), with three new warnings `insert_in_paragraph`, `unclosed_insert` and `html_block`. Fuzzing found no disagreement with the bundle, but a port is a copy, not the parser, and it is only as exact as the vectors and fuzzing that check it | A warning is only useful if it matches what the reader sees | Depend on a Markdown parser in each SDK (`pulldown-cmark`, `markdown-it-py`): neither is markdown-it 14.1.0 with this custom rule, so the cards would still differ | Implemented in `fa11be3`, deleted in `aee6beb`. See OV-13 for reversal |
| OV-10 | Demo seeds become a new version through a script that copies the seed with SQLite's online backup and makes one Python SDK write per project. The template placeholders are `{{investigation_N}}` (creation order) and `{{KEY_investigation}}` (Jazz). Authors are `autophys-demo` for seeds, `--by` for `demo_workbooks.py` and `jazz-demo-spec` for Jazz | It needs no running daemon, the source seed is never written, and it checks that the chain is unchanged | `autophys overview set --target` per workbook (OV-5 as written): same bytes, but four commands and no chain check | Implemented in `1a5df7c`, not installed. Before installation, switching is free |
| OV-11 | Append-only is enforced by the SDK APIs, not by SQL triggers | Neither the display nor the config-version table uses triggers, and a trigger would be part of the format both SDKs must match | Add `BEFORE UPDATE/DELETE` triggers in the format-3 DDL | Not implemented. After seeds ship, adding triggers means a format 4 |
| OV-12 | `GET /projects/{pid}/overview` answers 200 with `{project_id, overview}`, where `overview` is `null` before the first write. An unknown project is 404, as for the versions route. A remote `overview_head` reads that route, because the daemon has no head-only route | `null` keeps "no overview yet" apart from "no such project", and matches `overview show --json` | 404 when there is no overview: one fewer shape, but a missing project and a missing overview look the same | Implemented in `963cd6a`. An adopted wire contract once shipped; before then, cheap |
| OV-13 | Before: both SDKs carried hand ports of the viewer's block pass (about 2,500 lines) and warned on exactly what the viewer would show. After (decided by the orchestrator in review round 2): a canonical-form lint. An insert is silent only alone on one line at column 0, after a blank line, as `<ap-investigation ...></ap-investigation>`, outside code, and not over a table delimiter row. Every other mention outside code warns `noncanonical_insert` with a `reason`; `html_block` stays as a conservative line-start check. Warnings gain an optional `reason` field | The ports agreed with the bundle, but each viewer or markdown-it change needed three coordinated edits and only the vectors guarded drift. The lint is smaller, never under-warns, and the deno test checks it against the real bundle on the vectors and 3,000 generated documents, with the bundle pinned by sha256 | Keep the ports and add a checked-in differential fuzz gate against the bundle: precise warnings with fewer false ones (the cases listed in Review round 2), but the three-way maintenance cost remains and the gate only finds drift when it runs | Implemented in `aee6beb` (`Ie792999850a909b7bfad3a0c14086a8dc1f23e76`), agent-chosen, pending operator review. To reverse, restore `overview_blocks.rs`, `_overview_blocks.py`, their tests, `cases.json` and the deno test from `d729e10`, and the `mod` line in `workbook.rs`. The `reason` field is additive and can stay. Nothing is shipped, so the cost is moderate: about an hour, plus the three suites |
```

### Review round 3

An independent reviewer found the stack ready (2026-11-13). Its tests:

- **Under-warning hunt:** about 55 hand-written cases and roughly 500k fuzzed
  documents, run against the bundled viewer. About 100k of them had no
  warnings. In every one of those, the viewer agreed with the lint on cards,
  card count and whether the document renders.
- **Rust/Python agreement:** the two SDKs gave identical warnings on 1,562
  documents.
- **Drift guards:** a mutated bundle, a changed generator and a changed
  insert rule each fail the deno test.
- **Demo templates:** all four `ops/*.template.md` lint clean.
- **Suites:** cargo 388 passed, 2 ignored; pytest 864 passed, 15 skipped;
  deno 230 passed.

The one low finding: the viewer can hide text in a warning-free document for
reasons that have nothing to do with inserts. The cases are inline HTML
(`<!-- -->` or an open tag mid-line), a hard break inside a setext heading,
and nesting past markdown-it's limit. All three predate this work.

The lint's guarantee is now worded to match what it checks: cards show as
written, and no insert hides text. Warning on these other cases stays open
as a possible follow-up.

## Dev activation — 2026-11-13

Dev now serves clean yuzuquats master 2b945706b9d2343ef269d9d7e18fe8d8e0f7666c
(version 0.1.5), the whole overview stack `7275b66..2b94570`. The canonical
package command (`ops/package.sh`) passed `cargo test --workspace --locked`
(388 passed, 0 failed, 2 ignored across 38 binaries) and the frontend suite
(230 passed), then built and packed the release executable. The packed
executable built the external web root from the same checkout.

The first package attempt failed to compile the release binary: the SDK's
release fingerprint (`target/release/.fingerprint/autophys-266783db215b618f`)
still described the `target/release-v0.1.5-source` export, whose older SDK has
no overview API, so cargo reused that build. This is the same stale-export
problem the debug profile had in Result. The three fingerprint files were
renamed with the suffix `.stale-export-20261113`, not deleted, and the rerun
compiled the SDK from master. No source changed. The vendored Tento crates
also carry export fingerprints, but `vendor/tento` matches the export except
for its uncompiled `node_modules`.

One restart activated autophys-dev.service on 127.0.0.1:4796 at
2026-11-13 06:55:36 PST (PID 1495267, no restarts since). Release:
~/.local/share/tento/services/autophys-dev/releases/2b94570-overview-20261113;
`current` points at it, and it previously pointed at
releases/37d98c8-jazz-20261112, which is retained. Public /api/healthz:

```
{"ok":true,"version":"0.1.5","commit":"2b945706b9d2343ef269d9d7e18fe8d8e0f7666c","web_id":null}
```

The release no longer serves `demo-overview.md`,
`demo-overview-oscillator.md` or `demo-overview-thermal.md` (404).
`demo-overview-jazz.md` is still served, as Open items describe.

**Data.** Dev has one demo collection,
~/.local/share/tento/autophys-dev/books, which is the demo account's
workspace root (`ws_u_8a9979586c4a`). The only other workspace is the smoke
account's `smoke-books` (dev-smoke-20261109, not seeded from the demo); it was
not touched. `workspace_seeds` is empty and there is no separate served seed
collection, so step 6 installed no seed version. Before activation all four
demo workbooks were format 1 (`PRAGMA user_version`), had no `overviews` table
and had empty WAL files.

| Workbook | Project | Records | sha256 before |
| --- | --- | --- | --- |
| battery_cycler_demo | prj_63f1a2034c21136b | 29 | 11d8744925d6501ff848322a69d3c04ecaf8cebb84fbea2b844850ace923ea9b |
| mass_spring_damper_demo | prj_9b527dc752b58372 | 17 | 293a2e2b83dfcbb704dff88f815470d2b63375dd554215eccc8db02ef32e5c0e |
| thermal_rc_demo | prj_3d1666c2279a6864 | 17 | 9923092802cb581cdf57b7c0129c90d2e89920ac1f50aeb6772a0e67c71a7028 |
| jazz_performance_demo | prj_3659cd6483a22a2f | 6 | 7a1a9be6e1de63c0765389d0ed520fb6854a6136ce61188d4e3ed4db21942273 |

Backups, taken before the restart, in
~/.local/share/tento/services/autophys-dev/backups/overview-20261113/:
- `bytes/`: byte copies, identical to the live files above (the WAL files
  were empty). These are the rollback copies.
- The top level holds SQLite online backups (`.backup`), whose dumps equal
  the live workbooks: battery `11d87449…`, mass_spring_damper `b7ad299c…`,
  thermal `569a3fa6…`, jazz `56031869…`. It also holds server.db
  (`a7448ff7615d7725d4b0a596702abe100f3e06bef8453864837007055718923f`), which
  this activation did not write. `SHA256SUMS` in each directory has the full
  hashes.

The overview source was a format-3 seed generated by
`ops/demo_overviews.py --from <books> --out <empty temp dir>`. It opens the
live collection read-only, and the live hashes were unchanged afterwards. Its
rendered notes equal the previously served static files byte for byte.
After the new server was running, the guarded loop from Open items
(`overview show … | overview set … - --author autophys-demo`) wrote each note
into the live collection. No project was skipped and there were no warnings:

| Project | seq | Digest (sha256 of the Markdown) | Previously served file |
| --- | --- | --- | --- |
| battery_cycler_demo | 1 | b3fbb8f68fab0cfe6c7fe6908c1267a0263283a7a36cb20f1c9b65eb4eeb0a8f | demo-overview.md (72e476c and its last version before 1a5df7c) |
| mass_spring_damper_demo | 1 | f63bcfcae08219d9717213d437b97f81bba77efc2532a597a58ed70aed409e8f | demo-overview-oscillator.md |
| thermal_rc_demo | 1 | 74e3b3e58c1e4e87c9bead5d8e8af68718297c4f5f5b129e73231b159c94e783 | demo-overview-thermal.md |
| jazz_performance_demo | 1 | 68b4721f5a3c1afb84b3aff3287a003e3b79eded05f84026efbfc1c1b205099c | demo-overview-jazz.md |

All four workbooks are now format 3. `autophys verify` (release binary)
passes on each before and after: no chain errors and projections match. All
69 records keep their ids, chain positions and hashes, and investigation rows
are unchanged (row dumps compared before and after). The main-file hashes
have not changed yet because the new pages are still in the WAL, which the
running server holds.

**Qualification** (headless chrome-headless-shell 131 on yuzuquats, via
tento-headless-js):
- Before the writes, on the new server: all four demo workbooks at 1280×800
  and 390×844 showed no Overview node and no document. There were no console
  errors and no failed responses.
- SSE: a page left open on battery_cycler_demo showed the Overview node
  6.6 s after the watcher was ready, while the writes ran, with no reload.
- After the writes, each workbook was opened through
  `/open/demo/workbook/<project>` and its Overview selected in the tree, at
  both sizes. The document renders. All 7 card inserts (14 checks) show their
  authored titles and summaries, and none is "Investigation unavailable".
  The following prose and each note's final sentence are present. Technical
  details start collapsed. Neither the page, document, cards, technical
  sections nor document tables overflow horizontally, before or after the
  details are opened. All 64 card link checks select the matching tree node:
  the Validation result link selects its investigation, as before.
- Statuses: battery shows Complete · validated and Awaiting approval;
  oscillator and thermal show Complete · validated; Jazz shows Awaiting
  approval on all three cards.
- No page errors and no application console errors. The only failed
  requests are open-link `HEAD` probes (`redirect: "manual"`, reported as
  ERR_ABORTED), which the previous release also makes. The one 401 came from
  the qualification's own browser fetch of the overview route.
- `GET /api/v1/projects/{pid}/overview` requires a bearer key (`Keyed`, like
  `config_versions`), so the browser session gets 401; the UI reads
  `/workspace`. On dev, an unauthenticated request gets 401 and a misspelled
  route gets 404. No key was minted on dev. Instead, a temporary loopback
  instance of the same release binary ran on a backup copy of the live thermal
  workbook, and a device key was paired to it. It answered 200 with
  `{project_id, overview: {seq, digest, author, created, markdown}}`, seq 1,
  digest `74e3b3e5…`, and the Markdown hashed to that digest. `autophys
  overview show --target URL` returned the same. The instance, its key and
  the copy were removed.

The host's AppArmor user-namespace restriction requires `--no-sandbox` for
headless Chrome here. No browser processes remained afterwards.

**Rollback** (data and code together, because the old server cannot open
format 3):
1. `systemctl --user stop autophys-dev.service`.
2. In ~/.local/share/tento/autophys-dev/books, move each
   `*.ap-workbook-wal` and `*.ap-workbook-shm` aside. They hold the overview
   pages, and a stale WAL must not be replayed onto a restored file.
3. Copy `backups/overview-20261113/bytes/*.ap-workbook` over the four
   workbooks. Check them with `sha256sum -c bytes/SHA256SUMS`.
4. Point `current` at `releases/37d98c8-jazz-20261112`, then
   `systemctl --user start autophys-dev.service`.
5. Check /api/healthz for 37d98c8b4a6f2699e4c833cbfa942ac7972778bf.

**Not done.** Production autophys.service is still PID 1747, active since
2026-11-09 05:26:46 PST. There was no source push and no SDK version bump
(see Open items). No seed version was installed, because dev has no separate
seed. `html/routes/demo-overview-jazz.md` was not removed. The owner
workspace and home layout checks show only their existing findings (the
tracked `autophys` entry and undeclared home entries), and this work added no
root or home entries; they were not run before the work.

Evidence (ignored): yuzuquats
~/workspace/fleet/evidence/autophys/overview-sdk-activation-20261113/ holds
the package logs (including the failed first attempt), the inventory, backup
hashes, the new-seed report, write results, verify output before and after,
record and investigation dumps, `qualification-{pre,live,post}.json`,
screenshots, the healthz output and the API probe. This docs-only receipt
follows the activated source commit and does not trigger another activation.
