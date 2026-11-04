//! Markdown → `term.block/v1` rows, for streamed agent replies.
//!
//! Models reply in markdown; painting it raw (pipes, `**`, fences) reads as
//! noise. This renderer lowers the constructs models actually emit —
//! paragraphs, headings, lists, fenced code, tables, rules, blockquotes,
//! inline bold/italic/code/strikethrough/links — into structured span rows a
//! Lisp component splices into its own block. Styling is caller policy (a
//! [`MarkdownTheme`]); structure is this module's mechanism. An unset theme
//! color means "the terminal's default", never an invented palette.
//!
//! Layout is width-aware here, not deferred to the block's word wrap: list
//! continuation lines need their hanging indent, code must never reflow, and
//! table columns align only if this module owns the measurement. Every
//! emitted row is therefore `wrap: "none"`, pre-wrapped to the width the
//! caller is actually painting at — a component re-renders per paint with the
//! true width, so a resized pane lays out correctly on its next frame.
//!
//! Streaming: the caller re-renders the WHOLE accumulated text on every
//! rebuild, so an unclosed fence/table mid-stream just renders however
//! pulldown parses the partial input and heals on the next chunk.

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use serde::Deserialize;
use serde_json::{Map, Value};
use tento_term::visual_width;

use crate::style::SpanStyle;

/// Observer-side style policy. Every field is optional; `None` paints the
/// terminal's default color for that role.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct MarkdownTheme {
  /// Body text.
  pub text: Option<String>,
  /// Secondary chrome: rules, blockquote bars, clipped-table ellipses.
  pub muted: Option<String>,
  /// Inline code and fenced code lines.
  pub code: Option<String>,
  /// Optional fill behind fenced code lines.
  pub code_bg: Option<String>,
  /// Heading text (falls back to `text`).
  pub heading: Option<String>,
  /// Link text (always underlined).
  pub link: Option<String>,
  /// Whether a link's destination is appended after its text — `the docs
  /// (https://…)`. `None` (the default) keeps it, so every existing caller
  /// renders exactly as before.
  ///
  /// This is policy, not mechanism, so it rides the theme: a wide reader wants
  /// the URL because link text is not clickable in a terminal, while a narrow
  /// trace pane wants prose rhythm and would rather lose it. Both are correct
  /// for their surface, and a preset picks — no renderer knows which.
  pub link_url: Option<bool>,
  /// Render the whole document subordinate — every span dimmed.
  ///
  /// Document-level, not span-level: "this block is a thought, not the answer"
  /// is a property of the block, so it belongs to the theme rather than to any
  /// one run. Applied as a post-pass, which is also why it is byte-cheap: the
  /// row painter groups adjacent glyphs by identical style, so a uniformly
  /// dimmed row collapses to ONE SGR group instead of one per span.
  pub dim: Option<bool>,
}

/// Active inline styling while accumulating a paragraph.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Inline {
  bold: bool,
  italic: bool,
  strike: bool,
  code: bool,
  link: bool,
  muted: bool,
}

/// One styled run of text inside a paragraph, heading, or table cell.
type Seg = (String, Inline);

/// Render `md` into `term.block/v1` row values, pre-wrapped to `width`.
pub fn markdown_rows(md: &str, width: usize, theme: &MarkdownTheme) -> Vec<Value> {
  let mut rows = markdown_rows_inner(
    md,
    width,
    theme,
    None::<fn(&str, &str) -> Option<Vec<Vec<Value>>>>,
  );
  apply_document_dim(&mut rows, theme);
  rows
}

/// Apply [`MarkdownTheme::dim`] to every span the document produced.
///
/// Every span, in every slot a row can paint from — `spans`, the hanging
/// `continuation` prefix, and a `right` column — so a dimmed document has no
/// bright seam where a line wraps.
fn apply_document_dim(rows: &mut [Value], theme: &MarkdownTheme) {
  if theme.dim != Some(true) {
    return;
  }
  for row in rows.iter_mut() {
    for key in ["spans", "continuation", "right"] {
      let Some(Value::Array(spans)) = row.get_mut(key) else {
        continue;
      };
      for span in spans.iter_mut() {
        if let Some(map) = span.as_object_mut() {
          map.insert("dim".to_string(), Value::Bool(true));
        }
      }
    }
  }
}

/// Render Markdown while allowing the caller to color fenced code. The
/// callback receives the fence info string and the complete, unmodified code
/// body and returns one span list per source line. Returning `None` preserves
/// the ordinary flat code rendering. This keeps Markdown layout generic while
/// language detection, parsing, and palette remain owned by the caller.
pub fn markdown_rows_with_highlighter<F>(
  md: &str,
  width: usize,
  theme: &MarkdownTheme,
  highlighter: F,
) -> Vec<Value>
where
  F: FnMut(&str, &str) -> Option<Vec<Vec<Value>>>,
{
  let mut rows = markdown_rows_inner(md, width, theme, Some(highlighter));
  apply_document_dim(&mut rows, theme);
  rows
}

