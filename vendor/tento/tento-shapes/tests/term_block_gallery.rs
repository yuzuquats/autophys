//! A rendered gallery of `term.block/v1`, for reviewing the widget by eye.
//!
//! Filed on review: this shape "needs a kind of unicode/ascii storybook so we
//! can review this visually".
//!
//! A web component gets a storybook card. A terminal renderer cannot, and
//! screenshotting one would be reviewing a font rather than a layout. What it
//! HAS is a medium that is already text: the widget's output is a grid of
//! cells, so the honest storybook is that grid, drawn between rulers and
//! committed. `term_block_gallery.txt` is regenerated from this file and
//! compared on every run, which makes it two things at once — a golden test
//! that fails when the layout moves, and a page a reviewer reads in the diff
//! to see what moved and whether they like it.
//!
//! ## Why these panels
//!
//! The panels are not a tour of the API. Each one is a case where a
//! cell-counting layout is known to go wrong, and the gallery exists so those
//! failures are visible rather than merely absent from a passing assertion.
//!
//! The widget measures in GRAPHEMES and lays out in CELLS, and those are three
//! different numbers for the same string — a family emoji is one grapheme,
//! several code points, and two cells wide. So the unicode panels are the
//! substance of the request, not decoration:
//!
//!   - CJK text is two cells per grapheme, so a wrap boundary can fall in the
//!     MIDDLE of a character. A renderer that counts characters splits it and
//!     every following row is off by one column.
//!   - A combining mark (`e` + U+0301) is two code points, one grapheme, one
//!     cell. Counting code points reserves a cell that is never drawn and the
//!     right column drifts left.
//!   - A ZWJ sequence is one grapheme built from several emoji joined by
//!     U+200D. Segmenting it wrongly splits a family into four people.
//!   - Box-drawing characters are single-width but visually continuous, so a
//!     wrap inside one is invisible in a passing test and obvious here.
//!
//! ASCII panels are here for a different reason: they are the cases a reader
//! can verify with a ruler and no unicode knowledge at all, which makes them
//! the anchor for believing the rest of the page.
//!
//! ## Reading a panel
//!
//! Every panel states its viewport width, then draws the block inside a frame
//! whose inner width IS that viewport. ANSI is stripped, so the frame is
//! honest about cells: if a line's content does not reach the right edge, the
//! widget did not pad it, and if it overshoots, the widget overflowed. A `·`
//! marks a space the widget PAINTED (padding, fill, alignment) as opposed to
//! one that is merely absent, because the two are indistinguishable on a page
//! and are very different bugs.
//!
//! To update after an intentional change:
//!
//! ```text
//! TERM_BLOCK_GALLERY=overwrite cargo test -p tento-shapes --test term_block_gallery
//! ```
//!
//! and then READ the diff — that is the review.

use std::path::PathBuf;

use serde_json::{Value, json};
use tento_shapes::{RenderCtx, ShapeRegistry, TERM_BLOCK_V1};

const SHAPE: &str = TERM_BLOCK_V1;

/// One panel: a title, the viewport it is rendered into, and the value.
struct Panel {
  title: &'static str,
  width: u16,
  value: Value,
}

fn panels() -> Vec<Panel> {
  vec![
    Panel {
      title: "ascii · word wrap, and a right column that fits",
      width: 24,
      value: json!({
        "shape": SHAPE,
        "padding": [0, 1],
        "rows": [{
          "spans": [{"text": "Read a long filename", "bold": true}],
          "right": [{"text": "done", "fg": "green"}],
          "wrap": "word"
        }]
      }),
    },
    Panel {
      title: "ascii · a right column too wide to share the line",
      width: 14,
      value: json!({
        "shape": SHAPE,
        "padding": [0, 1],
        "rows": [{
          "spans": [{"text": "Read a long filename"}],
          "right": [{"text": "exit 1 (128s)", "fg": "red"}],
          "wrap": "word"
        }]
      }),
    },
    Panel {
      title: "ascii · the three wrap modes on one string",
      width: 18,
      value: json!({
        "shape": SHAPE,
        "rows": [
          {"spans": [{"text": "none:  antidisestablishmentarian"}], "wrap": "none"},
          {"spans": [{"text": "word:  antidisestablishmentarian"}], "wrap": "word"},
          {"spans": [{"text": "exact: antidisestablishmentarian"}], "wrap": "exact"}
        ]
      }),
    },
    Panel {
      title: "ascii · padding on all four edges, and a painted fill",
      width: 20,
      value: json!({
        "shape": SHAPE,
        "padding": [1, 2, 1, 3],
        "rows": [{
          "spans": [{"text": "cargo build"}],
          "right": [{"text": "ok"}],
          "fill": {"bg": "index:238"},
          "wrap": "word"
        }]
      }),
    },
    Panel {
      title: "unicode · CJK is two cells per grapheme, so wraps land between",
      width: 13,
      value: json!({
        "shape": SHAPE,
        "padding": [0, 1],
        "rows": [
          {"spans": [{"text": "端末のブロックを描画する"}], "wrap": "exact"},
          {"spans": [{"text": "端末 mixed 幅"}], "right": [{"text": "ok"}], "wrap": "word"}
        ]
      }),
    },
    Panel {
      title: "unicode · combining marks are one cell, not two code points",
      width: 20,
      value: json!({
        "shape": SHAPE,
        "rows": [
          {"spans": [{"text": "cafe\u{301} re\u{301}sume\u{301}"}], "right": [{"text": "1x"}]},
          {"spans": [{"text": "café résumé"}], "right": [{"text": "1x"}]}
        ]
      }),
    },
    Panel {
      title: "unicode · a ZWJ sequence is ONE grapheme and must not split",
      width: 12,
      value: json!({
        "shape": SHAPE,
        "rows": [
          {"spans": [{"text": "👩‍👩‍👧‍👦 family"}], "wrap": "exact"},
          {"spans": [{"text": "🇯🇵 flag 🏳️‍🌈"}], "wrap": "exact"}
        ]
      }),
    },
    Panel {
      title: "unicode · box drawing stays continuous across a row",
      width: 16,
      value: json!({
        "shape": SHAPE,
        "rows": [
          {"spans": [{"text": "┌──────────┐"}], "wrap": "none"},
          {"spans": [{"text": "│ ▏▎▍▌▋▊▉█ │"}], "wrap": "none"},
          {"spans": [{"text": "└──────────┘"}], "wrap": "none"}
        ]
      }),
    },
    Panel {
      title: "degrades · a viewport its own padding cannot fit",
      width: 4,
      value: json!({
        "shape": SHAPE,
        "padding": [0, 4],
        "rows": [{"spans": [{"text": "squeezed"}]}]
      }),
    },
  ]
}

