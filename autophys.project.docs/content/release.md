# GitHub releases

## v0.1.0, 2026-11-07

Published at https://github.com/yuzuquats/autophys/releases/tag/v0.1.0 (marked
latest). The tag points at `59df761` ("Build release archives with their license
notices"), above `16e514d` (the license, LIC-1 and LIC-2 in
[decisions.md](decisions.md)).

| Asset | sha256 |
| --- | --- |
| `autophys-v0.1.0-x86_64-unknown-linux-gnu.tar.gz` | `1e1f486b6250cfd5d01fbfdeaeb2a68426189ef60a276f0f94e55218720118eb` |

Each archive holds the packed `autophys` (web app embedded, B-1), `LICENSE-MIT`,
`LICENSE-APACHE`, `NOTICE`, `README.md` and `THIRD-PARTY-LICENSES.txt` (written by
`ops/third-party-licenses.py`: 434 third-party crates, 37 covered by NOTICE, plus
`licenses/web-editors.txt`). `ops/release.sh --out-dir DIR` builds one host's
archive and runs a smoke test on it, with isolated state.

### Validation

The asset was downloaded from the release and checked on yuzuquats, with an
isolated HOME and only the release directory on PATH:

- The sha256 matches, and `--version` names `59df761`.
- `autophys new --lang python` installed the SDK from GitHub, pinned to the same commit.
- The README walkthrough ran locally: `start --simulate` left an unidentified
  parameter, `approve` was accepted, `continue --simulate` reached `validated`
  (held-out chi2/N 1.04), and `verify` was ok.
- `serve` served the embedded app: `/api/healthz` reports the commit and web_id
  `fa4c546d…`, and `/`, `/app` and `/index.root.js` returned 200.
- `connect` and `pair approve` paired the device, and `whoami` worked.
- The walkthrough repeated against the server over HTTP: 2 validated
  investigations, and `verify` was ok with 38 records.
- Headless Chrome loaded `/` and `/app` with no console, page or request
  errors, and showed both investigations validated.
- After publishing, an anonymous `curl` download from the public URL matched
  the sha256, served healthz, and returned 200 for `/app`.

### Caveats

- The Linux binary needs glibc 2.39 or later (Ubuntu 24.04, Debian 13).
- **macOS arm64 is not attached yet.** The build on rwc-01 (from the v0.1.0 tag,
  on the SSD) was running `cargo test` when someone else force-unmounted the
  external SSD at 04:18 (`sudo diskutil unmountDisk force disk7`, still hung at
  04:34). All 13 `train_lifecycle` tests then failed with missing files; every
  earlier suite had passed. The operator chose to publish Linux first. To add
  macOS once the SSD is back:
  1. On rwc-01, run `ops/release.sh` from a v0.1.0 checkout with its output on the SSD.
  2. Run the same end-to-end check plus the browser check (`tento-headless-js`).
  3. Upload the archive and its `.sha256` with `gh release upload v0.1.0`, and
     restore the macOS row and the quarantine note in the release notes.

  The macOS executable is ad-hoc signed, not notarized.
- The vendor patch verifier was already failing before this release
  (vendor/README.md).