fn markdown_rows_inner<F>(
  md: &str,
  width: usize,
  theme: &MarkdownTheme,
  highlighter: Option<F>,
) -> Vec<Value>
where
  F: FnMut(&str, &str) -> Option<Vec<Vec<Value>>>,
{
  let width = width.max(8);
  let mut options = Options::empty();
  options.insert(Options::ENABLE_TABLES);
  options.insert(Options::ENABLE_STRIKETHROUGH);

  let mut out: Vec<Value> = Vec::new();
  let mut state = State::new(width, theme, highlighter);
  for event in Parser::new_ext(md, options) {
    state.event(event, &mut out);
  }
  // A streaming reply commonly ends in an open fence. pulldown-cmark does not
  // synthesize an End event for it, so flush the buffered body explicitly.
  state.flush_code_block(&mut out);
  state.flush_paragraph(&mut out);
  // Trim leading/trailing blank rows (block separators at the edges).
  while out.first().is_some_and(is_blank_row) {
    out.remove(0);
  }
  while out.last().is_some_and(is_blank_row) {
    out.pop();
  }
  out
}

struct State<'t, F> {
  width: usize,
  theme: &'t MarkdownTheme,
  /// Inline accumulator for the current paragraph/heading/list item.
  segs: Vec<Seg>,
  cur: Inline,
  heading: bool,
  /// Nesting depth while inside list items (indent = 2 per level).
  list_depth: usize,
  /// Ordered-list counters per depth (`None` = bulleted).
  list_numbers: Vec<Option<u64>>,
  /// Inside a code fence: lines pass through verbatim (no word reflow).
  code_block: bool,
  code_info: Option<String>,
  code_buffer: String,
  highlighter: Option<F>,
  blockquote: usize,
  /// Table accumulation: rows of cells; the first row is the header.
  table: Option<Vec<Vec<Vec<Seg>>>>,
  in_table_cell: bool,
  /// The destination of the link currently being accumulated.
  link_dest: Option<String>,
  /// `segs` length when the current link opened — to tell whether the link
  /// text already IS the destination (autolinks stay single).
  link_start: usize,
}

