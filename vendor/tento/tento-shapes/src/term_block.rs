//! `term.block/v1`: a harness-neutral styled terminal block.
//!
//! Components produce this value from Lisp. This module deliberately knows
//! about terminal cells and wrapping, but nothing about Claude, Codex, Grok,
//! or any other harness.
//!
//! ## Animated spans
//!
//! A span may carry an `anim` object — the generic animation vocabulary (see
//! [`crate::anim`]). The renderer validates it, **pre-paints every frame to a
//! finished ANSI string**, and reports the exact byte range the static text
//! occupies in the rendered row as an [`AnimPatch`]. A host then swaps frames
//! with a byte splice; it never re-evaluates the component.
//!
//! Three authoring modes fall out of one mechanism:
//!
//! ```jsonc
//! // fixed-width text frames (a glyph spinner, a verb rotation)
//! {"text": "✳", "fg": "#cd694a",
//!  "anim": {"key": "…/glyph", "interval_ms": 110, "active": true,
//!           "reduced_frame": 2,
//!           "frames": [{"text": "·"}, {"text": "✢"}, {"text": "✳"}]}}
//!
//! // same-text palette wave (the text never moves; the color travels)
//! {"text": "···",
//!  "anim": {"key": "…/shimmer", "interval_ms": 2800, "active": true,
//!           "frames": [{"parts": [{"text": "·", "fg": "#e8a68f"},
//!                                 {"text": "·", "fg": "#cd694a"},
//!                                 {"text": "·", "fg": "#8a4632"}]}]}}
//!
//! // a native m/s duration readout in one fixed field, padded AFTER its
//! // static suffix so the visible text stays contiguous
//! // {"text": "5m 5s · ↓ 13.9k tokens)  ",
//! //  "anim": {"key": "…/elapsed", "interval_ms": 1000, "active": true,
//! //           "counter": {"from": 305, "style": "duration",
//! //                       "suffix": " · ↓ 13.9k tokens)"}}}
//!
//! // a fixed-width monotonic counter (elapsed seconds)
//! {"text": "  0s",
//!  "anim": {"key": "…/elapsed", "interval_ms": 1000, "active": true,
//!           "counter": {"from": 0, "pad": 3, "unit": "s"}}}
//! ```
//!
//! Invariants the renderer enforces, degrading to the plain static text (never
//! a broken row) when any is violated:
//!
//! * every frame paints exactly as many cells as the span's own `text`
//!   ([`validate_frame_widths`]), so a frame swap can't reflow a row;
//! * the animated span lands **contiguously on one output line** — an animated
//!   span that word-wrapped or was clipped emits no patch;
//! * only `spans` animate; a `right`-column span's `anim` is ignored (the
//!   right column is placed by a measured gap, so its byte offsets are not a
//!   stable splice target).
//!
//! `active` is authored by the component from its truthful context — an
//! inactive animation renders its static text and produces no patch, so a
//! finished turn costs nothing.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Map, Value};
use tento_tui_core::input::{Event, KeyCode};
use unicode_segmentation::UnicodeSegmentation;

use crate::anim::{AnimCounter, AnimKind, AnimPatch, MIN_INTERVAL_MS, validate_frame_widths};
use crate::registry::{
  RenderCtx, RowAttrs, ShapeOutput, ShapeRegistry, ShapeWidget, WidgetAction, WidgetEvent,
};
use tento_term::{SpanStyle, paint_with_color, style_sgr};

pub const TERM_BLOCK_V1: &str = "term.block/v1";

/// The row attr that declares a row an **expand/collapse toggle**:
/// `:attrs (list (list "toggle" KEY))`. Enter on that row flips
/// `{"expanded": …}` in the row's host-held view state, which comes back to
/// the component as its render state (`context.state`).
///
/// The mechanism reads only the attr's PRESENCE. `KEY` is the component's own
/// state key (conventionally the row's own path, which is where the host
/// stores the state) and is never interpreted here — what a collapsed row
/// looks like versus an expanded one is entirely component policy.
pub const TOGGLE_ATTR: &str = "toggle";

pub struct TermBlockWidget;

#[derive(Clone, Debug, Default, Deserialize)]
struct Block {
  #[serde(default)]
  padding: Padding,
  #[serde(default)]
  rows: Vec<Row>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Padding {
  top: usize,
  right: usize,
  bottom: usize,
  left: usize,
}

impl<'de> Deserialize<'de> for Padding {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    let values = Vec::<usize>::deserialize(deserializer)?;
    Ok(match values.as_slice() {
      [] => Padding::default(),
      [all] => Padding {
        top: *all,
        right: *all,
        bottom: *all,
        left: *all,
      },
      [vertical, horizontal] => Padding {
        top: *vertical,
        right: *horizontal,
        bottom: *vertical,
        left: *horizontal,
      },
      [top, horizontal, bottom] => Padding {
        top: *top,
        right: *horizontal,
        bottom: *bottom,
        left: *horizontal,
      },
      [top, right, bottom, left, ..] => Padding {
        top: *top,
        right: *right,
        bottom: *bottom,
        left: *left,
      },
    })
  }
}

