//! Extended glob matching (`?(…)`, `*(…)`, `+(…)`, `@(…)`, `!(…)`), always on
//! in tsh (`shopt extglob` reports `on`). The pattern compiler in
//! bash_expansion.rs turns a group into [`GlobToken::Group`]; a pattern with
//! groups is matched here by tracking every position the pattern can reach
//! (no backtracking), so pathname expansion, `case`, `[[ == ]]` and the
//! `${x#pat}`/`${x%pat}`/`${x/pat/}` operators all share it.
use super::{GlobToken, compile_component, single_matches};

/// Parse the group whose operator is at `pattern[start]` (`(` follows):
/// the token and the index past its `)`. `None` leaves the characters
/// literal (no matching `)`).
pub(super) fn group(pattern: &[u8], start: usize) -> Option<(GlobToken, usize)> {
  let kind = *pattern.get(start)?;
  if !matches!(kind, b'?' | b'*' | b'+' | b'@' | b'!') || pattern.get(start + 1) != Some(&b'(') {
    return None;
  }
  let mut depth = 0usize;
  let mut alternatives = Vec::new();
  let mut from = start + 2;
  let mut i = start + 1;
  while i < pattern.len() {
    match pattern[i] {
      b'\\' => {
        i += 2;
        continue;
      }
      b'[' => {
        if let Some((_, end)) = super::bracket(pattern, i) {
          i = end;
          continue;
        }
      }
      b'(' => depth += 1,
      b'|' if depth == 1 => {
        alternatives.push(compile_component(&pattern[from..i]));
        from = i + 1;
      }
      b')' => {
        depth -= 1;
        if depth == 0 {
          alternatives.push(compile_component(&pattern[from..i]));
          return Some((GlobToken::Group(kind, alternatives), i + 1));
        }
      }
      _ => {}
    }
    i += 1;
  }
  None
}

/// Whether TOKENS match all of NAME.
pub(super) fn matches(tokens: &[GlobToken], name: &[u8]) -> bool {
  ends(tokens, name, 0)[name.len()]
}

/// Every end position `e` such that TOKENS match `name[start..e]`.
fn ends(tokens: &[GlobToken], name: &[u8], start: usize) -> Vec<bool> {
  let mut current = vec![false; name.len() + 1];
  current[start] = true;
  for token in tokens {
    let mut next = vec![false; name.len() + 1];
    for position in start..=name.len() {
      if !current[position] {
        continue;
      }
      match token {
        GlobToken::Star => {
          for reached in next.iter_mut().skip(position) {
            *reached = true;
          }
          break;
        }
        GlobToken::Group(kind, alternatives) => {
          for (end, reached) in group_ends(*kind, alternatives, name, position).into_iter().enumerate() {
            next[end] |= reached;
          }
        }
        single => {
          if position < name.len() && single_matches(single, name[position]) {
            next[position + 1] = true;
          }
        }
      }
    }
    current = next;
  }
  current
}

fn alternative_ends(alternatives: &[Vec<GlobToken>], name: &[u8], start: usize) -> Vec<bool> {
  let mut result = vec![false; name.len() + 1];
  for alternative in alternatives {
    for (end, reached) in ends(alternative, name, start).into_iter().enumerate() {
      result[end] |= reached;
    }
  }
  result
}

fn group_ends(kind: u8, alternatives: &[Vec<GlobToken>], name: &[u8], start: usize) -> Vec<bool> {
  match kind {
    b'@' => alternative_ends(alternatives, name, start),
    b'?' => {
      let mut result = alternative_ends(alternatives, name, start);
      result[start] = true;
      result
    }
    b'*' | b'+' => {
      // Positions reachable by one or more alternatives in a row (`*`
      // also by none), each expanded once.
      let mut reached = vec![false; name.len() + 1];
      reached[start] = kind == b'*';
      let mut expanded = vec![false; name.len() + 1];
      let mut queue = vec![start];
      while let Some(position) = queue.pop() {
        if std::mem::replace(&mut expanded[position], true) {
          continue;
        }
        for (end, hit) in alternative_ends(alternatives, name, position).into_iter().enumerate() {
          if hit {
            reached[end] = true;
            if !expanded[end] {
              queue.push(end);
            }
          }
        }
      }
      reached
    }
    // `!(…)`: any segment that none of the alternatives matches.
    _ => {
      let excluded = alternative_ends(alternatives, name, start);
      (0..=name.len()).map(|end| end >= start && !excluded[end]).collect()
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn glob(pattern: &str, name: &str) -> bool {
    super::super::pattern_text_matches(pattern, name)
  }

  // Each verdict agrees with bash 5.3 `[[ NAME == PATTERN ]]` (extglob on).
  #[test]
  fn extglob_operators_match_like_bash() {
    assert!(glob("@(a|b)", "a") && glob("@(a|b)", "b") && !glob("@(a|b)", "ab"));
    assert!(glob("?(a)x", "x") && glob("?(a)x", "ax") && !glob("?(a)x", "aax"));
    assert!(glob("*(ab)", "") && glob("*(ab)", "abab") && !glob("*(ab)", "aba"));
    assert!(!glob("+(ab)", "") && glob("+(ab)", "ab") && glob("+(a|b)c", "abbac"));
    assert!(glob("!(foo)", "bar") && !glob("!(foo)", "foo") && glob("!(foo)", "foox"));
    assert!(glob("a!(b)c", "ac") && glob("a!(b)c", "abbc") && !glob("a!(b)c", "abc"));
    assert!(glob("*.@(jpg|png)", "x.png") && !glob("*.@(jpg|png)", "x.gif"));
    assert!(glob("@(a*(b)|c)", "abbb") && glob("+([0-9])", "123") && !glob("+([0-9])", "12a"));
    assert!(glob("!(*.txt)", "a.md") && !glob("!(*.txt)", "a.txt"));
    assert!(glob("\\@(a)", "@(a)") && !glob("\\@(a)", "a"));
    assert!(glob("@(a", "@(a"));
  }
}