impl<'t, F> State<'t, F>
where
  F: FnMut(&str, &str) -> Option<Vec<Vec<Value>>>,
{
  fn new(width: usize, theme: &'t MarkdownTheme, highlighter: Option<F>) -> Self {
    Self {
      width,
      theme,
      segs: Vec::new(),
      cur: Inline::default(),
      heading: false,
      list_depth: 0,
      list_numbers: Vec::new(),
      code_block: false,
      code_info: None,
      code_buffer: String::new(),
      highlighter,
      blockquote: 0,
      table: None,
      in_table_cell: false,
      link_dest: None,
      link_start: 0,
    }
  }

  fn event(&mut self, event: Event<'_>, out: &mut Vec<Value>) {
    match event {
      Event::Start(tag) => self.start(tag, out),
      Event::End(tag) => self.end(tag, out),
      Event::Text(t) => self.text(&t, out),
      Event::Code(t) => {
        let mut style = self.cur;
        style.code = true;
        self.segs.push((t.to_string(), style));
      }
      Event::SoftBreak => self.segs.push((" ".to_string(), self.cur)),
      Event::HardBreak => self.flush_paragraph(out),
      Event::Rule => {
        self.flush_paragraph(out);
        out.push(row(vec![span(
          &"─".repeat(self.width.min(60)),
          &slot(self.theme.muted.as_deref()),
        )]));
        out.push(blank_row());
      }
      _ => {}
    }
  }

  fn start(&mut self, tag: Tag<'_>, out: &mut Vec<Value>) {
    match tag {
      Tag::Paragraph => {}
      Tag::Heading { .. } => {
        self.flush_paragraph(out);
        self.heading = true;
      }
      Tag::List(start) => {
        self.flush_paragraph(out);
        self.list_depth += 1;
        self.list_numbers.push(start);
      }
      Tag::Item => self.flush_paragraph(out),
      Tag::CodeBlock(kind) => {
        self.flush_paragraph(out);
        self.code_block = true;
        self.code_info = match kind {
          CodeBlockKind::Fenced(info) => Some(info.to_string()),
          CodeBlockKind::Indented => None,
        };
        self.code_buffer.clear();
      }
      Tag::BlockQuote(_) => {
        self.flush_paragraph(out);
        self.blockquote += 1;
      }
      Tag::Table(_) => {
        self.flush_paragraph(out);
        self.table = Some(Vec::new());
      }
      Tag::TableHead | Tag::TableRow => {
        if let Some(rows) = &mut self.table {
          rows.push(Vec::new());
        }
      }
      Tag::TableCell => {
        self.in_table_cell = true;
        self.segs.clear();
      }
      Tag::Strong => self.cur.bold = true,
      Tag::Emphasis => self.cur.italic = true,
      Tag::Strikethrough => self.cur.strike = true,
      Tag::Link { dest_url, .. } => {
        self.cur.link = true;
        self.link_dest = Some(dest_url.to_string());
        self.link_start = self.segs.len();
      }
      _ => {}
    }
  }

  fn end(&mut self, tag: TagEnd, out: &mut Vec<Value>) {
    match tag {
      TagEnd::Paragraph => {
        self.flush_paragraph(out);
        if self.list_depth == 0 {
          out.push(blank_row());
        }
      }
      TagEnd::Heading(_) => {
        self.flush_heading(out);
        self.heading = false;
        out.push(blank_row());
      }
      TagEnd::List(_) => {
        self.flush_paragraph(out);
        self.list_depth = self.list_depth.saturating_sub(1);
        self.list_numbers.pop();
        if self.list_depth == 0 {
          out.push(blank_row());
        }
      }
      TagEnd::Item => self.flush_paragraph(out),
      TagEnd::CodeBlock => {
        self.flush_code_block(out);
        out.push(blank_row());
      }
      TagEnd::BlockQuote(_) => {
        self.flush_paragraph(out);
        self.blockquote = self.blockquote.saturating_sub(1);
        out.push(blank_row());
      }
      TagEnd::Table => {
        if let Some(rows) = self.table.take() {
          self.render_table(&rows, out);
          out.push(blank_row());
        }
      }
      TagEnd::TableCell => {
        let cell = std::mem::take(&mut self.segs);
        if let Some(rows) = &mut self.table {
          if let Some(row) = rows.last_mut() {
            row.push(cell);
          }
        }
        self.in_table_cell = false;
      }
      TagEnd::Strong => self.cur.bold = false,
      TagEnd::Emphasis => self.cur.italic = false,
      TagEnd::Strikethrough => self.cur.strike = false,
      TagEnd::Link => {
        self.cur.link = false;
        if let Some(dest) = self.link_dest.take() {
          // Keep the destination visible unless the text already is it
          // (autolinks); painted muted so prose keeps its rhythm.
          let text: String = self.segs[self.link_start..]
            .iter()
            .map(|(t, _)| t.as_str())
            .collect();
          if text != dest && !dest.is_empty() && self.theme.link_url.unwrap_or(true) {
            let mut style = Inline::default();
            style.muted = true;
            self.segs.push((format!(" ({dest})"), style));
          }
        }
      }
      _ => {}
    }
  }

  fn text(&mut self, t: &str, _out: &mut Vec<Value>) {
    if self.code_block {
      // Buffer the whole fence so syntax parsers see cross-line context. The
      // complete accumulated Markdown is rebuilt on every streaming tick.
      self.code_buffer.push_str(t);
      return;
    }
    self.segs.push((t.to_string(), self.cur));
  }

  fn flush_code_block(&mut self, out: &mut Vec<Value>) {
    if !self.code_block {
      return;
    }
    self.code_block = false;
    let source = std::mem::take(&mut self.code_buffer);
    let source = source.strip_suffix('\n').unwrap_or(&source);
    let highlighted = match (self.code_info.as_deref(), self.highlighter.as_mut()) {
      (Some(info), Some(highlighter)) => highlighter(info, source),
      _ => None,
    };
    let source_lines: Vec<&str> = source.split('\n').collect();
    if let Some(lines) = highlighted {
      if lines.len() == source_lines.len() {
        for spans in lines {
          self.highlighted_code_line(spans, out);
        }
      } else {
        for line in source_lines {
          self.code_line(line, out);
        }
      }
    } else {
      for line in source_lines {
        self.code_line(line, out);
      }
    }
    self.code_info = None;
  }

  fn highlighted_code_line(&self, spans: Vec<Value>, out: &mut Vec<Value>) {
    let inner = self.width.saturating_sub(2).max(4);
    let fill = self.theme.code_bg.as_deref();
    let mut styled = Vec::with_capacity(spans.len());
    for mut span in spans {
      if let Value::Object(map) = &mut span {
        if !map.contains_key("fg") {
          if let Some(code) = self.theme.code.as_deref() {
            map.insert("fg".to_string(), Value::String(code.to_string()));
          }
        }
        if let Some(bg) = fill {
          map.insert("bg".to_string(), Value::String(bg.to_string()));
        }
      }
      styled.push(span);
    }
    for piece in split_span_values(&styled, inner) {
      let mut row_spans = vec![span("  ", &bg_only(fill))];
      row_spans.extend(piece);
      out.push(filled_row(row_spans, fill));
    }
  }

  fn code_line(&self, line: &str, out: &mut Vec<Value>) {
    let inner = self.width.saturating_sub(2).max(4);
    let fill = self.theme.code_bg.as_deref();
    if line.is_empty() {
      out.push(filled_row(vec![span("", &bg_only(fill))], fill));
      return;
    }
    for piece in split_exact(line, inner) {
      out.push(filled_row(
        vec![
          span("  ", &bg_only(fill)),
          span(&piece, &{
            let mut style = slot(self.theme.code.as_deref());
            style.bg = fill.map(str::to_string);
            style
          }),
        ],
        fill,
      ));
    }
  }

  /// Current line prefix as spans: blockquote bars + list indent/bullet.
  fn prefix(&mut self, first_line: bool) -> (Vec<Value>, usize) {
    let mut spans = Vec::new();
    let mut width = 0;
    for _ in 0..self.blockquote {
      spans.push(span("▎ ", &slot(self.theme.muted.as_deref())));
      width += 2;
    }
    if self.list_depth > 0 {
      let indent = "  ".repeat(self.list_depth - 1);
      let marker = if first_line {
        match self.list_numbers.last_mut() {
          Some(Some(n)) => {
            let marker = format!("{n}. ");
            *self.list_numbers.last_mut().expect("checked") = Some(*n + 1);
            marker
          }
          _ => "• ".to_string(),
        }
      } else {
        // Hanging indent under the bullet/number.
        "  ".to_string()
      };
      let lead = format!("{indent}{marker}");
      width += visual_width(&lead);
      spans.push(span(&lead, &slot(self.theme.text.as_deref())));
    }
    (spans, width)
  }

  fn flush_paragraph(&mut self, out: &mut Vec<Value>) {
    if self.segs.iter().all(|(t, _)| t.trim().is_empty()) {
      self.segs.clear();
      return;
    }
    let segs = std::mem::take(&mut self.segs);
    let (first_prefix, first_width) = self.prefix(true);
    let (cont_prefix, _) = self.prefix(false);
    let inner = self.width.saturating_sub(first_width).max(8);
    for (i, line) in wrap_segments(&segs, inner).into_iter().enumerate() {
      let prefix = if i == 0 { &first_prefix } else { &cont_prefix };
      let mut spans = prefix.clone();
      for seg in &line {
        spans.push(self.seg_span(seg));
      }
      out.push(row(spans));
    }
  }

  fn flush_heading(&mut self, out: &mut Vec<Value>) {
    if self.segs.iter().all(|(t, _)| t.trim().is_empty()) {
      self.segs.clear();
      return;
    }
    let segs = std::mem::take(&mut self.segs);
    for line in wrap_segments(&segs, self.width) {
      let spans = line
        .iter()
        .map(|(text, style)| {
          let mut style = *style;
          style.bold = true;
          self.seg_span(&(text.clone(), style))
        })
        .collect();
      out.push(row(spans));
    }
  }

  /// Borderless aligned table: per-column max visual width (the widest column
  /// gives way when the total overflows), bold header, muted rule, cells
  /// joined by two spaces.
  fn render_table(&self, rows: &[Vec<Vec<Seg>>], out: &mut Vec<Value>) {
    let Some(first) = rows.first() else { return };
    let cols = first.len().max(1);
    let mut col_w = vec![0usize; cols];
    for row in rows {
      for (i, cell) in row.iter().enumerate().take(cols) {
        col_w[i] = col_w[i].max(segs_width(cell));
      }
    }
    // Cap total width: shrink the widest column until it fits (floor 8).
    let gaps = (cols - 1) * 2;
    loop {
      let total: usize = col_w.iter().sum::<usize>() + gaps;
      if total <= self.width {
        break;
      }
      let Some((widest, w)) = col_w
        .iter()
        .cloned()
        .enumerate()
        .max_by_key(|(_, w)| *w)
        .filter(|(_, w)| *w > 8)
      else {
        break;
      };
      col_w[widest] = w - 1;
    }

    let emit = |cells: &[Vec<Seg>], header: bool, out: &mut Vec<Value>| {
      let mut spans = Vec::new();
      for (i, w) in col_w.iter().enumerate() {
        if i > 0 {
          spans.push(span("  ", &SpanStyle::default()));
        }
        let empty = Vec::new();
        let cell = cells.get(i).unwrap_or(&empty);
        let mut used = 0;
        for (text, style) in clip_segs(cell, *w, self.theme) {
          used += visual_width(&text);
          let mut style = style;
          style.bold = style.bold || header;
          spans.push(self.seg_span(&(text, style)));
        }
        if used < *w {
          spans.push(span(&" ".repeat(w - used), &SpanStyle::default()));
        }
      }
      out.push(row(spans));
    };

    emit(&rows[0], true, out);
    let rule_w = (col_w.iter().sum::<usize>() + gaps).min(self.width);
    out.push(row(vec![span(
      &"─".repeat(rule_w),
      &slot(self.theme.muted.as_deref()),
    )]));
    for row in &rows[1..] {
      emit(row, false, out);
    }
  }

  fn seg_span(&self, (text, style): &Seg) -> Value {
    let heading = self.heading;
    let fg = if style.code {
      self.theme.code.as_deref()
    } else if style.link {
      self.theme.link.as_deref()
    } else if style.muted {
      self.theme.muted.as_deref()
    } else if heading {
      self.theme.heading.as_deref().or(self.theme.text.as_deref())
    } else {
      self.theme.text.as_deref()
    };
    // Structural emphasis belongs to the DOCUMENT — `**bold**` is bold because
    // the author wrote it, not because a theme said so — while the theme
    // contributes colour and any extra attributes. They union; the theme can
    // add emphasis but never take away what the markup asked for.
    let mut out = slot(fg);
    out.bold |= style.bold || heading;
    out.italic |= style.italic;
    out.strike |= style.strike;
    out.underline |= style.link;
    span(text, &out)
  }
}

