//! The matcher/ranker: pure functions the engine runs over every provider's
//! output. Two match classes, a total sort order, and the token-under-caret
//! extraction — all headless-testable, no I/O.

use crate::seam::Candidate;

/// How a candidate matched the prefix. `Prefix` outranks `Subsequence`
/// (derived `Ord` follows declaration order — keep `Prefix` first).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum MatchClass {
  /// `insert` starts with the prefix (case-sensitive). The empty prefix is a
  /// prefix of everything, so the "/" discovery gesture lists the full set
  /// here.
  Prefix,
  /// The prefix's chars appear in `insert` in order, case-insensitively.
  Subsequence,
}

/// Classify how `insert` matches `prefix`, or `None` for a non-match (dropped).
/// A case-sensitive prefix beats a case-insensitive subsequence; a prefix that
/// only matches when folding case still ranks as a subsequence, by design —
/// the class is literally "does `insert` start with `prefix`".
pub fn match_class(insert: &str, prefix: &str) -> Option<MatchClass> {
  if prefix.is_empty() || insert.starts_with(prefix) {
    return Some(MatchClass::Prefix);
  }
  if is_subsequence_ci(prefix, insert) {
    return Some(MatchClass::Subsequence);
  }
  None
}

/// Whether `needle`'s chars appear in `haystack` in order, case-insensitively.
fn is_subsequence_ci(needle: &str, haystack: &str) -> bool {
  let mut hay = haystack.chars().flat_map(char::to_lowercase);
  'next: for nc in needle.chars().flat_map(char::to_lowercase) {
    for hc in hay.by_ref() {
      if hc == nc {
        continue 'next;
      }
    }
    return false;
  }
  true
}

/// Rank candidates from every provider into one list. `tagged` pairs each
/// candidate with its provider's position in the [`ProviderSet`]
/// (`crate::seam::ProviderSet`). Non-matches drop. The sort key is
/// `(match class, provider position, score descending, insert ascending)` — so
/// prefix beats subsequence, then earlier providers win, then a provider's own
/// score orders its results, and `insert` breaks any final tie for a stable
/// order. Pure; the engine caps the returned list.
pub fn rank(prefix: &str, tagged: Vec<(usize, Candidate)>) -> Vec<Candidate> {
  let mut matched: Vec<(MatchClass, usize, Candidate)> = tagged
    .into_iter()
    .filter_map(|(pos, cand)| match_class(&cand.insert, prefix).map(|cls| (cls, pos, cand)))
    .collect();
  matched.sort_by(|a, b| {
    a.0
      .cmp(&b.0)
      .then(a.1.cmp(&b.1))
      .then(b.2.score.cmp(&a.2.score))
      .then(a.2.insert.cmp(&b.2.insert))
  });
  matched.into_iter().map(|(_, _, cand)| cand).collect()
}

/// The token under the caret AND the caret-convention **char index** of its
/// start. The token runs from the last whitespace boundary before the caret to
/// the caret; the returned start is a char index (same convention as `caret`),
/// so an accept-time caller replaces `start..caret` (both char indices) with the
/// candidate's insert. `caret` is a char index (the host input pane's cursor
/// convention, which counts chars, not bytes) — so the slice always lands on a
/// char boundary even in unicode buffers. A caret past the end clamps to the
/// buffer end; an empty or all-consumed run yields a `""` token whose start is
/// the caret itself (the full-set discovery gesture).
pub fn token_at(buffer: &str, caret: usize) -> (usize, &str) {
  // char index → byte offset (end of the token).
  let end = buffer
    .char_indices()
    .nth(caret)
    .map(|(i, _)| i)
    .unwrap_or(buffer.len());
  // Walk back to the byte just after the last whitespace char before the caret.
  let start = buffer[..end]
    .char_indices()
    .rev()
    .find(|(_, c)| c.is_whitespace())
    .map(|(i, c)| i + c.len_utf8())
    .unwrap_or(0);
  // The token start as a char index = chars preceding the start byte.
  let start_char = buffer[..start].chars().count();
  (start_char, &buffer[start..end])
}

/// The token being typed under the caret (see [`token_at`]) — the slice only,
/// for match/rank callers that don't need the start offset.
pub fn prefix_at(buffer: &str, caret: usize) -> &str {
  token_at(buffer, caret).1
}

