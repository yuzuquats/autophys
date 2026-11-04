# `tento-term` render fixtures

JSON fixtures in the style of the `tento-data-js` fixtures
(`tento/tento-data-js/tests/**/fixtures/*.json`). Each file holds a set of
*cases*; each case has an `input` (a serialized `Table`/`Tree` plus a
`term_width`, or a primitive op) and an `expected` rendered result.

The `tests/fixtures.rs` runner globs every `*.json` in this directory, renders
each case, and `assert_eq!`s the result against `expected`. Rendering runs with
ANSI colour forced **off** (`colored::control::set_override(false)`) so the
expected output is plain text + box-drawing — easy to read and diff. A case can
opt back into colour with `"color": true` in its `input` (see `colored.json`);
those expected blocks carry `[…m` SGR codes. Colour / ANSI-width
correctness is also covered by the in-crate unit tests in `width.rs`.

> **Status of the `expected` blocks.** Until the implementation lands these are
> hand-authored *design targets* — they show the intended shape of each edge
> case (which columns survive, where the hybrid sub-lines appear, where the `…`
> falls in tables, how the tree wraps). Once the renderer exists, run
> `BLESS=1 cargo test -p tento-term` to overwrite every `expected` with the
> real output, then `git diff -- tento/tento-term/tests/fixtures/` to review
> the exact spacing. Reviewers: focus on structure, not on counting
> box-drawing characters.

## Schema

```jsonc
{
  "type": "tento-term-render",
  "name": "<file basename>",
  "description": "...",
  "cases": [
    {
      "name": "...",
      "input": { /* see below */ },
      // table / tree cases: one string per rendered line (the runner joins with "\n").
      // primitive cases: a single string (the op's result).
      "expected": ["line 1", "line 2", "..."]
    }
  ]
}
```

### `input` — `kind: "table"`

```jsonc
{
  "kind": "table",
  "term_width": 60,
  "color": false,                      // optional, default false — true forces ANSI colour on for this case
  "table": {
    "title": "Fe Releases",            // optional. string -> a styled title cell; null/omitted -> no title line
    "header_style": null,              // optional Style applied to the header cells AND the "─" rule (e.g. "dimmed")
    "columns": [
      {
        "header": "Version",
        "align": "right",              // "left" (default) | "right" | "center"
        "min_width": 7,                // default 0  — the fitter never shrinks below this
        "max_width": 20,               // default null (unbounded)
        "flex": 0,                     // default 0  — share of leftover width when the table is narrower than the terminal; 0 = never grow past natural width
        "priority": 0,                 // default 0  — lower = kept longer; higher-numbered columns are demoted to per-row sub-lines first when space runs out
        "overflow": "truncate_end",    // "truncate_end" (default) | "truncate_middle" | "clip" | "wrap"
        "style": null                  // optional Style applied to every cell in this column unless the cell carries its own style
      }
    ],
    "rows": [ ["1.4.2", "prod,rc", "a1b2c3d4", "05-10 14:22 -21h", "ui, sheets-ui"] ],
    "gap": " ",                        // default " "  — string drawn between columns
    "header_rule": true,               // default true — draw a "─" rule under the header
    "subline_indent": 3                // default 3    — indent (spaces) of the hybrid sub-lines
  }
}
```

A row cell is either a bare string (no style — the column's `style` applies if
set) or `{ "text": "running", "style": "green" }` (an explicit per-cell style,
which overrides the column's). A `Style` is one of `"none"` (default), `"red"`,
`"green"`, `"yellow"`, `"blue"`, `"magenta"`, `"cyan"`, `"gray"`, `"dimmed"`,
`"bold"`. Cells/columns/headers always carry styles in the model; whether they
*emit* ANSI is decided at render time (`color` above / `colored::control`), and
width math always counts the visible text only.

### `input` — `kind: "tree"`

```jsonc
{
  "kind": "tree",
  "term_width": 80,
  "tree": {
    "root": {
      "label": "lona-control-pane health (lona-staging)",
      "children": [
        { "label": "edge bypass", "children": [
          { "label": "✓ agent-validation token", "detail": "present" }   // leaf: detail rendered after the label, 2 spaces apart
        ] },
        "README.md"   // a bare string is shorthand for { "label": "README.md" } (a leaf)
      ]
    }
  }
}
```

`detail` is optional (default none); `children` is optional (default empty). A
node's `label` (and the root's) may also be `{ "text": "...", "style": "..." }`
to colour it. The root node is printed flat — no branch glyph or prefix; only
its descendants get `├──` / `└──` / `│`.

When a node's line is wider than `term_width` the tree **wraps**: the post-glyph
text (`label`, plus `"  " + detail` when present) is greedily word-wrapped —
whitespace runs collapse to a single space — onto continuation lines that carry
the node's continuation prefix (`│   ` if the node has a following sibling, else
`    `, plus the ancestor prefix). A single token wider than the available
width is hard-broken (no ellipsis). Lines never exceed `term_width`.

### `input` — `kind: "primitive"`

```jsonc
{ "kind": "primitive", "op": "pad_right",         "text": "ab",     "width": 5 }                       // expected: "ab   "
{ "kind": "primitive", "op": "pad_left",          "text": "ab",     "width": 5 }                       // expected: "   ab"
{ "kind": "primitive", "op": "pad_center",        "text": "x",      "width": 5 }                       // expected: "  x  "
{ "kind": "primitive", "op": "truncate_ellipsis", "text": "abcdef", "width": 4 }                       // expected: "abc…"  (default ellipsis "…")
{ "kind": "primitive", "op": "truncate_ellipsis", "text": "abcdef", "width": 4, "ellipsis": "..." }    // expected: "a..."
{ "kind": "primitive", "op": "truncate_middle",   "text": "abcdefgh", "width": 5 }                     // expected: "ab…gh"
```

For `primitive` cases `expected` is a single string, not an array of lines.
