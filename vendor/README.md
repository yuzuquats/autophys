# Vendored dependencies and release blockers

`vendor/tento/` is source committed into Autophys, not a Git submodule,
symlink or reference to `../tento`. Cargo and both browser import maps resolve
inside this checkout. Keep library names and existing notices: renaming them
would not remove a dependency or establish a license grant.

| Consumer | Vendored dependency and purpose |
| --- | --- |
| Root Rust CLI | `tento-web`: file routing, browser bundler and dev watch; `tento-sh`: typed command tree; `tento-dirs`: compatible app state/cache locations |
| Browser | `tento-cookbook-js` shell and `tento-ui-js`, with transitive core, chrono, trace and Lisp utilities |
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

The root and Rust SDK declare `license = "UNLICENSED"` and `publish = false`;
Python declares `Apache-2.0` but has no included top-level license text. Most
vendored Tento crates omit license fields/text. These are **release blockers**:
the owner must choose the product license, confirm rights to redistribute the
vendored source and provide the appropriate grants/notices/provenance. No license
choice, source publication or permission to redistribute is implied by this
cleanup. Broader extraction/pruning of upstream libraries is a separate design
change; it must retain their actual transitive closure and existing notices.
