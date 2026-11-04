//! Literal text operations: `str.split`, `str.replace`, `str.join`,
//! `str.chars`, and the position helpers `str.slice` uses.
//!
//! Positions are Unicode scalar indices, the same unit as `length` and
//! `str.find`. Every function treats a `nil` text as the empty string, like the
//! trims, so a missing field threads through a composition without a guard.

use super::*;
use crate::eval::List;

/// Upper bound on a string these functions build. Inputs are already in
/// memory, but `str.replace` multiplies (`n` one-character matches, each
/// replaced by a long string), and a runaway replacement should fail as an
/// error, not exhaust the process. Text data files are a few MB; this leaves
/// an order of magnitude of room.
pub(crate) const OUTPUT_LIMIT: usize = 64 * 1024 * 1024;

pub(crate) fn arity(
  args: &[Value<impl Symbol>],
  range: std::ops::RangeInclusive<usize>,
  usage: &str,
) -> Result<(), RuntimeError> {
  if range.contains(&args.len()) {
    Ok(())
  } else {
    Err(RuntimeError::ArityError {
      detail: usage.to_string(),
    })
  }
}

/// A text argument: a string, or `nil` read as `""`.
pub(crate) fn text_arg<'a, S: Symbol>(
  value: &'a Value<S>,
  name: &str,
) -> Result<&'a str, RuntimeError> {
  match value {
    Value::String(s) => Ok(s),
    Value::Nil => Ok(""),
    other => Err(RuntimeError::TypeError {
      expected: format!("String (in {name})"),
      got: format!("{:?}", other.as_type()),
    }),
  }
}

/// A required string argument (a separator, a pattern): `nil` is refused.
pub(crate) fn string_arg<'a, S: Symbol>(
  value: &'a Value<S>,
  name: &str,
) -> Result<&'a str, RuntimeError> {
  match value {
    Value::String(s) => Ok(s),
    other => Err(RuntimeError::TypeError {
      expected: format!("String (in {name})"),
      got: format!("{:?}", other.as_type()),
    }),
  }
}

/// Elements a list built here may hold: `range`'s memory budget for one list.
/// Splitting 64 MiB of commas would otherwise make 64 million values (about
/// 6 GiB) and abort the process instead of failing as an error.
pub(crate) fn element_limit<S: Symbol>() -> usize {
  super::lists::RANGE_BYTES / std::mem::size_of::<Value<S>>()
}

/// The error for a list past [`element_limit`], in `range`'s wording.
pub(crate) fn too_many<S: Symbol>(name: &str) -> RuntimeError {
  RuntimeError::Other(format!(
    "{name} exceeds the {} element limit ({} MiB of list)",
    element_limit::<S>(),
    super::lists::RANGE_BYTES / (1024 * 1024)
  ))
}

/// `items` as a list of strings, refused as soon as it passes the element
/// limit (`cost` values per item: 1 for a piece, more for a nested list).
pub(crate) fn bounded<S: Symbol>(
  name: &str,
  cost: usize,
  items: impl Iterator<Item = Value<S>>,
) -> Result<Value<S>, RuntimeError> {
  let mut budget = element_limit::<S>();
  let mut list = Vec::new();
  for item in items {
    budget = budget
      .checked_sub(cost.max(1))
      .ok_or_else(|| too_many::<S>(name))?;
    list.push(item);
  }
  Ok(Value::List(List { items: list.into() }))
}

pub(crate) fn strings<'a, S: Symbol>(
  name: &str,
  items: impl Iterator<Item = &'a str>,
) -> Result<Value<S>, RuntimeError> {
  bounded(name, 1, items.map(|s| Value::String(s.into())))
}

pub(crate) fn too_long(name: &str) -> RuntimeError {
  RuntimeError::Other(format!(
    "{name} exceeds the {} MiB output limit",
    OUTPUT_LIMIT / (1024 * 1024)
  ))
}

/// Whether an output of `output` bytes built from `input` bytes is allowed:
/// up to the output limit, or any size that does not grow the input. Every
/// builder checks this before it appends, not after.
pub(crate) fn fits(output: usize, input: usize) -> bool {
  output <= OUTPUT_LIMIT.max(input)
}