#[derive(Clone, Debug, Default, Deserialize)]
struct Row {
  #[serde(default)]
  spans: Vec<Span>,
  /// Prefix authored for every physical line after the first. This is the
  /// generic hanging-indent mechanism used by transcript cells; the shape
  /// renderer knows neither the glyph nor how many cells it occupies.
  #[serde(default)]
  continuation: Vec<Span>,
  #[serde(default)]
  right: Vec<Span>,
  #[serde(default)]
  wrap: Wrap,
  #[serde(default)]
  fill: Option<SpanStyle>,
  /// What the gap between `spans` and `right` is drawn WITH. Spaces by
  /// default; one glyph turns the same row into a full-width rule, which is
  /// how a component draws a frame it cannot measure — the width belongs to
  /// the renderer, and a box that guessed one would be the only thing on
  /// screen that does not fit. Must be a single-cell glyph; anything else is
  /// ignored rather than left to smear the line.
  #[serde(default)]
  fill_ch: Option<String>,
  #[serde(default)]
  path: Option<String>,
  #[serde(default)]
  attrs: Vec<(String, String)>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Wrap {
  None,
  #[default]
  Word,
  Exact,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct Span {
  #[serde(default)]
  text: String,
  /// Optional animation over exactly this span's cells.
  #[serde(default)]
  anim: Option<AnimSpec>,
  #[serde(flatten)]
  style: SpanStyle,
}

/// The authored form of a span animation (see the module docs).
#[derive(Clone, Debug, Deserialize)]
struct AnimSpec {
  /// Stable identity. The component composes it from its own stable origin
  /// so the same element keeps its phase across repaints and cache rebuilds.
  key: String,
  #[serde(default = "default_interval_ms")]
  interval_ms: u64,
  /// Hold the span's own static text for this long before the frames begin.
  /// The cells are reserved from the first paint, so a delayed reveal costs
  /// no layout change — only the content arrives late.
  #[serde(default)]
  delay_ms: u64,
  /// Authored from the component's truthful context — an animation only runs
  /// while the thing it describes is genuinely happening.
  #[serde(default)]
  active: bool,
  /// Which frame is the still image under reduced motion.
  #[serde(default)]
  reduced_frame: usize,
  #[serde(default)]
  frames: Vec<AnimFrameSpec>,
  #[serde(default)]
  counter: Option<CounterSpec>,
}

fn default_interval_ms() -> u64 {
  1_000
}

/// One authored frame: either replacement text (inheriting the span's style,
/// with any style field on the frame overriding it) or an explicit list of
/// styled `parts` — which is how a same-text palette wave moves a highlight
/// across the span's own cells.
#[derive(Clone, Debug, Default, Deserialize)]
struct AnimFrameSpec {
  #[serde(default)]
  text: Option<String>,
  #[serde(default)]
  parts: Vec<Span>,
  #[serde(flatten)]
  style: SpanStyle,
}

#[derive(Clone, Debug, Deserialize)]
struct CounterSpec {
  #[serde(default)]
  from: u64,
  #[serde(default = "default_counter_pad")]
  pad: usize,
  #[serde(default)]
  unit: String,
  /// `"duration"` selects the native `m`/`s` readout ([`AnimDuration`]):
  /// left-aligned inside the span's own field, `suffix` painted right after
  /// the digits, padding after the suffix. Unset → the classic fixed-digit
  /// counter.
  #[serde(default)]
  style: Option<String>,
  /// Static tail painted between the duration and the trailing padding
  /// (duration style only).
  #[serde(default)]
  suffix: String,
}

fn default_counter_pad() -> usize {
  3
}

/// A validated, fully pre-painted animation. Built once per render; the host
/// only ever indexes into it.
#[derive(Clone, Debug)]
struct ResolvedAnim {
  key: String,
  interval_ms: u64,
  delay_ms: u64,
  /// The span's own painted text — what the patch shows until `delay_ms`
  /// elapses, byte-identical to what the row already holds.
  base: String,
  reduced_frame: usize,
  /// Cell width every frame paints — equal to the static text's width.
  width: usize,
  kind: AnimKind,
}

/// Paint a standalone list of `term.span` values as one inline ANSI string.
///
/// This is the shared inline half of `term.block/v1`: panes such as the
/// composer can accept the same Lisp-authored span values without inventing a
/// second style vocabulary or asking the block renderer to pad a whole row.
/// `force_color` is appropriate inside an alternate-screen TUI, whose output
/// is known to be a terminal even when process-level tty detection is hidden.
pub fn render_inline_spans(spans: &Value, force_color: bool) -> Result<String, String> {
  let spans: Vec<Span> =
    serde_json::from_value(spans.clone()).map_err(|error| error.to_string())?;
  Ok(render_glyphs_with_color(&flatten(&spans), force_color))
}

#[derive(Clone, Debug)]
struct Glyph {
  text: String,
  width: usize,
  style: SpanStyle,
  whitespace: bool,
  /// Index into the render's [`ResolvedAnim`] table, when this glyph belongs
  /// to an animated span. Also a grouping key, so an animated span is never
  /// merged into an adjacent identically-styled static one.
  anim: Option<usize>,
}

/// Where one animated span's static text landed inside a rendered string.
#[derive(Clone, Copy, Debug)]
struct GlyphHit {
  anim: usize,
  start: usize,
  end: usize,
  width: usize,
}

impl ShapeWidget for TermBlockWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[TERM_BLOCK_V1]
  }

  fn render(
    &self,
    value: &Value,
    width: u16,
    ctx: &RenderCtx,
    _reg: &ShapeRegistry,
  ) -> ShapeOutput {
    let block: Block = match serde_json::from_value(value.clone()) {
      Ok(block) => block,
      Err(error) => {
        return ShapeOutput::diagnostic(format!("  (term.block/v1: {error})"));
      }
    };
    let width = usize::from(width);
    let content_width = width.saturating_sub(block.padding.left + block.padding.right);
    if content_width == 0 {
      return ShapeOutput::diagnostic("  (term.block/v1: padding consumes viewport)");
    }

    let mut lines = Vec::new();
    let mut paths = Vec::new();
    let mut attrs: RowAttrs = Vec::new();
    // The render's animation table plus every place an animated span's static
    // text landed. Patches are emitted only after ALL rows are laid out, so a
    // span that wrapped onto two lines (two hits for one animation) can be
    // detected and dropped.
    let mut table: Vec<ResolvedAnim> = Vec::new();
    let mut hits: Vec<(usize, GlyphHit)> = Vec::new();
    for _ in 0..block.padding.top {
      lines.push(" ".repeat(width));
      paths.push(None);
    }
    for (row_index, row) in block.rows.iter().enumerate() {
      let row_path = row.path.as_ref().map(|path| match ctx.base_path {
        Some(base) if !path.is_empty() => format!("{base}/{path}"),
        Some(base) => base.to_string(),
        None => path.clone(),
      });
      let first_row_line = lines.len();
      let (rendered, row_hits) = render_row(row, content_width, block.padding, &mut table);
      for line in rendered {
        lines.push(line);
        paths.push(row_path.clone());
      }
      for (line_index, hit) in row_hits {
        hits.push((first_row_line + line_index, hit));
      }
      if let Some(path) = row_path {
        if !row.attrs.is_empty() {
          attrs.push((path, row.attrs.clone()));
        }
      } else if !row.attrs.is_empty() {
        attrs.push((format!("row:{row_index}"), row.attrs.clone()));
      }
    }
    for _ in 0..block.padding.bottom {
      lines.push(" ".repeat(width));
      paths.push(None);
    }
    ShapeOutput {
      lines,
      paths,
      attrs,
      anims: patches_from_hits(&table, &hits),
    }
  }

