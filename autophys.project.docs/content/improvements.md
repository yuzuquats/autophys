# Improvements: a running list

Status: started 2026-11-04 by autophys/py. Any session may add an item.

Each item is something found while working that should get better but has
not been scheduled. It belongs here, not in a task board or a chat thread.
- **Adding one:** append a row with the next number, where it was found
  (a commit, page or evidence path), its owner, and a state.
- **Finishing one:** set the state to `done` with the commit that fixed it.
  Leave the row in place; never renumber.
- **Not here:** decisions belong in [decisions.md](decisions.md), and
  scheduled work belongs in its own plan page.

States: `open`, `in progress`, `done`, `won't do` (with a reason).

## Measured-data ingest

Found in the first real-data run, Onori M50T HPPC
([sdk.md](sdk.md), "First real-data investigation").

```review-table
| # | Improvement | Found in | Owner | State |
| - | ----------- | -------- | ----- | ----- |
| 1 | Accept measured time stamps: today a CSV must start at t = 0 and equal `time_grid(settings)` to 1e-9, so each real measurement must become its own catalog experiment carrying its times | 717980d | autophys/py | open |
| 2 | Import measured inputs (for example current) from the CSV for user projects; `read_csv` maps only `t` and the outputs | 717980d | autophys/py | open |
| 3 | A battery model for real cells: an OCV table, capacity and a measured current profile from settings, instead of `battery_ecm`'s fixed values and three waveforms | 717980d | autophys/py | open |
| 4 | Don't require `kind` on a measured window that has no generator | 717980d | autophys/py | open |
| 5 | Import long logs: CSVs are capped at 1 MiB and 10,000 rows, so a 55,257-row HPPC log has to be windowed by hand | 717980d | autophys/py | open |
| 6 | Vendor formats and conventions: a reader for Arbin `.xlsx` (stdlib only), and a declared current sign convention | 717980d | autophys/py | open |
| 7 | Store display manifests in local workbooks, not only through `HttpStore`, so local projects get labels and units in the UI (`display: null` today) | 717980d | autophys/py + autophys/rs | open |
```

## Muse and the MCP plugin

```review-table
| # | Improvement | Found in | Owner | State |
| - | ----------- | -------- | ----- | ----- |
| 8 | `plugins/muse-autophys/build.py` emits `["sh", "mcp-stdio.sh"]`, which Muse can't start, because it launches stdio servers in the workspace directory; `["./mcp-stdio.sh"]` works | a285c85; `~/.local/state/autophys/evidence/muse-smoke-20261104/` | MCP integration owner | open |
| 9 | Verify whether Muse Spark and Wonder accept images; until then `images=True` is an unverified assertion | d9946f9 | autophys/py | open |
| 10 | The laptop's Muse login is in a Keychain that is locked over SSH, so live runs go through rwc-dev-01's Muse instead | a285c85 | operator | open |
```

## Cross-SDK consistency

```review-table
| # | Improvement | Found in | Owner | State |
| - | ----------- | -------- | ----- | ----- |
| 11 | A step's `error` text differs: Python prefixes the exception class (`ReasonerError: `), Rust writes the bare message. It is free text and not validated | d9946f9 | autophys/py + autophys/rs | open |
```

## Tests and tooling

```review-table
| # | Improvement | Found in | Owner | State |
| - | ----------- | -------- | ----- | ----- |
| 12 | Find and fix the suspected flaky Python test (operator request); a 10-run loop is in progress | `~/.local/state/autophys/evidence/flaky-20261104/` | autophys/py | in progress |
| 13 | The opt-in cross-writer tests rely on wall-clock windows (`2.9 <= elapsed < 4`) and a fixed 0.3 s sleep before a waiter subscribes | `sdks/python/tests/test_cross_writer.py:123,182` | autophys/py | open |
| 14 | Headless UI checks on rwc-dev-01 (ARM64): the cached `chrome-headless-shell` is x86-64, so only Playwright's Chromium with `--no-sandbox` runs | 717980d | autophys/ui | open |
| 15 | Agents can't confirm views in the live UI since `/app` requires an email and password sign-in | 717980d | operator + autophys/ui | open |
```