/// The frame around a panel. The inner width is the viewport, so the right
/// edge is where the terminal's is.
fn render_panel(panel: &Panel) -> String {
  let out = ShapeRegistry::core()
    .render(&panel.value, panel.width, &RenderCtx::cli())
    .expect("term.block/v1 is a known shape");

  let width = usize::from(panel.width);
  let mut page = String::new();
  page.push_str(&format!("── {} ── width {}\n", panel.title, panel.width));

  // A ruler in tens and units, so a reader can count to a wrap boundary
  // without trusting the frame.
  let tens: String = (0..width)
    .map(|i| {
      if (i + 1) % 10 == 0 {
        char::from_digit(((i + 1) / 10 % 10) as u32, 10).unwrap()
      } else {
        ' '
      }
    })
    .collect();
  let units: String = (0..width)
    .map(|i| char::from_digit(((i + 1) % 10) as u32, 10).unwrap())
    .collect();
  page.push_str(&format!("     {tens}\n"));
  page.push_str(&format!("     {units}\n"));
  page.push_str(&format!("   ┌{}┐\n", "─".repeat(width)));
  for (index, line) in out.lines.iter().enumerate() {
    // Painted spaces become `·`. A space the widget wrote and a space that
    // is simply the end of the line look identical on a page and are very
    // different bugs, so the gallery distinguishes them.
    let stripped = tento_term::strip_ansi(line);
    let shown: String = stripped.replace(' ', "·");
    page.push_str(&format!("{:>3}│{}│\n", index + 1, shown));
  }
  page.push_str(&format!("   └{}┘\n", "─".repeat(width)));
  page
}

fn gallery() -> String {
  let mut page = String::new();
  page.push_str(
    "term.block/v1 — rendered gallery\n\
     ================================\n\
     \n\
     Generated by tests/term_block_gallery.rs; regenerate with\n\
     TERM_BLOCK_GALLERY=overwrite. Each panel is the widget's own output with\n\
     ANSI stripped, framed at its viewport width. A `·` is a space the widget\n\
     PAINTED; a bare gap is a line that simply ended. The frame's right edge is\n\
     the terminal's, so content touching it is content that filled the row.\n\
     \n",
  );
  for panel in panels() {
    page.push('\n');
    page.push_str(&render_panel(&panel));
  }
  page
}

fn golden_path() -> PathBuf {
  PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/term_block_gallery.txt")
}

#[test]
fn gallery_matches_the_committed_page() {
  let rendered = gallery();
  let path = golden_path();

  if std::env::var("TERM_BLOCK_GALLERY").as_deref() == Ok("overwrite") {
    std::fs::write(&path, &rendered).expect("write the gallery");
    return;
  }

  let committed = std::fs::read_to_string(&path).unwrap_or_else(|error| {
    panic!(
      "{}: {error}\nrun TERM_BLOCK_GALLERY=overwrite cargo test -p tento-shapes \
       --test term_block_gallery to create it",
      path.display()
    )
  });

  if committed != rendered {
    // The failure IS the review: print both so the change is legible in CI
    // output without opening a file.
    panic!(
      "the rendered gallery no longer matches the committed page.\n\n\
       --- committed ---\n{committed}\n--- rendered ---\n{rendered}\n\
       If the change is intended, regenerate with TERM_BLOCK_GALLERY=overwrite \
       and review the diff."
    );
  }
}