  /// Enter on a row marked [`TOGGLE_ATTR`] flips that row's `expanded` flag.
  ///
  /// The event's `rel_path` is the row `path` the component authored (the
  /// registry strips the host base that [`Self::render`] prepended), so the
  /// match is against the authored vocabulary. Every other path — and every
  /// other key — declines, so navigation, turn-collapse and selection on
  /// non-toggle rows behave exactly as before.
  ///
  /// The returned state MERGES onto the row's prior state rather than
  /// replacing it: `expanded` is one field of a row's view state, not the
  /// whole of it, and a component may keep its own keys alongside.
  fn on_event(
    &self,
    ev: &WidgetEvent,
    value: &Value,
    _reg: &ShapeRegistry,
  ) -> Option<WidgetAction> {
    let Event::Key(key) = ev.event else {
      return None;
    };
    if !matches!(key.code, KeyCode::Enter) {
      return None;
    }
    let block: Block = serde_json::from_value(value.clone()).ok()?;
    let is_toggle = block.rows.iter().any(|row| {
      row.path.as_deref() == Some(ev.rel_path)
        && row.attrs.iter().any(|(name, _)| name == TOGGLE_ATTR)
    });
    if !is_toggle {
      return None;
    }
    let expanded = ev
      .state
      .and_then(|state| state.get("expanded"))
      .and_then(Value::as_bool)
      .unwrap_or(false);
    let mut next = match ev.state {
      Some(Value::Object(map)) => map.clone(),
      _ => Map::new(),
    };
    next.insert("expanded".to_string(), Value::Bool(!expanded));
    Some(WidgetAction::State(Value::Object(next)))
  }
}

/// Turn the per-line hits into [`AnimPatch`]es, keeping only animations whose
/// static text landed **exactly once** and **unclipped**. A wrapped or clipped
/// animated span has no stable splice target, so it degrades to static text
/// rather than risking a torn row.
fn patches_from_hits(table: &[ResolvedAnim], hits: &[(usize, GlyphHit)]) -> Vec<AnimPatch> {
  let mut seen: HashMap<usize, usize> = HashMap::new();
  for (_, hit) in hits {
    *seen.entry(hit.anim).or_insert(0) += 1;
  }
  hits
    .iter()
    .filter(|(_, hit)| seen.get(&hit.anim) == Some(&1))
    .filter_map(|(row, hit)| {
      let anim = table.get(hit.anim)?;
      (hit.width == anim.width).then(|| AnimPatch {
        row: *row,
        start: hit.start,
        end: hit.end,
        key: anim.key.clone(),
        interval_ms: anim.interval_ms,
        delay_ms: anim.delay_ms,
        base: anim.base.clone(),
        reduced_frame: anim.reduced_frame,
        width: anim.width,
        kind: anim.kind.clone(),
      })
    })
    .collect()
}

/// Collect every animation problem in a `term.block/v1` value — the authoring
/// lint behind the equal-width contract. Empty means every animated span in
/// the value is renderable as authored.
pub fn term_block_anim_errors(value: &Value) -> Vec<String> {
  let block: Block = match serde_json::from_value(value.clone()) {
    Ok(block) => block,
    Err(error) => return vec![format!("term.block/v1: {error}")],
  };
  let mut errors = Vec::new();
  for (index, row) in block.rows.iter().enumerate() {
    for span in row.spans.iter().chain(row.right.iter()) {
      if let Err(error) = resolve_anim(span, false) {
        errors.push(format!("row {index}: {error}"));
      }
    }
  }
  errors
}

fn render_row(
  row: &Row,
  content_width: usize,
  padding: Padding,
  table: &mut Vec<ResolvedAnim>,
) -> (Vec<String>, Vec<(usize, GlyphHit)>) {
  let left = flatten_animated(&row.spans, Some(table));
  let continuation = flatten(&row.continuation);
  let continuation_width = glyph_width(&continuation);
  // The right column is placed by a measured gap, so it is not a stable
  // splice target — its spans render statically even if they carry an `anim`.
  let right = flatten(&row.right);
  let mut left_lines = wrap_glyphs_hanging(&left, content_width, row.wrap, continuation_width);
  if left_lines.is_empty() {
    left_lines.push(Vec::new());
  }
  for line in left_lines.iter_mut().skip(1) {
    line.splice(0..0, continuation.iter().cloned());
  }
  let right_width = glyph_width(&right);
  let left_width = glyph_width(&left_lines[0]);

  let right_fits_first = !right.is_empty()
    && left_lines.len() == 1
    && right_width <= content_width
    && left_width + right_width + usize::from(left_width > 0) <= content_width;
  let mut out = Vec::new();
  let mut hits: Vec<(usize, GlyphHit)> = Vec::new();
  // `pad_line` prepends exactly this prefix, so every hit offset recorded
  // against the inner string is already the final byte offset in the row.
  let left_offset = paint_spaces(padding.left, row.fill.as_ref()).len();
  for (index, glyphs) in left_lines.iter().enumerate() {
    let mut line_hits = Vec::new();
    let mut inner = render_glyphs_tracked(glyphs, false, left_offset, &mut line_hits);
    let used = glyph_width(glyphs);
    if index == 0 && right_fits_first {
      let gap = content_width.saturating_sub(used + right_width);
      inner.push_str(&paint_gap(gap, row));
      inner.push_str(&render_glyphs(&right));
    } else {
      inner.push_str(&paint_gap(content_width.saturating_sub(used), row));
    }
    out.push(pad_line(inner, padding, row.fill.as_ref()));
    let line_index = out.len() - 1;
    hits.extend(line_hits.into_iter().map(|hit| (line_index, hit)));
  }
  if !right.is_empty() && !right_fits_first {
    let clipped = clip_glyphs(&right, content_width);
    let gap = content_width.saturating_sub(glyph_width(&clipped));
    let inner = format!("{}{}", paint_gap(gap, row), render_glyphs(&clipped));
    out.push(pad_line(inner, padding, row.fill.as_ref()));
  }
  (out, hits)
}