// ---------------------------------------------------------------------------
// Span-aware word wrap
// ---------------------------------------------------------------------------

/// One wrap token: either a run of spaces or a word. A word that crosses a
/// style boundary (`**bo**ld`) stays ONE token of several styled pieces, so
/// the wrapper can never break inside it.
struct Token {
  pieces: Vec<Seg>,
  width: usize,
  space: bool,
}

fn tokenize(segs: &[Seg]) -> Vec<Token> {
  let mut tokens: Vec<Token> = Vec::new();
  let mut open_word = false;
  for (text, style) in segs {
    for (is_space, run) in split_runs(text) {
      let width = visual_width(&run);
      if is_space {
        tokens.push(Token {
          pieces: vec![(run, *style)],
          width,
          space: true,
        });
        open_word = false;
      } else if open_word {
        let word = tokens.last_mut().expect("open word exists");
        word.pieces.push((run, *style));
        word.width += width;
      } else {
        tokens.push(Token {
          pieces: vec![(run, *style)],
          width,
          space: false,
        });
        open_word = true;
      }
    }
    // A segment boundary inside continuous glyphs continues the same word;
    // only whitespace closes it — `open_word` deliberately survives the loop.
  }
  tokens
}

/// Split text into alternating space/glyph runs, preserving order.
fn split_runs(text: &str) -> Vec<(bool, String)> {
  let mut runs: Vec<(bool, String)> = Vec::new();
  for ch in text.chars() {
    let is_space = ch == ' ';
    match runs.last_mut() {
      Some((space, run)) if *space == is_space => run.push(ch),
      _ => runs.push((is_space, ch.to_string())),
    }
  }
  runs
}