/// Byte offsets of the Unicode scalar positions `start..end` in `text`.
/// Positions past the end clamp to the text's length. Precondition:
/// `start <= end`.
///
/// Values are copied on every variable lookup, so a slice cannot remember a
/// string by identity. Instead: an ASCII prefix through `end` maps positions
/// to bytes directly; a short walk past the ASCII prefix is walked; a long
/// non-ASCII text gets a sparse position table (the byte offset of every
/// [`MARK_EVERY`]th character), kept per thread for the last few texts used
/// and found again by content (a length check, then a memcmp). Reading such
/// a text one character at a time therefore costs one table build plus a
/// compare and a short walk per call, the same order as the copy the lookup
/// already made, instead of a decode from the front every time.
///
/// The cache holds a copy of each text, since the copy is the only identity
/// a value has. Texts over [`INDEXED_TEXT_MAX`] are walked instead, and the
/// cache never holds more than [`INDEXED_BUDGET`] bytes.
pub(crate) fn byte_span(text: &str, start: usize, end: usize) -> (usize, usize) {
  // A position past the byte length is past the end, so clamp both here.
  let end = end.min(text.len());
  let start = start.min(end);
  let prefix = &text.as_bytes()[..end];
  if prefix.is_ascii() {
    return (start, end);
  }
  // The first non-ASCII byte: positions before it are byte offsets.
  let ascii = prefix.iter().position(|b| !b.is_ascii()).unwrap_or(end);
  if text.len() < INDEXED_TEXT_BYTES || text.len() > INDEXED_TEXT_MAX || end - ascii <= WALK_CHARS {
    return walk(text, ascii, start, end);
  }
  INDEXED.with(|cache| {
    let mut cache = cache.borrow_mut();
    let entry = match cache.iter().position(|entry| entry.text == text) {
      // Least recently used first: a hit moves to the back.
      Some(at) => cache.remove(at),
      None => Indexed::new(text),
    };
    let span = (entry.byte(start), entry.byte(end));
    let mut held: usize = cache.iter().map(Indexed::bytes).sum();
    while !cache.is_empty()
      && (cache.len() >= INDEXED_TEXTS || held + entry.bytes() > INDEXED_BUDGET)
    {
      held -= cache.remove(0).bytes();
    }
    cache.push(entry);
    span
  })
}

/// [`byte_span`] by decoding forward from `base`, a byte offset inside the
/// ASCII prefix (so also the position of the character there).
/// Precondition: `start <= end`, `base <= end`.
fn walk(text: &str, base: usize, start: usize, end: usize) -> (usize, usize) {
  let mut start_byte = if start < base { start } else { text.len() };
  let mut end_byte = text.len();
  for (position, (byte, _)) in text[base..].char_indices().enumerate() {
    let (position, byte) = (base + position, base + byte);
    if position == start {
      start_byte = byte;
    }
    if position == end {
      end_byte = byte;
      break;
    }
  }
  (start_byte.min(end_byte), end_byte)
}

/// Non-ASCII texts at least this long may get a position table in
/// [`byte_span`]; shorter ones are cheaper to walk.
const INDEXED_TEXT_BYTES: usize = 512;
/// Characters past the ASCII prefix that are walked rather than indexed, so
/// a slice near the start of a long text does not build a table.
const WALK_CHARS: usize = 256;
/// Texts longer than this are walked, not copied into the cache: a 16 MiB
/// text is far past a data file read character by character, and `str.chars`
/// is the linear way to read one that long.
const INDEXED_TEXT_MAX: usize = 16 * 1024 * 1024;
/// Bytes the cache may hold in all (text copies and tables together).
const INDEXED_BUDGET: usize = 32 * 1024 * 1024;
/// Texts whose position tables are kept, so a loop reading two or three
/// strings side by side does not rebuild on every call.
const INDEXED_TEXTS: usize = 4;
/// Characters between two table entries: a lookup walks at most this many
/// less one, and the table costs 4 bytes per this many characters.
const MARK_EVERY: usize = 32;

/// One cached text and its sparse position table.
struct Indexed {
  text: String,
  /// `marks[k]` is the byte offset of character `k * MARK_EVERY`; `u32` is
  /// enough because the text is at most [`INDEXED_TEXT_MAX`] bytes.
  marks: Vec<u32>,
  chars: usize,
}

