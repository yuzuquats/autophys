# tento-term

Terminal rendering primitives. ANSI-aware width / pad / truncate, box-drawing
trees that wrap, a responsive table model, and the small algorithmic helpers
(selection arithmetic, scroll-into-view, severity styling) that every
interactive pane shares.

This is the lowest-level rendering crate. Higher layers
(`tento-tui-*`, `tento-sh-tui`, `tento-fleet-console`) compose its
primitives and pull its helpers; it depends on none of them.

## Modules at a glance

| Module | Purpose | Look here when… |
| --- | --- | --- |
| [`width`](../src/width.rs) | `visual_width`, `strip_ansi` | You need the **display** width of a string with ANSI escapes. Don't use `.len()` or `.chars().count()`. |
| [`pad`](../src/pad.rs) | `pad_*`, `truncate_*`, `wrap_to_width`, `wrap_exact` | You're laying out a row at a target column count. `truncate_ellipsis` is ANSI-safe (won't leave dangling escapes). `wrap_to_width` preserves ANSI across line boundaries; `wrap_exact` is the simpler byte-split wrapper. |
| [`ansi`](../src/ansi.rs) | Named escape constants (`RED`, `BOLD`, `DIMMED`, …) | You want to colorize a string without depending on `colored` directly. Most callers go through `Style` instead. |
| [`style`](../src/style.rs) | `Style`, `Cell`, `Overflow` | You're carrying styled text through a renderer. `Cell` = text + Style + alignment + min/max width; `Style` is `Copy`. |
| [`draw`](../src/draw.rs) | `BoxChars`, `rule()`, `panel_*` | You want box-drawing glyphs, horizontal rules, or focused/unfocused panel borders. ASCII fallbacks are first-class (`box_chars_ascii`). |
| [`term`](../src/term.rs) | `term_columns()` | You need the current terminal width. Cheap; safe to call per render. |
| [`tree`](../src/tree/) | `Tree`, `Node`, `TreeColumn`, `RenderedLine`, `ColumnPosition`, `ColumnDivider` | You're rendering a hierarchy with box-drawing edges. Side columns demote into per-row sub-trees when the terminal is narrow. `ColumnPosition::TitleSuffix` joins values onto the label as comma-separated parenthetical groups. |
| [`table`](../src/table.rs) | `Table`, `Column` | You're rendering a width-responsive table. Shrinks columns toward their minimums; demotes lowest-priority columns into a per-row sub-tree when even that isn't enough. |
| [`nav`](../src/nav.rs) | `chevron`, `select_step`/`select_page`, `scroll_into_view`, `highlight_line`, `level_style`, `style_node_key`, `is_open` | You're wiring an interactive pane. Pure functions — the pane owns state and delegates the math. Used by every interactive tree pane in the codebase. |
| [`column_visibility`](../src/column_visibility.rs) | `ColumnVisibility` | Shared toggle model (`ordered` / `hidden` sets) for any column-aware renderer. Mirrors the Lisp `(columns …)` / `(show …)` / `(hide …)` / `(toggle …)` DSL. |
| [`live`](../src/live.rs) * | `watch`, `watch_with` | Single-pane resize-aware viewer (alt-screen, scroll keys, mouse wheel, dimmed footer). See **The `watch` feature** below. |

\* Gated behind the `watch` feature flag (off by default; pulls in `crossterm`).

## Quick examples

### ANSI-safe width and truncation

```rust
use tento_term::{visual_width, truncate_ellipsis};

let styled = "\x1b[1;31mERROR\x1b[0m: connection refused";
assert_eq!(visual_width(styled), 26); // counts visible cells, not bytes

// Clips at 12 cells, appending "…", and closes any open SGR escapes.
let clipped = truncate_ellipsis(styled, 12, "…");
```

### Styled cells in a tree