/// The effective **match prefix** at the caret, applying the discovery-slash
/// rule the engine ranks and publishes against. A token that starts at char 0
/// AND begins with `/` is the discovery gesture: its leading slash is stripped
/// (`"/"` → `""` = the full-set listing via the empty-prefix rule; `"/se"` →
/// `"se"`), so the slash triggers listing without ever being matched. A `/`
/// anywhere but char 0 — a path token like `"src/ma"`, or a `"/se"` that isn't
/// the buffer's first token — is ordinary and matched verbatim. Accept is
/// unaffected: [`token_at`] spans the whole token (slash included), so the
/// accept edit replaces the slash too.
pub fn effective_prefix(buffer: &str, caret: usize) -> &str {
  let (start, token) = token_at(buffer, caret);
  match token.strip_prefix('/') {
    Some(rest) if start == 0 => rest,
    _ => token,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::seam::Candidate;

  fn cand(insert: &str, score: u32) -> Candidate {
    Candidate::new(insert, "src", score)
  }

  // ---- prefix_at ----

  #[test]
  fn prefix_at_mid_word_stops_at_the_caret() {
    // "ls foo|bar" — caret after the 6th char, inside "foobar".
    assert_eq!(prefix_at("ls foobar", 6), "foo");
  }

  #[test]
  fn prefix_at_caret_zero_is_empty() {
    assert_eq!(prefix_at("hello", 0), "");
  }

  #[test]
  fn prefix_at_right_after_whitespace_is_empty() {
    // Caret sits just past the space: no token started yet.
    assert_eq!(prefix_at("ls ", 3), "");
  }

  #[test]
  fn prefix_at_caret_at_end_takes_the_last_token() {
    assert_eq!(prefix_at("deploy rwc", 10), "rwc");
  }

  #[test]
  fn prefix_at_respects_char_boundaries_in_unicode() {
    // "café x" — caret at the end of "café" (4 chars: c a f é).
    assert_eq!(prefix_at("café x", 4), "café");
    // Caret at the end of the whole buffer (6 chars).
    assert_eq!(prefix_at("café x", 6), "x");
    // A multibyte word after a space, caret mid-word.
    assert_eq!(prefix_at("go naïve", 5), "na");
  }

  #[test]
  fn prefix_at_caret_past_end_clamps() {
    assert_eq!(prefix_at("ab", 99), "ab");
  }

  // ---- token_at (start offset) ----

  #[test]
  fn token_at_reports_the_start_char_index() {
    // "ls foobar" — caret at char 6, inside "foobar": token "foo" starts at 3.
    assert_eq!(token_at("ls foobar", 6), (3, "foo"));
    // Caret at end takes the last token; "rwc" starts at char 7.
    assert_eq!(token_at("deploy rwc", 10), (7, "rwc"));
    // Right after whitespace: empty token whose start is the caret.
    assert_eq!(token_at("ls ", 3), (3, ""));
    // Caret at 0: empty token starting at 0.
    assert_eq!(token_at("hello", 0), (0, ""));
  }

  #[test]
  fn token_at_start_is_a_char_index_in_unicode() {
    // "café x" — caret at char 6 (end): token "x" starts at char 5, NOT byte 6.
    assert_eq!(token_at("café x", 6), (5, "x"));
    // A multibyte word after a space, caret mid-word: "na" starts at char 3.
    assert_eq!(token_at("go naïve", 5), (3, "na"));
    // The token itself starts at 0 when it is the whole (multibyte) buffer.
    assert_eq!(token_at("café", 4), (0, "café"));
  }

  #[test]
  fn token_at_past_end_clamps_start_and_slice() {
    assert_eq!(token_at("ab", 99), (0, "ab"));
  }

  // ---- effective_prefix (discovery-slash rule) ----

  #[test]
  fn effective_prefix_strips_a_leading_discovery_slash() {
    // "/" at char 0 → the empty prefix (full-set listing).
    assert_eq!(effective_prefix("/", 1), "");
    // "/se" at char 0 → "se" (the slash is the gesture, not part of the match).
    assert_eq!(effective_prefix("/se", 3), "se");
  }

  #[test]
  fn effective_prefix_only_at_char_zero() {
    // A '/'-led token that is NOT the buffer's first token is ordinary.
    assert_eq!(effective_prefix("x /se", 5), "/se");
    // A path token whose '/' is interior (not leading) is matched verbatim.
    assert_eq!(effective_prefix("src/ma", 6), "src/ma");
    // A plain token is unchanged.
    assert_eq!(effective_prefix("se", 2), "se");
  }

  // ---- match_class ----

  #[test]
  fn empty_prefix_matches_everything_as_prefix() {
    assert_eq!(match_class("anything", ""), Some(MatchClass::Prefix));
  }

  #[test]
  fn prefix_beats_subsequence_and_nonmatch_drops() {
    assert_eq!(match_class("sessions", "sess"), Some(MatchClass::Prefix));
    assert_eq!(
      match_class("sessions", "ssn"),
      Some(MatchClass::Subsequence)
    );
    assert_eq!(match_class("sessions", "xyz"), None);
  }

  // ---- rank ----

  #[test]
  fn prefix_class_ranks_above_subsequence() {
    // Both from the same provider (pos 0): the prefix match must lead.
    let tagged = vec![(0, cand("s_n_ip", 100)), (0, cand("snippet", 1))];
    let out = rank("sn", tagged);
    assert_eq!(out[0].insert, "snippet"); // prefix, despite the lower score
    assert_eq!(out[1].insert, "s_n_ip"); // subsequence
  }

  #[test]
  fn provider_order_breaks_ties_within_a_class() {
    // Same class (prefix), same-ish score: earlier provider wins.
    let tagged = vec![(1, cand("deploy-b", 50)), (0, cand("deploy-a", 50))];
    let out = rank("dep", tagged);
    assert_eq!(out[0].insert, "deploy-a"); // provider 0
    assert_eq!(out[1].insert, "deploy-b"); // provider 1
  }

  #[test]
  fn score_orders_within_a_provider() {
    let tagged = vec![(0, cand("scene-low", 1)), (0, cand("scene-high", 9))];
    let out = rank("scene", tagged);
    assert_eq!(out[0].insert, "scene-high");
    assert_eq!(out[1].insert, "scene-low");
  }

  #[test]
  fn empty_prefix_returns_all_matches() {
    let tagged = vec![(0, cand("a", 0)), (0, cand("b", 0)), (1, cand("c", 0))];
    let out = rank("", tagged);
    assert_eq!(out.len(), 3);
  }
}