/// Greedy word wrap over styled segments. Lines never start with spaces; a
/// word wider than the whole line hard-splits at character boundaries.
fn wrap_segments(segs: &[Seg], width: usize) -> Vec<Vec<Seg>> {
  let width = width.max(4);
  let mut lines: Vec<Vec<Seg>> = Vec::new();
  let mut line: Vec<Seg> = Vec::new();
  let mut used = 0;

  let mut flush = |line: &mut Vec<Seg>, used: &mut usize| {
    if !line.is_empty() {
      lines.push(std::mem::take(line));
    }
    *used = 0;
  };

  for token in tokenize(segs) {
    if token.space {
      if used > 0 && used + token.width <= width {
        line.extend(token.pieces);
        used += token.width;
      }
      continue;
    }
    if used > 0 && used + token.width > width {
      // Trailing spaces at the break are dropped from the measured line.
      while line
        .last()
        .is_some_and(|(t, _)| t.chars().all(|c| c == ' '))
      {
        line.pop();
      }
      flush(&mut line, &mut used);
    }
    if token.width > width {
      for (text, style) in token.pieces {
        for ch in text.chars() {
          let w = visual_width(&ch.to_string());
          if used + w > width {
            flush(&mut line, &mut used);
          }
          match line.last_mut() {
            Some((t, s)) if *s == style => t.push(ch),
            _ => line.push((ch.to_string(), style)),
          }
          used += w;
        }
      }
      continue;
    }
    line.extend(token.pieces);
    used += token.width;
  }
  while line
    .last()
    .is_some_and(|(t, _)| t.chars().all(|c| c == ' '))
  {
    line.pop();
  }
  flush(&mut line, &mut used);
  lines.into_iter().map(coalesce).collect()
}