/// `count` cells of the row's fill: spaces, or its `fill_ch` repeated.
fn paint_gap(count: usize, row: &Row) -> String {
  match row.fill_ch.as_deref().filter(|ch| tento_term::visual_width(ch) == 1) {
    Some(ch) => match row.fill.as_ref() {
      Some(style) => paint(&ch.repeat(count), style),
      None => ch.repeat(count),
    },
    None => paint_spaces(count, row.fill.as_ref()),
  }
}

fn pad_line(inner: String, padding: Padding, fill: Option<&SpanStyle>) -> String {
  format!(
    "{}{}{}",
    paint_spaces(padding.left, fill),
    inner,
    paint_spaces(padding.right, fill)
  )
}

fn flatten(spans: &[Span]) -> Vec<Glyph> {
  flatten_animated(spans, None)
}

/// Flatten spans to glyphs, optionally resolving each span's animation into
/// `table` and tagging that span's glyphs with its index.
///
/// A malformed animation (unequal frame widths, no frames, a counter whose
/// width disagrees with the static text) is DROPPED here: the span renders
/// statically. Broken authoring must never produce a broken row.
fn flatten_animated(spans: &[Span], mut table: Option<&mut Vec<ResolvedAnim>>) -> Vec<Glyph> {
  let mut out = Vec::new();
  for span in spans {
    let anim = match table.as_deref_mut() {
      Some(table) => match resolve_anim(span, false) {
        Ok(Some(resolved)) => {
          table.push(resolved);
          Some(table.len() - 1)
        }
        Ok(None) => None,
        Err(error) => {
          tracing::debug!("term.block/v1: dropping animation ({error})");
          None
        }
      },
      None => None,
    };
    // Span text is data, never terminal control. Components express styling
    // through SpanStyle, and rows express layout structurally; accepting raw
    // ANSI or row-breaking control characters here would let tool output
    // corrupt the alternate-screen grid.
    out.extend(
      safe_span_text(&span.text)
        .graphemes(true)
        .map(|text| Glyph {
          text: text.to_string(),
          width: tento_term::visual_width(text),
          style: span.style.clone(),
          whitespace: text.chars().all(char::is_whitespace),
          anim,
        }),
    );
  }
  out
}

/// Validate and pre-paint one span's animation.
///
/// * `Ok(None)` — the span carries no animation, or the component declared it
///   inactive (a finished turn): render the static text, emit no patch, cost
///   nothing.
/// * `Err(_)` — authored but unrenderable; the caller degrades to static.
fn resolve_anim(span: &Span, force_color: bool) -> Result<Option<ResolvedAnim>, String> {
  let Some(spec) = span.anim.as_ref() else {
    return Ok(None);
  };
  let base_width = tento_term::visual_width(&safe_span_text(&span.text));
  let kind = match (&spec.counter, spec.frames.is_empty()) {
    (Some(counter), _)
      if matches!(
        counter.style.as_deref(),
        Some("duration" | "duration-compact")
      ) =>
    {
      // Native m/s readout: the span's own static text DEFINES the fixed
      // field; the duration + suffix must fit it at the seed, or the
      // animation is rejected and the span stays static.
      let (open, close) = sgr_wrap(&span.style, force_color);
      let duration = crate::anim::AnimDuration {
        from: counter.from,
        suffix: safe_span_text(&counter.suffix),
        width: base_width,
        open,
        close,
        style: if counter.style.as_deref() == Some("duration-compact") {
          crate::anim::DurationStyle::Compact
        } else {
          crate::anim::DurationStyle::Natural
        },
      };
      let seed_text = if counter.style.as_deref() == Some("duration-compact") {
        crate::anim::compact_duration_text(counter.from)
      } else {
        crate::anim::duration_text(counter.from)
      };
      let seed_width =
        tento_term::visual_width(&seed_text) + tento_term::visual_width(&duration.suffix);
      if seed_width > base_width {
        return Err(format!(
          "duration counter `{}` needs {seed_width} cells but the static text reserves {base_width}",
          spec.key
        ));
      }
      AnimKind::Duration(duration)
    }
    (Some(counter), _) => {
      let (open, close) = sgr_wrap(&span.style, force_color);
      let counter = AnimCounter {
        from: counter.from,
        pad: counter.pad,
        unit: safe_span_text(&counter.unit),
        open,
        close,
      };
      validate_frame_widths(base_width, &[counter.width()])?;
      AnimKind::Counter(counter)
    }
    (None, false) => {
      let painted: Vec<(String, usize)> = spec
        .frames
        .iter()
        .map(|frame| paint_frame(span, frame, force_color))
        .collect();
      let widths: Vec<usize> = painted.iter().map(|(_, width)| *width).collect();
      validate_frame_widths(base_width, &widths)?;
      AnimKind::Frames(painted.into_iter().map(|(text, _)| text).collect())
    }
    (None, true) => {
      return Err(format!(
        "animation `{}` declares neither frames nor a counter",
        spec.key
      ));
    }
  };
  if spec.key.trim().is_empty() {
    return Err("animation needs a stable non-empty `key`".to_string());
  }
  if !spec.active {
    return Ok(None);
  }
  Ok(Some(ResolvedAnim {
    key: spec.key.clone(),
    interval_ms: spec.interval_ms.max(MIN_INTERVAL_MS),
    delay_ms: spec.delay_ms,
    // Exactly the bytes `render_glyphs_tracked` writes for this span's own
    // glyph group, so resolving the patch before its delay is a no-op splice.
    base: paint_with_color(&safe_span_text(&span.text), &span.style, force_color),
    reduced_frame: spec.reduced_frame,
    width: base_width,
    kind,
  }))
}

/// Paint one authored frame to its finished ANSI string plus its cell width.
fn paint_frame(span: &Span, frame: &AnimFrameSpec, force_color: bool) -> (String, usize) {
  if !frame.parts.is_empty() {
    // A palette wave: the parts carry their own styles and together must
    // still occupy the span's own cells.
    let glyphs = flatten(&frame.parts);
    return (
      render_glyphs_with_color(&glyphs, force_color),
      glyph_width(&glyphs),
    );
  }
  let text = safe_span_text(frame.text.as_deref().unwrap_or(&span.text));
  let style = merge_style(&span.style, &frame.style);
  let width = tento_term::visual_width(&text);
  (paint_with_color(&text, &style, force_color), width)
}

