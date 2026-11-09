# Vendored dependencies

`vendor/tento/` is source committed into Autophys, not a Git submodule,
symlink or reference to `../tento`. Cargo and both browser import maps resolve
inside this checkout. Keep library names and existing notices: renaming them
would not remove a dependency or establish a license grant.

| Consumer | Vendored dependency and purpose |
| --- | --- |
| Root Rust CLI | `tento-web`: file routing, browser bundler and dev watch; `tento-sh`: typed command tree; `tento-dirs`: compatible app state/cache locations |
| Browser | `tento-cookbook-js` shell and `tento-ui-js`, with transitive core, chrono, trace and Lisp utilities |
| Browser (header) | `tento-brand-js` app switcher kit (`kit/app-switcher.ts`, `kit/app-switcher.packaged.ts`) and the native-UI helpers it imports (`src/`): the Lona family app switcher, packaged by `tento-web-js/build-plugins/app-switcher.deno.ts` (html/app-switcher/README.md) |
| Optional browser flow | `tento-headless-js` child lifetime/cleanup helpers |
| Cargo patches | `vendor/{notify,fsevent-sys,iana-time-zone}` as declared in root Cargo.toml; each has README.vendor.md provenance and existing license files |
| Rust/Python SDKs | No sibling Tento or Lona source dependency; registry/PyPI dependencies still need acquisition |

The root workspace excludes the vendor workspace as a build/test member.
Vendored Rust manifests inherit path/dependency definitions from
`vendor/tento/Cargo.toml`; the root lock records the resulting graph. The copy
contains more source than this application imports, including upstream tooling,
examples, historical docs and Lona adapters. The app constructs its own
DomainConfig/compiler and does not construct `TentoWebJsConfig` (the upstream
Lona server's rebuild-root adapter), use fleet registration, or require
TENTO_LONA_JS_ROOT. Do not treat a successful grep as proof of an unused crate:
use Cargo metadata and the browser module graph before extracting libraries.

## Provenance and licensing still need owner review

Autophys history records the vendor import and subsequent changes (`git log --
vendor/tento`). Imported project records identify the earlier shell and shared
library history, but there is no complete immutable upstream-source manifest
for the entire current snapshot. The exact bytes are identified by the committed
`vendor/tento` Git tree and the package lock, not by an unrelated host checkout's
HEAD. Preserve this history and the patched crates' attribution.

## License

The operator chose the product license on 2026-11-07: autophys is dual
licensed **MIT OR Apache-2.0** (root `LICENSE-MIT`, `LICENSE-APACHE` and
`NOTICE`). The root and Rust SDK manifests and the Python SDK declare that
expression. As copyright holder, the operator licensed this `vendor/tento`
copy under the same terms; the grant lives in the root `NOTICE`, so the
vendored bytes are unchanged. Crates there that already declare MIT keep that declaration. The
patched crates under `vendor/tento/vendor/` and the prebuilt editor bundles
in `html/routes/js/` keep their own licenses (`licenses/web-editors.txt`).
Release archives add `THIRD-PARTY-LICENSES.txt` for every compiled crate.
Broader extraction/pruning of upstream libraries is a separate design change;
it must retain their actual transitive closure and existing notices.

## Vendored libraries are not edited in place

Operator direction, 2026-11-08: do not edit the vendored tento libraries
(the cookbook included) directly. A change lands upstream in tento, is
re-vendored here, and the bundler-context manifest is re-pinned in the same
commit. `verify.py` fails on any other vendor byte change. It was re-pinned
on 2026-11-08 (`repin-20261108`, all 2,441 tracked `vendor/tento` files),
after cookbook, tento-lisp-cmd, tento-web and tento-brand-js edits that had
been made in place since 2026-11-05.

## App-owned CLI failure patch (G4)

`patches/autophys-cli-errors/` records autophys's one change to vendored
`tento-lisp-cmd` (2026-11-08): an opt-out from printing a command's usage
block to stdout on failure, and one-line argument errors. Its README lists
both files and how to reverse the patch.

## App-owned bundler context patch (Round 2)

The historical snapshot generator, fifteen-patch series and `vendor.lock` are
unavailable on permitted retained references. Round 2 uses the **current retained
vendor source** as an acknowledged recovery base, not a pristine upstream tree.
The surviving upstream object `56389ac9d80c5b1ce5704bc2d9cacc89fd2def12`
is a provenance reference; it does not reconstruct the inherited delta.

`patches/autophys-bundler-context/` contains one inspectable app-owned patch,
preimage/postimage and patch digests, the retained Git-tree reference and a
SHA256 manifest of the current vendor source. Only
`tento-web/src/client/bundler.rs` changes. The new public constructor accepts
an explicit product Deno config and offline flag; the existing constructor
retains its previous behavior for other callers. Autophys supplies its own
config, frozen lock and node-module policy to the real bundler subprocess.
All other inherited vendor bytes, including cookbook deck/drawer, are retained.

From a standalone source archive, with Python 3 and POSIX `patch`:

```sh
python3 vendor/patches/autophys-bundler-context/verify.py /absolute/external/replay-work
```

The checker verifies current vendor bytes, reverses the one patch to its
hashed affected-file preimage, then replays it to the hashed postimage. It
requires no Git objects, private paths or sibling checkout. This is bounded
patch replay/current-tree verification, **not full upstream regeneration**.
The original manifest intentionally pins the historical retained vendor tree.
`provenance.json` also pins one complete publication variant: eight cookbook
files retain their exact bytes at public base `189a4ddd12f618882bcea00417dad8c9a026ffe5`,
while the bundler patch stays identical. This lets the reviewed app changes ship
without importing unrelated unpublished tour, deck or drawer work. The checker
accepts either complete manifest and rejects mixtures, missing files and other
changes. It does not infer provenance from a reachable host or mutable branch.
Future intentional vendor changes must update their provenance and manifest.
This mechanism neither repairs the inherited provenance gap nor supplies any
missing license grant. Existing attribution and release blockers above remain.