/// Merge adjacent same-style runs so one styled phrase is one span.
fn coalesce(line: Vec<Seg>) -> Vec<Seg> {
  let mut out: Vec<Seg> = Vec::new();
  for (text, style) in line {
    match out.last_mut() {
      Some((t, s)) if *s == style => t.push_str(&text),
      _ => out.push((text, style)),
    }
  }
  out
}

/// Character-exact split for verbatim code lines.
fn split_exact(line: &str, width: usize) -> Vec<String> {
  let width = width.max(1);
  let mut out = Vec::new();
  let mut cur = String::new();
  let mut used = 0;
  for ch in line.chars() {
    let w = visual_width(&ch.to_string());
    if used + w > width && !cur.is_empty() {
      out.push(std::mem::take(&mut cur));
      used = 0;
    }
    cur.push(ch);
    used += w;
  }
  if !cur.is_empty() || out.is_empty() {
    out.push(cur);
  }
  out
}

/// Character-exact wrapping for already-styled code spans. Span attributes
/// survive a split; adjacent pieces are intentionally not merged because the
/// parser's token boundaries remain useful to downstream terminal widgets.
fn split_span_values(spans: &[Value], width: usize) -> Vec<Vec<Value>> {
  let width = width.max(1);
  let mut out: Vec<Vec<Value>> = Vec::new();
  let mut line: Vec<Value> = Vec::new();
  let mut used = 0usize;
  for value in spans {
    let Some(text) = value.get("text").and_then(Value::as_str) else {
      continue;
    };
    let mut piece = String::new();
    for ch in text.chars() {
      let cells = visual_width(&ch.to_string());
      if used + cells > width && (!piece.is_empty() || !line.is_empty()) {
        if !piece.is_empty() {
          line.push(span_with_text(value, std::mem::take(&mut piece)));
        }
        out.push(std::mem::take(&mut line));
        used = 0;
      }
      piece.push(ch);
      used += cells;
    }
    if !piece.is_empty() {
      line.push(span_with_text(value, piece));
    }
  }
  if !line.is_empty() || out.is_empty() {
    out.push(line);
  }
  out
}

fn span_with_text(template: &Value, text: String) -> Value {
  let mut value = template.clone();
  if let Value::Object(map) = &mut value {
    map.insert("text".to_string(), Value::String(text));
  }
  value
}

/// Clip a styled cell to `width` cells, ellipsis when it overflows.
fn clip_segs(segs: &[Seg], width: usize, theme: &MarkdownTheme) -> Vec<Seg> {
  if segs_width(segs) <= width {
    return segs.to_vec();
  }
  let budget = width.saturating_sub(1);
  let mut out: Vec<Seg> = Vec::new();
  let mut used = 0;
  'outer: for (text, style) in segs {
    for ch in text.chars() {
      let w = visual_width(&ch.to_string());
      if used + w > budget {
        break 'outer;
      }
      match out.last_mut() {
        Some((t, s)) if s == style => t.push(ch),
        _ => out.push((ch.to_string(), *style)),
      }
      used += w;
    }
  }
  let mut ellipsis = Inline::default();
  ellipsis.muted = true;
  let _ = theme;
  out.push(("…".to_string(), ellipsis));
  out
}

fn segs_width(segs: &[Seg]) -> usize {
  segs.iter().map(|(t, _)| visual_width(t)).sum()
}

// ---------------------------------------------------------------------------
// Row / span JSON constructors (the `term.block/v1` vocabulary)
// ---------------------------------------------------------------------------

/// Resolve a theme slot into a style.
///
/// A slot's value is a STYLE SPEC, not merely a colour: `"muted": "dim"` is
/// sayable where the colour-only path silently dropped it. A bare colour still
/// means a foreground, so every theme written before this keeps its meaning.
fn slot(spec: Option<&str>) -> SpanStyle {
  spec
    .map(crate::style::style_from_tokens)
    .unwrap_or_default()
}

/// A style that only fills a background — the code block's gutter and pad,
/// which carry no text of their own.
fn bg_only(bg: Option<&str>) -> SpanStyle {
  SpanStyle {
    bg: bg.map(str::to_string),
    ..SpanStyle::default()
  }
}

/// A span carrying `style`. Only attributes actually set are written, so a
/// plain-coloured span is still `{"text": …, "fg": …}` and nothing more.
fn span(text: &str, style: &SpanStyle) -> Value {
  let mut map = Map::new();
  map.insert("text".to_string(), Value::String(text.to_string()));
  if let Ok(Value::Object(fields)) = serde_json::to_value(style) {
    map.extend(fields);
  }
  Value::Object(map)
}