/// A frame's style layered over its span's: a set field on the frame wins,
/// an unset one inherits. (A frame can add emphasis, not remove it.)
fn merge_style(base: &SpanStyle, over: &SpanStyle) -> SpanStyle {
  SpanStyle {
    fg: over.fg.clone().or_else(|| base.fg.clone()),
    bg: over.bg.clone().or_else(|| base.bg.clone()),
    bold: over.bold || base.bold,
    dim: over.dim || base.dim,
    italic: over.italic || base.italic,
    underline: over.underline || base.underline,
    strike: over.strike || base.strike,
    reverse: over.reverse || base.reverse,
  }
}

/// The SGR opener/closer a styled counter wraps its digits in — empty when the
/// style is default or color is off, matching [`paint_with_color`] exactly so
/// a spliced frame is byte-compatible with the static text it replaces.
fn sgr_wrap(style: &SpanStyle, force_color: bool) -> (String, String) {
  if *style == SpanStyle::default()
    || (!force_color && !colored::control::SHOULD_COLORIZE.should_colorize())
  {
    return (String::new(), String::new());
  }
  (
    format!("\u{1b}[{}m", style_sgr(style).join(";")),
    "\u{1b}[0m".to_string(),
  )
}

pub(crate) fn safe_span_text(text: &str) -> String {
  tento_term::strip_ansi(text)
    .chars()
    .map(|character| {
      if character.is_control() {
        ' '
      } else {
        character
      }
    })
    .collect()
}

fn wrap_glyphs_hanging(
  glyphs: &[Glyph],
  width: usize,
  mode: Wrap,
  continuation_width: usize,
) -> Vec<Vec<Glyph>> {
  if glyphs.is_empty() {
    return Vec::new();
  }
  if matches!(mode, Wrap::None) {
    return vec![clip_glyphs(glyphs, width)];
  }

  let mut lines = Vec::new();
  let mut start = 0;
  while start < glyphs.len() {
    let line_width = if lines.is_empty() {
      width
    } else {
      width.saturating_sub(continuation_width).max(1)
    };
    let mut end = start;
    let mut used = 0;
    let mut last_space = None;
    while end < glyphs.len() {
      let glyph = &glyphs[end];
      if used + glyph.width > line_width && end > start {
        break;
      }
      if glyph.width > line_width && end == start {
        end += 1;
        break;
      }
      used += glyph.width;
      if glyph.whitespace {
        last_space = Some(end);
      }
      end += 1;
      if used >= line_width {
        break;
      }
    }
    let mut next = end;
    if matches!(mode, Wrap::Word) && end < glyphs.len() {
      if let Some(space) = last_space.filter(|space| *space >= start) {
        end = space;
        next = space + 1;
        while next < glyphs.len() && glyphs[next].whitespace {
          next += 1;
        }
      }
    }
    if end == start {
      end = (start + 1).min(glyphs.len());
      next = end;
    }
    lines.push(clip_glyphs(&glyphs[start..end], line_width));
    start = next;
  }
  lines
}

fn clip_glyphs(glyphs: &[Glyph], width: usize) -> Vec<Glyph> {
  let mut out = Vec::new();
  let mut used = 0;
  for glyph in glyphs {
    if used + glyph.width > width {
      break;
    }
    used += glyph.width;
    out.push(glyph.clone());
  }
  out
}

fn glyph_width(glyphs: &[Glyph]) -> usize {
  glyphs.iter().map(|glyph| glyph.width).sum()
}

fn render_glyphs(glyphs: &[Glyph]) -> String {
  render_glyphs_with_color(glyphs, false)
}

fn render_glyphs_with_color(glyphs: &[Glyph], force_color: bool) -> String {
  render_glyphs_tracked(glyphs, force_color, 0, &mut Vec::new())
}

/// Paint `glyphs`, recording where each animated span's cells landed.
///
/// Runs of glyphs are grouped by `(style, anim)`, so an animated span is
/// always its own SGR group — its byte range covers the whole wrapper and can
/// be replaced wholesale. `base` is the byte offset this string will sit at
/// within the finished row, so recorded offsets are final.
fn render_glyphs_tracked(
  glyphs: &[Glyph],
  force_color: bool,
  base: usize,
  hits: &mut Vec<GlyphHit>,
) -> String {
  let mut rendered = String::new();
  let mut index = 0;
  while index < glyphs.len() {
    let style = &glyphs[index].style;
    let anim = glyphs[index].anim;
    let mut text = String::new();
    let mut width = 0;
    while index < glyphs.len() && &glyphs[index].style == style && glyphs[index].anim == anim {
      text.push_str(&glyphs[index].text);
      width += glyphs[index].width;
      index += 1;
    }
    let start = base + rendered.len();
    rendered.push_str(&paint_with_color(&text, style, force_color));
    if let Some(anim) = anim {
      hits.push(GlyphHit {
        anim,
        start,
        end: base + rendered.len(),
        width,
      });
    }
  }
  rendered
}

fn paint_spaces(count: usize, style: Option<&SpanStyle>) -> String {
  let spaces = " ".repeat(count);
  match style {
    Some(style) => paint(&spaces, style),
    None => spaces,
  }
}

fn paint(text: &str, style: &SpanStyle) -> String {
  paint_with_color(text, style, false)
}

#[cfg(test)]
mod tests {
  // Relocated to `tento-term` so the layer below can share it; these cases stay
  // here because they pin how a SPAN renders, not how a colour parses.
  use tento_term::color_sgr;

  use std::collections::{HashMap, HashSet};

  use serde_json::json;

  use super::*;
  use crate::FileSourceResolver;

  fn ctx<'a>(collapsed: &'a HashSet<String>, state: &'a HashMap<String, Value>) -> RenderCtx<'a> {
    RenderCtx {
      base_path: Some("turn:4"),
      collapsed,
      widget_state: state,
      resolver: &FileSourceResolver,
      depth: 0,
    }
  }