impl Indexed {
  fn new(text: &str) -> Self {
    let mut marks = Vec::with_capacity(text.len() / MARK_EVERY + 1);
    let mut chars = 0;
    for (position, (byte, _)) in text.char_indices().enumerate() {
      if position % MARK_EVERY == 0 {
        marks.push(byte as u32);
      }
      chars = position + 1;
    }
    Indexed {
      text: text.to_string(),
      marks,
      chars,
    }
  }

  /// Byte offset of `position`, the text's length past the end.
  fn byte(&self, position: usize) -> usize {
    if position >= self.chars {
      return self.text.len();
    }
    let mark = self.marks[position / MARK_EVERY] as usize;
    self.text[mark..]
      .char_indices()
      .nth(position % MARK_EVERY)
      .map_or(self.text.len(), |(byte, _)| mark + byte)
  }

  fn bytes(&self) -> usize {
    self.text.len() + self.marks.len() * std::mem::size_of::<u32>()
  }
}

thread_local! {
  static INDEXED: RefCell<Vec<Indexed>> = const { RefCell::new(Vec::new()) };
}

/// Unicode scalar count, without decoding when the text is ASCII.
pub(crate) fn char_len(text: &str) -> usize {
  if text.is_ascii() {
    text.len()
  } else {
    text.chars().count()
  }
}

/// `(str.split TEXT SEP [LIMIT])` — the pieces of TEXT between occurrences of
/// the literal SEP, in order. Adjacent separators yield empty pieces, and so
/// does a separator at either end, so joining the pieces with SEP restores
/// TEXT exactly. With LIMIT, at most LIMIT pieces are returned and the last
/// holds the unsplit remainder (`(str.split "k=v=w" "=" 2)` → `("k" "v=w")`).
///
/// An empty SEP is refused rather than guessed at: use `str.chars` for
/// characters. Empty or `nil` TEXT yields `("")`, one empty piece, the same
/// answer the identity above requires.
pub fn split<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(
    &args,
    2..=3,
    "str.split takes 2 or 3 args (text, separator, [limit])",
  )?;
  let text = text_arg(&args[0], "str.split")?;
  let sep = string_arg(&args[1], "str.split")?;
  if sep.is_empty() {
    return Err(RuntimeError::Other(
      "str.split: the separator is empty; use str.chars to split into characters".into(),
    ));
  }
  match args.get(2) {
    None => strings("str.split", text.split(sep)),
    Some(Value::Integer(limit)) if *limit > 0 => {
      let limit = usize::try_from(*limit).unwrap_or(usize::MAX);
      strings("str.split", text.splitn(limit, sep))
    }
    Some(Value::Integer(limit)) => Err(RuntimeError::Other(format!(
      "str.split: the limit must be at least 1 (got {limit})"
    ))),
    Some(other) => Err(RuntimeError::TypeError {
      expected: "Integer (in str.split limit)".into(),
      got: format!("{:?}", other.as_type()),
    }),
  }
}

/// `(str.replace TEXT FROM TO)` — every non-overlapping occurrence of the
/// literal FROM, left to right, replaced by TO. Nothing in FROM or TO is a
/// pattern; `str.re-replace` is the regex form. An empty FROM is refused: it
/// matches between every character, which is never what a caller meant.
pub fn replace<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(&args, 3..=3, "str.replace takes 3 args (text, from, to)")?;
  let text = text_arg(&args[0], "str.replace")?;
  let from = string_arg(&args[1], "str.replace")?;
  let to = text_arg(&args[2], "str.replace")?;
  if from.is_empty() {
    return Err(RuntimeError::Other(
      "str.replace: the text to replace is empty".into(),
    ));
  }
  // A replacement no longer than FROM cannot grow the text, so only a
  // longer one needs the count of matches.
  if to.len() > from.len() {
    let growth = (to.len() - from.len()).saturating_mul(text.matches(from).count());
    if !fits(text.len().saturating_add(growth), text.len()) {
      return Err(too_long("str.replace"));
    }
  }
  Ok(Value::String(text.replace(from, to).into()))
}

