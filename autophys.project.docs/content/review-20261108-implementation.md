# Build the 2026-11-08 review decisions

Status: plan, 2026-11-08. The operator said "start" after the
`/open-questions` review recorded in [decisions.md](decisions.md) ("Operator
review, 2026-11-08" and the sub-questions). Nothing here is pushed or
released; commits stay local on yuzuquats `~/workspace/autophys` master.

## What changes

| Id | Change | Where |
| --- | --- | --- |
| DM-RS-1 | Rust `Trajectory` becomes an explicit struct: no map `Deref`/`DerefMut`; `outputs()`, `inputs()`, channel lookups that return an error naming the channel; serialised as `{"y": {...}, "u": {...}}` (DM-RS-1a); equality compares inputs too | `sdks/rust/src` (trajectory, simulator, curves, display, worker and callers), Rust templates in `examples/` |
| RS-REMOTE-2 | Python errors when a daemon lacks `reveal` or `display` (no warn-and-skip), with an "upgrade the daemon" message, like Rust | `sdks/python/src/autophys/http.py` |
| DM-D1 | Workbook format 2 holds the display table; a workbook migrates to 2 at its **first display write**, never on open (DM-D1a); format-1 workbooks without a display stay readable by SDK 0.1.x. Python gains its first migration step | both SDKs' workbook and schema code, the daemon's display route |
| UI-27 | New project becomes a three-step SDK flow: `autophys new --lang python\|rust`, `autophys connect <daemon> --name <device>` with the pairing approved in place, then the first investigation appearing. The Thermal wizard is removed | `html/` |
| O-3a | Deploy passes the host's tento.localhost origin as `--browser-origin` | `ops/` |
| RS-REMOTE-1 | Rust remote transport becomes async (tokio); `autophys::blocking` is a thin facade the CLI, the investigation loop and scripts use (RS-REMOTE-1a) | `sdks/rust/src/remote`, client, CLI callers |
| CORE-01 | A generic multi-record transaction endpoint replaces `POST …/proposals/{pid}/attachment`, which is **removed** (CORE-01a); both SDKs attach through the batch endpoint. Released SDKs 0.1.x cannot attach against the new daemon | `src/http.rs`, store, both SDK clients |
| CORE-04 | `project(name)` opens and errors if missing in both SDKs; Rust callers that relied on create use `ensure_project` | `sdks/rust/src/client.rs`, callers, docs |

## Order

Wave 1 runs in parallel on disjoint files: DM-RS-1 (Rust SDK types),
RS-REMOTE-2 plus Python's DM-D1 half (Python SDK), UI-27 (`html/`), O-3a
(`ops/`). Wave 2 is one sequential stream over the Rust remote transport,
the daemon and the store, which all three of its changes touch: RS-REMOTE-1,
then CORE-01 (Python's client side included), then CORE-04 and the Rust and
daemon half of DM-D1.

## Validation

Each change carries its own tests. Before the work is called done: `cargo
test` for the workspace, `python3 -m pytest -q sdks/python/tests`, the
`html/` Deno tests, and an independent Opus review of the whole range.
Breaking changes (CORE-01's removed route, CORE-04, DM-RS-1, format 2) are
listed in the next release's notes; no version bump or release is part of
this plan.

## Remaining work

Tracked here as each wave lands.