  /// `fill_ch` draws the gap between a row's spans and its `right` with a
  /// glyph instead of spaces — which is how a component frames something at
  /// a width it cannot measure. The renderer owns the width; the frame just
  /// arrives at it.
  #[test]
  fn a_rows_gap_can_be_drawn_with_a_glyph_instead_of_spaces() {
    let reg = ShapeRegistry::core();
    let (collapsed, state) = (HashSet::new(), HashMap::new());
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [
        {"spans": [{"text": "╭─ keys "}], "right": [{"text": "╮"}], "fill_ch": "─"},
        {"spans": [{"text": "│ n"}], "right": [{"text": "│"}]},
        {"spans": [{"text": "╰"}], "right": [{"text": "╯"}], "fill_ch": "─"},
      ],
    });
    let out = reg
      .render(&value, 20, &ctx(&collapsed, &state))
      .expect("block renders");
    assert_eq!(out.lines[0], "╭─ keys ───────────╮");
    // The default is still spaces: only the rule asked for a glyph.
    assert_eq!(out.lines[1], "│ n                │");
    assert_eq!(out.lines[2], "╰──────────────────╯");
    for line in &out.lines {
      assert_eq!(tento_term::visual_width(line), 20, "{line:?}");
    }

    // A fill that is not one cell wide is ignored rather than left to smear
    // the line: the row falls back to spaces and still ends where it should.
    let mut wide = value.clone();
    wide["rows"][0]["fill_ch"] = json!("──");
    let out = reg
      .render(&wide, 20, &ctx(&collapsed, &state))
      .expect("block renders");
    assert_eq!(out.lines[0], "╭─ keys            ╮");
  }

  #[test]
  fn renders_padding_wrap_and_right_column() {
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "padding": [0, 1],
      "rows": [{
        "path": "tool:read",
        "attrs": [["kind", "tool"]],
        "spans": [{"text": "Read a long filename", "bold": true}],
        "right": [{"text": "done", "fg": "green"}],
        "wrap": "word"
      }]
    });
    let (collapsed, state) = (HashSet::new(), HashMap::new());
    let out = ShapeRegistry::core()
      .render(&value, 14, &ctx(&collapsed, &state))
      .expect("term block renders");
    assert_eq!(
      out
        .lines
        .iter()
        .map(|line| tento_term::strip_ansi(line))
        .collect::<Vec<_>>(),
      vec![" Read a long  ", " filename     ", "         done "]
    );
    assert!(
      out
        .paths
        .iter()
        .all(|path| path.as_deref() == Some("turn:4/tool:read"))
    );
    assert_eq!(
      out.attrs,
      vec![(
        "turn:4/tool:read".to_string(),
        vec![("kind".to_string(), "tool".to_string())]
      )]
    );
  }

  #[test]
  fn continuation_spans_author_a_hanging_indent() {
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{
        "spans": [{"text": "✔ one two three"}],
        "continuation": [{"text": "  "}],
        "wrap": "word"
      }]
    });
    let (collapsed, state) = (HashSet::new(), HashMap::new());
    let out = ShapeRegistry::core()
      .render(&value, 10, &ctx(&collapsed, &state))
      .expect("term block renders");
    assert_eq!(
      out
        .lines
        .iter()
        .map(|line| tento_term::strip_ansi(line))
        .collect::<Vec<_>>(),
      vec!["✔ one two ", "  three   "]
    );
  }

  #[test]
  fn ansi_palette_supports_named_indexed_and_truecolor() {
    assert_eq!(color_sgr("bright-blue", false).as_deref(), Some("94"));
    assert_eq!(color_sgr("index:238", true).as_deref(), Some("48;5;238"));
    assert_eq!(
      color_sgr("#d97757", false).as_deref(),
      Some("38;2;217;119;87")
    );
    let style = SpanStyle {
      fg: Some("#d97757".into()),
      bg: Some("index:238".into()),
      bold: true,
      italic: true,
      ..SpanStyle::default()
    };
    assert_eq!(style_sgr(&style), ["1", "3", "38;2;217;119;87", "48;5;238"]);
  }

  #[test]
  fn span_text_cannot_inject_terminal_controls_or_rows() {
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{
        "spans": [{
          "text": "safe\nline\r\u{1b}[31mred\u{1b}[0m\u{7}\tend"
        }]
      }]
    });
    let out = ShapeRegistry::core()
      .render(&value, 80, &RenderCtx::cli())
      .expect("term block renders");
    assert_eq!(out.lines.len(), 1);
    assert!(!out.lines[0].contains('\n'));
    assert!(!out.lines[0].contains('\r'));
    assert!(!out.lines[0].contains('\u{7}'));
    assert!(!out.lines[0].contains('\u{1b}'));
    assert!(out.lines[0].starts_with("safe line red  end"));
  }

  #[test]
  fn malformed_values_degrade_without_panicking() {
    let value = json!({"shape": TERM_BLOCK_V1, "padding": "nope"});
    let out = ShapeRegistry::core()
      .render(&value, 80, &RenderCtx::cli())
      .expect("known shape degrades");
    assert!(out.lines[0].contains("term.block/v1"));
  }

  // --- animated spans -------------------------------------------------------

  fn spinner(active: bool) -> serde_json::Value {
    json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{
        "wrap": "none",
        "spans": [
          {"text": "✳", "fg": "#cd694a", "anim": {
            "key": "turn:1/thinking#0/glyph",
            "interval_ms": 110,
            "active": active,
            "reduced_frame": 2,
            "frames": [
              {"text": "·"}, {"text": "✢"}, {"text": "✳"}, {"text": "✶"},
              {"text": "✻"}, {"text": "✽"}, {"text": "✻"}, {"text": "✶"},
              {"text": "✳"}, {"text": "✢"}
            ]
          }},
          {"text": " Thinking… ", "fg": "#cd694a"}
        ]
      }]
    })
  }

  #[test]
  fn an_active_span_yields_one_patch_over_its_own_bytes() {
    let out = ShapeRegistry::core()
      .render(&spinner(true), 40, &RenderCtx::cli())
      .expect("term block renders");
    assert_eq!(out.anims.len(), 1, "one animated span, one patch");
    let patch = &out.anims[0];
    assert_eq!(patch.row, 0);
    assert_eq!(patch.key, "turn:1/thinking#0/glyph");
    assert_eq!(patch.interval_ms, 110);
    assert_eq!(patch.width, 1, "the glyph occupies one cell");
    // The patch's byte range covers exactly the static glyph in the row.
    let slice = &out.lines[patch.row][patch.start..patch.end];
    assert!(slice.contains('✳'), "patch covers the glyph: {slice:?}");
    assert!(
      !slice.contains('T'),
      "patch must not reach into the next span: {slice:?}"
    );
    // Every frame keeps the row's exact cell width — the layout invariant.
    let base_width = tento_term::visual_width(&tento_term::strip_ansi(&out.lines[0]));
    for tick in 0..20u64 {
      let mut line = out.lines[0].clone();
      let text = patch.text_at(tick);
      line.replace_range(patch.start..patch.end, &text);
      assert_eq!(
        tento_term::visual_width(&tento_term::strip_ansi(&line)),
        base_width,
        "frame {tick} changed the row width"
      );
    }
  }

  #[test]
  fn an_inactive_span_renders_static_and_costs_nothing() {
    let out = ShapeRegistry::core()
      .render(&spinner(false), 40, &RenderCtx::cli())
      .expect("term block renders");
    assert!(
      out.anims.is_empty(),
      "a completed element must produce no patches"
    );
    assert!(tento_term::strip_ansi(&out.lines[0]).starts_with("✳ Thinking…"));
  }

  #[test]
  fn unequal_width_frames_are_rejected_and_degrade_to_static() {
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{"spans": [{"text": "✳", "anim": {
        "key": "k", "interval_ms": 110, "active": true,
        "frames": [{"text": "·"}, {"text": "much wider"}]
      }}]}]
    });
    let errors = term_block_anim_errors(&value);
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains("equal-width"), "{errors:?}");
    let out = ShapeRegistry::core()
      .render(&value, 40, &RenderCtx::cli())
      .expect("term block still renders");
    assert!(out.anims.is_empty(), "the bad animation is dropped");
    assert!(tento_term::strip_ansi(&out.lines[0]).starts_with('✳'));
  }

  #[test]
  fn a_same_text_palette_wave_keeps_its_cells_and_moves_only_color() {
    colored::control::set_override(true);
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{"wrap": "none", "spans": [{"text": "···", "fg": "#cd694a", "anim": {
        "key": "turn:1/thinking#0/shimmer",
        "interval_ms": 2800,
        "active": true,
        "frames": [
          {"parts": [{"text": "·", "fg": "#e8a68f"}, {"text": "·", "fg": "#cd694a"},
                     {"text": "·", "fg": "#8a4632"}]},
          {"parts": [{"text": "·", "fg": "#8a4632"}, {"text": "·", "fg": "#e8a68f"},
                     {"text": "·", "fg": "#cd694a"}]}
        ]
      }}]}]
    });
    let out = ShapeRegistry::core()
      .render(&value, 20, &RenderCtx::cli())
      .expect("term block renders");
    colored::control::unset_override();
    let patch = &out.anims[0];
    assert_eq!(patch.width, 3);
    for tick in 0..2u64 {
      let text = patch.text_at(tick);
      assert_eq!(
        tento_term::strip_ansi(&text),
        "···",
        "a palette wave never changes the text"
      );
      assert_eq!(tento_term::visual_width(&tento_term::strip_ansi(&text)), 3);
    }
    assert_ne!(
      patch.text_at(0),
      patch.text_at(1),
      "the color must actually travel"
    );
  }

  #[test]
  fn a_counter_span_animates_at_a_fixed_width() {
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{"wrap": "none", "spans": [{"text": "  0s", "fg": "#7d7d7d", "anim": {
        "key": "turn:1/thinking#0/elapsed",
        "interval_ms": 1000,
        "active": true,
        "counter": {"from": 0, "pad": 3, "unit": "s"}
      }}]}]
    });
    let out = ShapeRegistry::core()
      .render(&value, 20, &RenderCtx::cli())
      .expect("term block renders");
    let patch = &out.anims[0];
    assert_eq!(patch.interval_ms, 1_000);
    assert_eq!(patch.width, 4);
    assert_eq!(tento_term::strip_ansi(&patch.text_at(0)), "  0s");
    assert_eq!(tento_term::strip_ansi(&patch.text_at(12)), " 12s");
  }

  /// A `style: "duration"` counter ticks native m/s text inside the span's own
  /// field: suffix right after the digits, padding after the suffix, and the
  /// span's static text defines (and bounds) the geometry.
  #[test]
  fn a_duration_counter_span_ticks_ms_text_in_the_spans_own_field() {
    // "5m 5s" + " tok)" + 2 reserved cells → a 12-cell field.
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{"wrap": "none", "spans": [{"text": "5m 5s tok)  ", "anim": {
        "key": "turn:1/working#0/elapsed",
        "interval_ms": 1000,
        "active": true,
        "counter": {"from": 305, "style": "duration", "suffix": " tok)"}
      }}]}]
    });
    let out = ShapeRegistry::core()
      .render(&value, 30, &RenderCtx::cli())
      .expect("term block renders");
    let patch = &out.anims[0];
    assert_eq!(patch.width, 12);
    assert_eq!(tento_term::strip_ansi(&patch.text_at(0)), "5m 5s tok)  ");
    assert_eq!(tento_term::strip_ansi(&patch.text_at(55)), "6m 0s tok)  ");
    for tick in 0..2_000 {
      assert_eq!(
        tento_term::visual_width(&tento_term::strip_ansi(&patch.text_at(tick))),
        12
      );
    }

    // A field too small for its own seed is rejected: the span stays static
    // rather than rendering a lying or reflowing readout.
    let broken = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{"wrap": "none", "spans": [{"text": "5m 5s", "anim": {
        "key": "turn:1/working#0/elapsed",
        "interval_ms": 1000,
        "active": true,
        "counter": {"from": 305, "style": "duration", "suffix": " tok)"}
      }}]}]
    });
    let out = ShapeRegistry::core()
      .render(&broken, 30, &RenderCtx::cli())
      .expect("term block renders");
    assert!(out.anims.is_empty(), "undersized duration field must drop");
    let errors = term_block_anim_errors(&broken);
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains("reserves"), "{errors:?}");
  }

  #[test]
  fn a_compact_duration_counter_zero_pads_clock_fields() {
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{"wrap": "none", "spans": [{"text": "59s • stop)         ", "anim": {
        "key": "task/status/elapsed",
        "interval_ms": 1000,
        "active": true,
        "counter": {"from": 59, "style": "duration-compact", "suffix": " • stop)"}
      }}]}]
    });
    let out = ShapeRegistry::core()
      .render(&value, 40, &RenderCtx::cli())
      .expect("term block renders");
    let patch = &out.anims[0];
    assert_eq!(
      tento_term::strip_ansi(&patch.text_at(0)),
      "59s • stop)         "
    );
    assert_eq!(
      tento_term::strip_ansi(&patch.text_at(1)),
      "1m 00s • stop)      "
    );
    assert_eq!(
      tento_term::strip_ansi(&patch.text_at(3_541)),
      // 20 columns, like every other frame: the counter repaints one fixed
      // cell whose width is the static text's, so the widest clock form still
      // pads to it rather than shrinking the cell.
      "1h 00m 00s • stop)  "
    );
  }

  #[test]
  fn an_animated_span_that_wraps_emits_no_patch() {
    // Word-wrapped across two lines there is no single stable splice target,
    // so the renderer degrades to the static text rather than tear a row.
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{"wrap": "word", "spans": [{"text": "aaaa bbbb", "anim": {
        "key": "k", "interval_ms": 100, "active": true,
        "frames": [{"text": "aaaa bbbb"}, {"text": "cccc dddd"}]
      }}]}]
    });
    let out = ShapeRegistry::core()
      .render(&value, 6, &RenderCtx::cli())
      .expect("term block renders");
    assert!(out.lines.len() > 1, "the span really wrapped");
    assert!(out.anims.is_empty(), "wrapped spans emit no patch");
  }

  #[test]
  fn a_right_column_span_never_animates() {
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{
        "spans": [{"text": "left"}],
        "right": [{"text": "R", "anim": {
          "key": "k", "interval_ms": 100, "active": true,
          "frames": [{"text": "R"}, {"text": "S"}]
        }}]
      }]
    });
    let out = ShapeRegistry::core()
      .render(&value, 40, &RenderCtx::cli())
      .expect("term block renders");
    assert!(out.anims.is_empty());
    assert!(tento_term::strip_ansi(&out.lines[0]).ends_with('R'));
  }

  #[test]
  fn a_keyless_or_empty_animation_is_reported_not_rendered() {
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{"spans": [{"text": "x", "anim": {"key": "k", "active": true}}]}]
    });
    let errors = term_block_anim_errors(&value);
    assert!(
      errors[0].contains("neither frames nor a counter"),
      "{errors:?}"
    );
    let value = json!({
      "shape": TERM_BLOCK_V1,
      "rows": [{"spans": [{"text": "x", "anim": {
        "key": "  ", "active": true, "frames": [{"text": "y"}]
      }}]}]
    });
    assert!(
      term_block_anim_errors(&value)[0].contains("stable non-empty"),
      "a keyless animation has no identity to resume from"
    );
  }

  // --- expand / collapse toggles -------------------------------------------

  fn toggle_block() -> Value {
    json!({
      "shape": TERM_BLOCK_V1,
      "rows": [
        {
          "spans": [{"text": "▶ Read src/main.rs"}],
          "path": "tool:abc",
          "attrs": [["toggle", "tool:abc"], ["kind", "tool"]]
        },
        {"spans": [{"text": "  └ 42 lines"}], "path": "note"}
      ]
    })
  }

  fn key(code: KeyCode) -> Event {
    Event::Key(tento_tui_core::input::Key {
      code,
      mods: tento_tui_core::input::Mods::default(),
    })
  }

  /// Enter on a `toggle` row flips `expanded`; pressing it again flips back.
  /// The state MERGES, so a row keeping other view-state keys doesn't lose
  /// them to a toggle.
  #[test]
  fn enter_on_a_toggle_row_flips_expanded_and_back() {
    let reg = ShapeRegistry::core();
    let value = toggle_block();

    let Some(WidgetAction::State(expanded)) = reg.on_event(
      &value,
      "turn:4",
      "turn:4/tool:abc",
      &key(KeyCode::Enter),
      None,
    ) else {
      panic!("Enter on a toggle row claims the key");
    };
    assert_eq!(expanded, json!({"expanded": true}));

    let Some(WidgetAction::State(collapsed)) = reg.on_event(
      &value,
      "turn:4",
      "turn:4/tool:abc",
      &key(KeyCode::Enter),
      Some(&expanded),
    ) else {
      panic!("a second Enter claims the key too");
    };
    assert_eq!(collapsed, json!({"expanded": false}));

    let Some(WidgetAction::State(merged)) = reg.on_event(
      &value,
      "turn:4",
      "turn:4/tool:abc",
      &key(KeyCode::Enter),
      Some(&json!({"cursor": 2})),
    ) else {
      panic!("Enter claims the key over foreign state");
    };
    assert_eq!(merged, json!({"cursor": 2, "expanded": true}));
  }

  /// Everything else defers to the host: an unmarked row, an unknown path,
  /// and any key that isn't Enter keep the pane's own navigation/collapse.
  #[test]
  fn rows_without_the_toggle_attr_defer_to_the_host() {
    let reg = ShapeRegistry::core();
    let value = toggle_block();
    for (base, path, code) in [
      ("turn:4", "turn:4/note", KeyCode::Enter),
      ("turn:4", "turn:4/absent", KeyCode::Enter),
      ("turn:4", "turn:4", KeyCode::Enter),
      ("turn:4", "turn:4/tool:abc", KeyCode::Right),
      ("turn:4", "turn:4/tool:abc", KeyCode::Char(' ')),
    ] {
      assert!(
        reg.on_event(&value, base, path, &key(code), None).is_none(),
        "{path} + {code:?} must fall through to the host"
      );
    }
  }

  /// The toggle attr rides the normal row-attr channel, so a host that only
  /// reads attrs (the selection sink) sees it without knowing the mechanism.
  #[test]
  fn a_toggle_row_still_publishes_its_attrs() {
    let (collapsed, state) = (HashSet::new(), HashMap::new());
    let out = ShapeRegistry::core()
      .render(&toggle_block(), 40, &ctx(&collapsed, &state))
      .expect("term block renders");
    assert_eq!(
      out.attrs,
      vec![(
        "turn:4/tool:abc".to_string(),
        vec![
          ("toggle".to_string(), "tool:abc".to_string()),
          ("kind".to_string(), "tool".to_string())
        ]
      )]
    );
  }
}