/// One element of a `str.join` list as text, with `str.concat`'s scalar
/// coercion: strings as-is, numbers and booleans printed. `nil`, lists and
/// maps are refused — a hole in the data should not print as `nil`.
fn scalar_text<S: Symbol>(
  value: &Value<S>,
  index: usize,
) -> Result<std::borrow::Cow<'_, str>, RuntimeError> {
  Ok(match value {
    Value::String(s) => s.as_str().into(),
    Value::Integer(i) => i.to_string().into(),
    Value::Float(f) => f.to_string().into(),
    Value::Boolean(b) => b.to_string().into(),
    other => {
      return Err(RuntimeError::TypeError {
        expected: format!("string, number or boolean (str.join element {index})"),
        got: format!("{:?}", other.as_type()),
      });
    }
  })
}

/// `(str.join LIST [SEP])` — the elements of LIST in order, SEP between each
/// pair (default `""`). Numbers and booleans print as `str.concat` prints
/// them; any other element is an error naming its index. `nil` or an empty
/// list joins to `""`.
pub fn join<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(
    &args,
    1..=2,
    "str.join takes 1 or 2 args (list, [separator])",
  )?;
  let items: &[Value<S>] = match &args[0] {
    Value::List(list) => &list.items,
    Value::Nil => &[],
    other => {
      return Err(RuntimeError::TypeError {
        expected: "List (in str.join)".into(),
        got: format!("{:?}", other.as_type()),
      });
    }
  };
  let sep = match args.get(1) {
    None => "",
    Some(sep) => text_arg(sep, "str.join")?,
  };
  // Measure first, so an oversized join fails before it allocates. The
  // strings already in the list are its input: joining them without a
  // separator never fails, whatever their size.
  let mut total = sep.len().saturating_mul(items.len().saturating_sub(1));
  let mut input = 0usize;
  for (index, item) in items.iter().enumerate() {
    let piece = scalar_text(item, index)?.len();
    total = total.saturating_add(piece);
    if matches!(item, Value::String(_)) {
      input += piece;
    }
  }
  if !fits(total, input) {
    return Err(too_long("str.join"));
  }
  let mut out = String::with_capacity(total);
  for (index, item) in items.iter().enumerate() {
    if index > 0 {
      out.push_str(sep);
    }
    out.push_str(&scalar_text(item, index)?);
  }
  Ok(Value::String(out.into()))
}

/// `(str.chars TEXT)` — the Unicode scalars of TEXT as one-character strings,
/// in one pass. This is the linear way to walk a string; indexing it with
/// `str.slice` in a loop also works, but rescans up to each index.
pub fn chars<S: Symbol>(args: Vec<Value<S>>) -> Result<Value<S>, RuntimeError> {
  arity(&args, 1..=1, "str.chars takes 1 arg")?;
  let text = text_arg(&args[0], "str.chars")?;
  let count = char_len(text);
  if count > element_limit::<S>() {
    return Err(too_many::<S>("str.chars"));
  }
  let mut items = Vec::new();
  items
    .try_reserve_exact(count)
    .map_err(|_| RuntimeError::Other(format!("str.chars of {count} characters: out of memory")))?;
  let mut buffer = [0u8; 4];
  for ch in text.chars() {
    items.push(Value::String((&*ch.encode_utf8(&mut buffer)).into()));
  }
  Ok(Value::List(List {
    items: items.into(),
  }))
}

#[cfg(test)]
mod tests {
  use string_interner::symbol::SymbolU32;

  use crate::{Runtime, Value};

  fn eval(source: &str) -> Value<SymbolU32> {
    let mut values =
      Runtime::<SymbolU32>::eval(None, source).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    values.pop().unwrap()
  }

  fn assert_true(source: &str) {
    assert!(matches!(eval(source), Value::Boolean(true)), "{source}");
  }

  fn assert_error(source: &str, needle: &str) {
    let message = eval(&format!("(error.message (try {source}))"));
    let Value::String(message) = message else {
      panic!("{source}: no error, got {message:?}")
    };
    assert!(message.contains(needle), "{source}: {message}");
  }