fn row(spans: Vec<Value>) -> Value {
  let mut map = Map::new();
  map.insert("spans".to_string(), Value::Array(spans));
  map.insert("wrap".to_string(), Value::String("none".to_string()));
  Value::Object(map)
}

fn filled_row(spans: Vec<Value>, fill_bg: Option<&str>) -> Value {
  let mut value = row(spans);
  if let Some(bg) = fill_bg {
    if let Value::Object(map) = &mut value {
      map.insert("fill".to_string(), serde_json::json!({ "bg": bg }));
    }
  }
  value
}

fn blank_row() -> Value {
  row(vec![span("", &SpanStyle::default())])
}

fn is_blank_row(value: &Value) -> bool {
  let Some(spans) = value.get("spans").and_then(Value::as_array) else {
    return false;
  };
  spans.iter().all(|s| {
    s.get("text")
      .and_then(Value::as_str)
      .unwrap_or("")
      .is_empty()
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn theme() -> MarkdownTheme {
    MarkdownTheme {
      text: None,
      muted: Some("#565f89".to_string()),
      code: Some("#7dcfff".to_string()),
      code_bg: None,
      heading: None,
      link: Some("#7aa2f7".to_string()),
      // Policy knobs stay at their defaults here: these cases pin the
      // renderer's layout, not a surface's presentation choices.
      ..MarkdownTheme::default()
    }
  }

  fn plain_lines(rows: &[Value]) -> Vec<String> {
    rows
      .iter()
      .map(|row| {
        row["spans"]
          .as_array()
          .expect("spans")
          .iter()
          .map(|s| s["text"].as_str().unwrap_or(""))
          .collect::<String>()
      })
      .collect()
  }

  #[test]
  fn paragraphs_word_wrap_without_midword_breaks() {
    let rows = markdown_rows(
      "A write-ahead log prevents crashes from corrupting data structures entirely.",
      30,
      &theme(),
    );
    let lines = plain_lines(&rows);
    assert!(lines.len() > 1, "wrapped: {lines:?}");
    for line in &lines {
      assert!(visual_width(line) <= 30, "line fits: {line:?}");
    }
    assert!(lines.concat().contains("corrupting"));
  }

  #[test]
  fn inline_styles_become_span_attributes() {
    let rows = markdown_rows("This is **important** and `code` here.", 60, &theme());
    let spans = rows[0]["spans"].as_array().expect("spans");
    let important = spans
      .iter()
      .find(|s| s["text"] == "important")
      .expect("bold span survives as its own run");
    assert_eq!(important["bold"], Value::Bool(true));
    let code = spans
      .iter()
      .find(|s| s["text"] == "code")
      .expect("code span");
    assert_eq!(code["fg"], "#7dcfff");
    let joined = plain_lines(&rows).concat();
    assert!(!joined.contains("**"), "markers consumed: {joined:?}");
    assert!(!joined.contains('`'), "backticks consumed: {joined:?}");
  }

  #[test]
  fn a_word_crossing_a_style_boundary_never_splits() {
    // `**bo**ld` is one word of two styled pieces.
    let rows = markdown_rows("xxxxx **bo**ld", 7, &theme());
    let lines = plain_lines(&rows);
    assert!(
      lines.iter().any(|l| l.contains("bold")),
      "word stays whole: {lines:?}"
    );
  }

  #[test]
  fn headings_are_bold_rows_without_markers() {
    let rows = markdown_rows("## How it works\n\nbody text", 60, &theme());
    let heading = rows[0]["spans"].as_array().expect("spans");
    assert!(heading.iter().all(|s| s["bold"] == Value::Bool(true)));
    let joined = plain_lines(&rows).concat();
    assert!(!joined.contains("##"), "hash markers consumed");
    assert!(joined.contains("How it works"));
  }

  #[test]
  fn fences_render_verbatim_and_never_reflow() {
    let rows = markdown_rows("```\nlet x = compute(1, 2);\n```", 60, &theme());
    let lines = plain_lines(&rows);
    assert!(
      lines.iter().any(|l| l.contains("let x = compute(1, 2);")),
      "verbatim: {lines:?}"
    );
    assert!(!lines.concat().contains("```"));
    for row in &rows {
      assert_eq!(row["wrap"], "none");
    }
  }

  #[test]
  fn lists_get_bullets_numbers_and_hanging_indent() {
    let rows = markdown_rows(
      "- first item with enough words to wrap onto a continuation line\n- second\n\n1. one\n2. two",
      30,
      &theme(),
    );
    let lines = plain_lines(&rows);
    assert!(lines.iter().any(|l| l.starts_with("• first")));
    assert!(lines.iter().any(|l| l.starts_with("1. one")));
    assert!(lines.iter().any(|l| l.starts_with("2. two")));
    let first = lines
      .iter()
      .position(|l| l.starts_with("• first"))
      .expect("first");
    assert!(
      lines[first + 1].starts_with("  "),
      "continuation hangs under the bullet: {:?}",
      lines[first + 1]
    );
  }

  #[test]
  fn tables_align_columns_without_pipes() {
    let md = "| crash | without | with |\n|---|---|---|\n| early | safe | safe |\n| late | corrupt | redo |";
    let rows = markdown_rows(md, 60, &theme());
    let lines = plain_lines(&rows);
    assert!(
      !lines.iter().any(|l| l.contains('|')),
      "no raw pipes: {lines:?}"
    );
    let early = lines
      .iter()
      .find(|l| l.contains("early"))
      .expect("early row");
    let late = lines.iter().find(|l| l.contains("late")).expect("late row");
    assert_eq!(
      early.find("safe").expect("col"),
      late.find("corrupt").expect("col"),
      "second column aligns: {early:?} vs {late:?}"
    );
    assert!(lines.iter().any(|l| l.contains('─')), "header rule present");
  }

  #[test]
  fn links_underline_and_keep_the_destination() {
    let rows = markdown_rows("See [the spec](https://example.com/spec).", 80, &theme());
    let spans = rows[0]["spans"].as_array().expect("spans");
    let link = spans
      .iter()
      .find(|s| s["text"] == "the spec")
      .expect("link text");
    assert_eq!(link["underline"], Value::Bool(true));
    assert_eq!(link["fg"], "#7aa2f7");
    let joined = plain_lines(&rows).concat();
    assert!(joined.contains("(https://example.com/spec)"), "{joined:?}");
  }

  #[test]
  fn unclosed_fence_mid_stream_still_renders() {
    let rows = markdown_rows("before\n\n```rust\nlet x = 1;", 60, &theme());
    let lines = plain_lines(&rows);
    assert!(lines.iter().any(|l| l.contains("let x = 1;")), "{lines:?}");
  }

  #[test]
  fn fenced_code_highlighter_receives_info_and_whole_source() {
    let rows = markdown_rows_with_highlighter(
      "```rust,no_run\nfn main() {\n  let n = 42;\n}\n```",
      60,
      &theme(),
      |info, source| {
        assert_eq!(info, "rust,no_run");
        assert_eq!(source, "fn main() {\n  let n = 42;\n}");
        Some(
          source
            .split('\n')
            .map(|line| vec![serde_json::json!({"text": line, "fg": "#ff0000"})])
            .collect(),
        )
      },
    );
    let lines = plain_lines(&rows);
    assert_eq!(lines, ["  fn main() {", "    let n = 42;", "  }"]);
    assert!(rows.iter().any(|row| {
      row["spans"]
        .as_array()
        .is_some_and(|spans| spans.iter().any(|span| span["fg"] == "#ff0000"))
    }));
  }

  #[test]
  fn unknown_fence_keeps_the_existing_flat_code_style() {
    let rows = markdown_rows_with_highlighter(
      "```cobol\nDISPLAY 'HI'\n```",
      60,
      &theme(),
      |_info, _source| None,
    );
    let code = rows[0]["spans"]
      .as_array()
      .expect("spans")
      .iter()
      .find(|span| span["text"] == "DISPLAY 'HI'")
      .expect("flat code span");
    assert_eq!(code["fg"], "#7dcfff");
  }

  #[test]
  fn highlighted_fences_wrap_without_losing_token_styles() {
    let rows = markdown_rows_with_highlighter(
      "```rust\nabcdefghijklmnop\n```",
      8,
      &theme(),
      |_info, source| {
        Some(vec![vec![serde_json::json!({
          "text": source,
          "fg": "#ff0000",
          "bold": true
        })]])
      },
    );
    assert_eq!(plain_lines(&rows), ["  abcdef", "  ghijkl", "  mnop"]);
    for row in rows {
      let token = row["spans"]
        .as_array()
        .expect("spans")
        .iter()
        .find(|span| !span["text"].as_str().unwrap_or("").trim().is_empty())
        .expect("token span");
      assert_eq!(token["fg"], "#ff0000");
      assert_eq!(token["bold"], true);
    }
  }

  #[test]
  fn unset_theme_paints_no_colors() {
    let rows = markdown_rows("plain **bold** text", 60, &MarkdownTheme::default());
    for row in &rows {
      for span in row["spans"].as_array().expect("spans") {
        assert!(span.get("fg").is_none(), "no invented color: {span:?}");
      }
    }
  }
}