```rust
use tento_term::{Cell, ColumnPosition, Node, Style, Tree, TreeColumn};

let root = Node::branch("fleet", vec![
  Node::leaf("rwc-01").with_detail(Cell::new("ok",   Style::Green)),
  Node::leaf("rwc-02").with_detail(Cell::new("FAIL", Style::Red)),
]);

// "detail" is the default Inline column; spell out Right placement
// explicitly when you want column-aligned (not packed-after-label) layout.
let tree = Tree::new(root)
  .add_column(TreeColumn::new("detail").position(ColumnPosition::Right));

for line in tree.render_lines(80) {
  println!("{line}");
}
```

`Style` is a flat enum (`Red`, `Green`, `Bold`, `Dimmed`, …) — colors and
emphases aren't composable. For richer styling, pre-paint the text and
wrap it in `Cell::raw(...)` (which renders the bytes verbatim and
measures visible width).

### Selection math in an interactive pane

```rust
use tento_term::nav;

let next = nav::select_step(current, max_index, 1);   // Down
let prev = nav::select_step(current, max_index, -1);  // Up
let pagedown = nav::select_page(current, max_index, viewport_height, true);

// Scroll the window so a node's line range stays in view.
let new_scroll = nav::scroll_into_view(current_scroll, first_line, last_line, viewport_height);
```

### Horizontal rule

```rust
use tento_term::{box_chars, box_chars_ascii, rule, rule_with};

println!("{}", rule(width));                       // ─ across the width (Unicode)
println!("{}", rule_with(&box_chars_ascii(), width)); // - across the width (ASCII fallback)
```

### Force color control

```rust
use tento_term::{force_color, unforce_color};

force_color(true);   // emit ANSI even when output is piped
unforce_color();     // restore terminal auto-detection
```

## The `watch` feature

`live::watch` / `live::watch_with` provide a slim, single-pane
alt-screen viewer: enter alt-screen + raw mode + mouse capture, draw
`render()` once (or every `interval`), let the user scroll with arrow
keys / PgUp/PgDn / Home/End / `g`/`G` / `j`/`k` / mouse wheel, and
quit on Ctrl-C / `q` / `Esc`. A 1-row dimmed footer shows the
keybindings and `lines L–M of N`.

In an earlier era this module also carried a richer command-bar
prompt (`LinePromptUi`, `watch_with_prompt`, `watch_with_ui`,
`Frame`); those surfaces have been retired now that
[`tento-tui`](../../tento-tui/) covers the multi-pane interactive case
better (compositor with a Pane trait, scene DSL, file-watch repaints,
async runtime). The remaining `watch` / `watch_with` exist for the
`loaf.node::releases_cmd` viewer and the resize-aware Table/Tree
demos under `examples/`.

**For new interactive UIs, reach for `tento-tui` first.** `watch_with`
remains as a tiny escape hatch when all you need is "drop a snapshot
on the alt-screen and let the user scroll it"; anything richer (multi-
pane, prompt, file-watch driven repaint) belongs in tento-tui.

**Run the demos:**

```sh
cargo run --example watch_table --features watch
cargo run --example watch_tree  --features watch
```

## Dependency direction

```
tento-term (this crate)
   ↑
tento-logger, tento-core, tento-nodes
   ↑
tento-tui-core, tento-tui-pane, tento-tui-window, tento-tui-panes,
tento-tui-scene, tento-tui-backend-crossterm, tento-tui-data
   ↑
tento-tui, tento-sh-tui, tento-fleet-console
```

tento-term has zero deps on the `tento-tui-*` stack — those crates
build on top. Adding a helper here means every consumer can pick it up
without coupling through the compositor.

## Testing

```sh
cargo test -p tento-term                     # always-on modules
cargo test -p tento-term --features watch    # adds the live module tests
```

Coverage is distributed across the data-model modules (`width`,
`pad`, `style`, `table`, `tree`, `nav`) and a fixture-driven
integration test under `tests/`. The `live` tests are only compiled
when the `watch` feature is on.
