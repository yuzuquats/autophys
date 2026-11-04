# Runtime specs, the `folder.*` tsh DSL and the CLI

`folder!` describes a layout at compile time. A `Spec` describes the same
kind of layout as owned data, built at runtime, so a layout can live in a
file: a `.rebar` rule, or a standalone spec.

## `Spec`

```rust
use tento_folder::{Spec, SpecEntry, SpecKind};

let spec = Spec::closed(vec![
  SpecEntry::new("Cargo.toml", SpecKind::File),
  SpecEntry::new("README.md", SpecKind::File).optional(),
  SpecEntry::new("src", SpecKind::Folder(Spec::new(vec![
    SpecEntry::new("*.rs", SpecKind::File).required(),
  ]))),
]);
spec.validate(dir)?;   // Err(FolderError) collects every violation
```

Literal entries are checked first and claim their names. Every other
child goes to the most specific glob that matches it (the one with the
most non-wildcard characters), so entry order never matters. The
macro-built `Schema` instead takes the first matching glob in declaration
order.

`Spec` also checks three things the macro form does not:

- **closed** folders report every undeclared child as
  `FolderError::Unexpected`;
- **required** globs must match at least one child that no literal
  claimed. `{"mod.rs" file, "*.rs" (some file)}` needs a `.rs` file other
  than `mod.rs`;
- **none** entries (`SpecKind::None`, `folder.none`) forbid what they
  match, in open and closed folders alike, as `FolderError::Forbidden`.
  A `none` glob carves an exception out of a broader one: with
  `{"tento-*" dir, "*.project.docs" none}`, `tento-x.project.docs` is
  forbidden because the more specific glob claims it.

Symlinks count as whatever they point at. A dangling link is an `io`
violation.

Related helpers:

- `tento_folder::violations(root, &err)` flattens an error into sorted
  `FolderViolation { path, problem, detail }` rows with relative paths.
- `Spec::rows()` lists every entry by full path, and `Spec::rows_table()`
  renders those rows as a `table/v1` shape.
- `Spec::from_json` and `Spec::to_json` round-trip it through JSON.
  `from_json` rejects anything that would mean nothing: `optional` on a
  glob, `required` on a literal, `optional`/`required` on `none`, `entries` or `closed` on a file, a flag
  on the root, or a `.` / `..` name.

## The `folder.*` DSL (feature `tsh`)

```tsh
(folder.closed {"Cargo.toml" folder.file
                "README.md"  (folder.opt folder.file)
                "vendor"     folder.any
                "*.bak"      folder.none
                "src"        (folder.dir {"*.rs" (folder.some folder.file)})})
```

- `tento_folder::tsh::spec_from_tsh(src)` evaluates the source on the tsh
  engine, in-process, after `TSH_PRELUDE`.
- The `tsh` feature pulls in `tento-lisp-cmd`. The default build does not,
  so crates that only use `folder!` never depend on the shell.
- `tento_folder::TSH_PRELUDE` is always available as a plain string, so a
  crate that already runs the tsh engine (tento-rebar) can bind
  `folder.*` without turning on `tsh`.

## CLI and tsh plugin (feature `cli`)

```text
cargo run -p tento-folder --features cli -- check layout.folder [dir] [--report]
cargo run -p tento-folder --features cli -- show layout.folder
```

- **Output:** `check` fails and lists every violation. `--report` returns
  them as `folder.check/v1` records instead.
- **Plugin:** the binary is also the `folder.*` tsh plugin.
- **File names:** name spec files `*.folder`, not `*.tsh`. The command
  engine runs the first `.tsh` argument on the command line as a script.
