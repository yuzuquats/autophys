# tento-lisp

`tento-lisp` is a small Lisp parser and evaluator used for sheet formula and
expression experiments.

## Public surface

- `Runtime::parse(filename, input, interner)` parses source into S-expressions.
- `Runtime::eval(filename, input)` evaluates a source string and returns values.
- `SyntaxResult` is re-exported for parser callers.

## Boundaries

The crate owns language parsing and evaluation. Host code should not depend on
lexer or grammar internals unless those modules are made public intentionally.

Keep host-specific functions, sheet row access, and UI behavior outside this
crate. If formulas need runtime bindings, expose them as evaluator inputs or a
separate adapter layer instead of importing sheet code into the language core.

