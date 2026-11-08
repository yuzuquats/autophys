# App-owned CLI failure patch (G4)

`errors.patch` is autophys's change to its vendored `tento-lisp-cmd`, made for
field-test issue G4 (operator decision 2026-11-08: one-line error plus a
`--help` hint). Apply or inspect it against the vendored tree with
`patch -p1 --dry-run -R < vendor/patches/autophys-cli-errors/errors.patch`
from the repository root.

- `src/shell.rs`: `Scripts::usage_on_failure` (default `true`) and the
  builder `without_usage_on_failure()`. With it off, a failing command no
  longer prints its plain `Name/Description/Options` block to stdout before
  the error. Other embedders keep the old behaviour; autophys turns it off
  on its root and each nested group (`src/scripts.rs`).
- `src/command_arg.rs`: argument errors are one line naming the option:
  `missing required option --x`, `unknown option "--x"`, `unexpected
  argument "W"`, and `unknown option "--x"` for a command without options
  (serde's `invalid type: map, expected unit`). The multi-line
  `Failed to parse arguments. Expected/Provided/Error` text is gone; the
  option list is what `--help` renders. Lisp callers get `:x` spelling.

autophys formats every failure in `src/cli_error.rs`. The same change was
proposed to tento's owners (a before/after over five tento tools is in the
field-test record); this copy does not wait for it. Reversal: reverse this
patch and drop the `without_usage_on_failure()` calls.

Like the bundler-context patch, this changes vendored bytes, so
`autophys-bundler-context/current-tree.json` (already stale, see
`vendor/README.md`) does not cover `tento-lisp-cmd/src/{shell,command_arg}.rs`
either; re-pinning stays separate work.