  #[test]
  fn split_keeps_empty_pieces_so_join_restores_the_text() {
    assert_true(r#"(= (str.split "a,b,,c," ",") (list "a" "b" "" "c" ""))"#);
    assert_true(r#"(= (str.split "a::b" "::") (list "a" "b"))"#);
    assert_true(r#"(= (str.split "" ",") (list ""))"#);
    assert_true(r#"(= (str.split nil ",") (list ""))"#);
    assert_true(r#"(= (str.split "no separator" ",") (list "no separator"))"#);
    assert_true(r#"(= (str.split "é😀é" "😀") (list "é" "é"))"#);
    for text in ["a,b,,c,", ",", "", "x"] {
      assert_true(&format!(
        r#"(= (str.join (str.split "{text}" ",") ",") "{text}")"#
      ));
    }
  }

  #[test]
  fn split_limit_keeps_the_remainder_in_the_last_piece() {
    assert_true(r#"(= (str.split "k=v=w" "=" 2) (list "k" "v=w"))"#);
    assert_true(r#"(= (str.split "k=v=w" "=" 1) (list "k=v=w"))"#);
    assert_true(r#"(= (str.split "k=v" "=" 9) (list "k" "v"))"#);
    assert_error(r#"(str.split "k=v" "=" 0)"#, "at least 1");
    assert_error(r#"(str.split "k=v" "=" "2")"#, "Integer");
  }

  #[test]
  fn split_refuses_an_empty_or_missing_separator() {
    assert_error(r#"(str.split "abc" "")"#, "str.chars");
    assert_error(r#"(str.split "abc" nil)"#, "String");
    assert_error(r#"(str.split 12 ",")"#, "String");
    // Arity is a hard error: `try` does not capture it.
    assert!(Runtime::<SymbolU32>::eval(None, r#"(str.split "abc")"#).is_err());
  }

  #[test]
  fn replace_is_literal_and_replaces_every_occurrence() {
    assert_true(r#"(= (str.replace "a.b.c" "." "::") "a::b::c")"#);
    assert_true(r#"(= (str.replace "aaa" "aa" "b") "ba")"#);
    assert_true(r#"(= (str.replace "$1 (x)" "(x)" "$0") "$1 $0")"#);
    assert_true(r#"(= (str.replace "unchanged" "zzz" "y") "unchanged")"#);
    assert_true(r#"(= (str.replace "drop me" " me" nil) "drop")"#);
    assert_true(r#"(= (str.replace nil "a" "b") "")"#);
    assert_error(r#"(str.replace "abc" "" "x")"#, "empty");
  }

  #[test]
  fn replace_refuses_output_past_the_limit() {
    assert_error(
      r#"(str.replace (str.repeat "a" 1048576) "a" (str.repeat "b" 128))"#,
      "output limit",
    );
  }

  #[test]
  fn join_prints_scalars_and_names_a_bad_element() {
    assert_true(r#"(= (str.join (list "a" 1 2.5 true) ", ") "a, 1, 2.5, true")"#);
    assert_true(r#"(= (str.join (list "a" "b")) "ab")"#);
    assert_true(r#"(= (str.join (list) ",") "")"#);
    assert_true(r#"(= (str.join nil ",") "")"#);
    assert_error(r#"(str.join (list "a" nil) ",")"#, "element 1");
    assert_error(r#"(str.join (list "a" (list "b")) ",")"#, "element 1");
    assert_error(r#"(str.join "ab" ",")"#, "List");
  }

  #[test]
  fn chars_returns_unicode_scalars() {
    assert_true(r#"(= (str.chars "aé😀") (list "a" "é" "😀"))"#);
    assert_true(r#"(= (str.chars "") (list))"#);
    assert_true(r#"(= (str.chars nil) (list))"#);
    assert_true(r#"(= (length (str.chars "aé😀")) (length "aé😀"))"#);
  }

  #[test]
  fn byte_span_maps_scalar_positions() {
    use super::byte_span;
    assert_eq!(byte_span("abc", 1, 2), (1, 2));
    assert_eq!(byte_span("abc", 1, 9), (1, 3));
    assert_eq!(byte_span("a😀bc", 1, 3), (1, 6));
    assert_eq!(byte_span("a😀bc", 2, 9), (5, 7));
    assert_eq!(byte_span("a😀bc", 4, 4), (7, 7));
    // Long enough for the position table, read out of order and past the end.
    let long = "é😀a".repeat(200);
    let chars: Vec<char> = long.chars().collect();
    for (start, end) in [(0, 1), (599, 600), (300, 302), (2, 1000), (600, 600)] {
      let (from, to) = byte_span(&long, start, end);
      let want: String = chars[start.min(600)..end.min(600)].iter().collect();
      assert_eq!(&long[from..to], want, "{start}..{end}");
    }
  }

  /// The cached texts in this thread, oldest first, by length.
  fn cached() -> Vec<usize> {
    super::INDEXED.with(|cache| cache.borrow().iter().map(|e| e.text.len()).collect())
  }

  fn assert_span(text: &str, start: usize, end: usize) {
    let chars: Vec<char> = text.chars().collect();
    let want: String = chars[start.min(chars.len())..end.min(chars.len())]
      .iter()
      .collect();
    let (from, to) = super::byte_span(text, start, end);
    assert_eq!(&text[from..to], want, "{start}..{end}");
  }

  #[test]
  fn byte_span_table_lookups_match_a_decode_at_every_position() {
    // Every position across several table marks, single and wide spans.
    let long = "é😀a".repeat(200);
    for start in 0..=601 {
      assert_span(&long, start, start + 1);
      assert_span(&long, start, start + 70);
    }
    assert!(!cached().is_empty());
  }

  #[test]
  fn byte_span_walks_a_slice_near_the_start_or_the_ascii_prefix() {
    let long = "é😀a".repeat(2000);
    assert_span(&long, 0, 1);
    assert_span(&long, 100, 200);
    let prefixed = format!("{}é{}", "a".repeat(100_000), "😀".repeat(1000));
    assert_span(&prefixed, 5, 6);
    assert_span(&prefixed, 99_990, 100_050);
    assert!(cached().is_empty(), "{:?}", cached());
    // Far past the ASCII prefix, the table is built.
    assert_span(&prefixed, 100_900, 100_901);
    assert_eq!(cached(), vec![prefixed.len()]);
  }

  #[test]
  fn byte_span_cache_is_bounded_and_least_recently_used() {
    let texts: Vec<String> = (0..5).map(|i| format!("{i}{}", "é".repeat(1000))).collect();
    for text in &texts[..4] {
      assert_span(text, 900, 901);
    }
    // A hit moves the first text to the back, so the second is evicted.
    assert_span(&texts[0], 901, 902);
    assert_span(&texts[4], 900, 901);
    let held: Vec<char> = super::INDEXED.with(|cache| {
      cache
        .borrow()
        .iter()
        .map(|e| e.text.chars().next().unwrap())
        .collect()
    });
    assert_eq!(held, vec!['2', '3', '0', '4']);
    // Texts past the per-text limit are walked, never copied.
    let huge = "é".repeat(super::INDEXED_TEXT_MAX / 2 + 1);
    assert_span(&huge, 1_000_000, 1_000_001);
    assert!(cached().iter().all(|len| *len <= super::INDEXED_TEXT_MAX));
    // Large texts evict others to stay within the byte budget.
    for i in 0..4 {
      let big = format!("{i}{}", "é".repeat(super::INDEXED_TEXT_MAX / 2 - 8));
      assert_span(&big, 500_000, 500_001);
      let held: usize =
        super::INDEXED.with(|cache| cache.borrow().iter().map(super::Indexed::bytes).sum());
      assert!(held <= super::INDEXED_BUDGET, "{held}");
    }
  }

  #[test]
  fn join_without_a_separator_never_fails_and_an_oversized_join_fails_first() {
    // Nine 8 MiB strings: 72 MiB, past the output limit but no larger than
    // the strings joined.
    let eight = "(str.repeat \"a\" 8388608)";
    let parts = std::iter::repeat(eight)
      .take(9)
      .collect::<Vec<_>>()
      .join(" ");
    assert_true(&format!(
      "(= (length (str.join (list {parts}))) {})",
      9 * 8388608
    ));
    assert_error(&format!("(str.join (list {parts}) \",\")"), "output limit");
    // Shrinking or same-size replacements of that text are not refused.
    assert_true(&format!(
      "(= (length (str.replace (str.join (list {parts} \"x\")) \"x\" \"y\")) {})",
      9 * 8388608 + 1
    ));
  }
}
