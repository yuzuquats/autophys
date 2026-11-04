//! One `logs.ljson` / `trace.ljson` line → one [`LjsonEntry`], tolerant of the
//! one thing a browser writes that `serde_json` refuses: a lone UTF-16
//! surrogate escape.
//!
//! JavaScript strings are UTF-16, and `String.prototype.slice` counts code
//! units, so a probe that trims `text.slice(0, 90)` over emoji cuts a pair in
//! half. ES2019 "well-formed JSON.stringify" then writes the orphan as a
//! `\ud83c` escape. That line is valid JSON (RFC 8259 leaves unpaired
//! surrogates to the implementation), but it cannot be a Rust `String`, so
//! `serde_json` fails with `unexpected end of hex escape` (a lead with no
//! trail) or `lone leading surrogate in hex escape` (a trail with no lead).
//!
//! Every page writer produces it: the runner's harness sink (`JSON.stringify`
//! per entry in lona-screenshot `browser.ts`) and the in-page uploader alike.
//! A strict reader turned one such probe line into `Failed to parse LJSON
//! entry` → exit 1 before verification, and the run left no ledger row
//! (weather-location-rebind in lona candidates 12 and 18). Dropping the line
//! instead would be worse: that line was a REQUIRED probe, so the judge would
//! have reported a false "Required MISSING".
//!
//! So: parse strictly first; only on failure replace each unpaired surrogate
//! escape with `�` (what `TextDecoder` and `String::from_utf16_lossy` do)
//! and parse again. A line that is still invalid keeps the ORIGINAL error.

use tento_logger::ljson::LjsonEntry;

/// Parse a line without changing the retained evidence on disk.
/// Old server-owned step markers omitted the required span id. Only that
/// exact leaf marker shape receives a synthetic, deterministic identity.
pub fn parse_ljson_line(line: &str) -> serde_json::Result<LjsonEntry> {
  let repaired = repair_lone_surrogates(line);
  let input = repaired.as_deref().unwrap_or(line);
  match serde_json::from_str(input) {
    Ok(entry) => Ok(entry),
    Err(repaired_error) => {
      let error = serde_json::from_str::<LjsonEntry>(line).err().unwrap_or(repaired_error);
      let mut value: serde_json::Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(_) => return Err(error),
      };
      let marker = &value["rootSpan"];
      let attributes = &marker["attributes"];
      if value["v"] == 1 && value["origin"] == "server"
        && marker.get("id").is_none()
        && marker["name"] == "step-marker"
        && marker["durationMs"] == 0 && marker["level"] == "info"
        && marker["children"].as_array().is_some_and(Vec::is_empty)
        && attributes["stepIndex"].as_u64().is_some()
        && attributes["stepText"].as_str().is_some()
        && attributes["checked"].as_bool().is_some()
      {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        "legacy-server-step-marker".hash(&mut hash);
        input.hash(&mut hash);
        value["rootSpan"]["id"] = (hash.finish() | (1_u64 << 63)).into();
        serde_json::from_value(value).map_err(|_| error)
      } else {
        Err(error)
      }
    }
  }
}

/// Rewrite every `\uD800`–`\uDFFF` escape that is not half of a well-formed
/// lead+trail pair as `�`. Returns `None` when there was nothing to
/// rewrite, so a line broken some other way is reported as it was.
///
/// Works on bytes: an escape is ASCII, and in UTF-8 no byte of a multi-byte
/// character is < 0x80, so copying every other byte through unchanged keeps
/// the output valid UTF-8. A `\` outside a string is already invalid JSON; a
/// `\\` is consumed as one escape, so `\\ud83c` (an escaped backslash
/// followed by text) is never mistaken for a surrogate.
pub fn repair_lone_surrogates(line: &str) -> Option<String> {
  fn hex4(bytes: &[u8], at: usize) -> Option<u16> {
    let digits = bytes.get(at..at + 4)?;
    u16::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
  }
  // `\uXXXX` at `at` → its code unit.
  fn unit_at(bytes: &[u8], at: usize) -> Option<u16> {
    if bytes.get(at) == Some(&b'\\') && bytes.get(at + 1) == Some(&b'u') {
      hex4(bytes, at + 2)
    } else {
      None
    }
  }
  let is_lead = |u: u16| (0xD800..=0xDBFF).contains(&u);
  let is_trail = |u: u16| (0xDC00..=0xDFFF).contains(&u);

  let bytes = line.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut changed = false;
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] != b'\\' {
      out.push(bytes[i]);
      i += 1;
      continue;
    }
    match unit_at(bytes, i) {
      Some(lead) if is_lead(lead) => match unit_at(bytes, i + 6) {
        Some(trail) if is_trail(trail) => {
          out.extend_from_slice(&bytes[i..i + 12]);
          i += 12;
        }
        _ => {
          out.extend_from_slice(b"\\ufffd");
          changed = true;
          i += 6;
        }
      },
      Some(unit) if is_trail(unit) => {
        out.extend_from_slice(b"\\ufffd");
        changed = true;
        i += 6;
      }
      Some(_) => {
        out.extend_from_slice(&bytes[i..i + 6]);
        i += 6;
      }
      // Any other escape (`\"`, `\\`, `\n`, a malformed `\u`): copy the
      // backslash and the byte it escapes, so `\\` never starts a `\u`.
      None => {
        out.extend_from_slice(&bytes[i..(i + 2).min(bytes.len())]);
        i += 2;
      }
    }
  }
  changed.then(|| String::from_utf8(out).expect("only ASCII escapes were rewritten"))
}

#[cfg(test)]
mod tests {
  use super::*;

  const LEGACY_MARKER: &str = r#"{"v":1,"ts":"2026-10-30T22:14:12.701Z","sessionId":"2e988f53-491a-4da1-9af4-82dd805ff7ea","origin":"server","rootSpan":{"name":"step-marker","level":"info","durationMs":0,"location":{},"attributes":{"stepIndex":0,"stepText":"Get started","checked":true},"children":[]}}"#;

  #[test]
  fn retained_server_markers_gain_stable_identity_without_losing_evidence() {
    let a = parse_ljson_line(LEGACY_MARKER).unwrap();
    let b = parse_ljson_line(LEGACY_MARKER).unwrap();
    assert_eq!(a.root_span.id, b.root_span.id);
    assert_eq!(a.root_span.attributes["checked"], true);
    assert_eq!(a.root_span.attributes["stepText"], "Get started");
    let other = parse_ljson_line(&LEGACY_MARKER.replace("12.701Z", "13.701Z")).unwrap();
    assert_ne!(a.root_span.id, other.root_span.id);
    let mut value: serde_json::Value = serde_json::from_str(LEGACY_MARKER).unwrap();
    value["rootSpan"]["id"] = 42.into();
    assert_eq!(parse_ljson_line(&value.to_string()).unwrap().root_span.id, 42);
  }

  #[test]
  fn missing_ids_remain_errors_outside_legacy_server_leaf_markers() {
    for (from, to) in [("server", "client"), ("step-marker", "api-call"),
      ("\"checked\":true", "\"checked\":\"true\""),
      ("\"stepIndex\":0", "\"stepIndex\":-1"),
      ("\"durationMs\":0", "\"durationMs\":1")] {
      assert!(parse_ljson_line(&LEGACY_MARKER.replace(from, to)).is_err(), "{from}");
    }
  }

  /// The c18 line, trimmed: a ux-weather probe whose `text.slice(0, 90)` cut
  /// 🌧️ (U+1F327 = 🌧) after its lead surrogate.
  const C18_LINE: &str = r#"{"v":1,"ts":"2026-09-25T00:30:37.810Z","sessionId":"49597d82-524c-4c2b-8761-08f08eeab7ee","origin":"client","rootSpan":{"id":2199,"name":"app-command/uxTrace","level":"info","durationMs":0,"location":{},"attributes":{"user.action":false,"probe":"ux-weather","report":"ux-weather before-cells=9 painted=true chars=220 text=☀️ ☁️|🌧️ 🌧️ \ud83c"},"children":[]}}"#;

  #[test]
  fn strict_serde_rejects_the_c18_line() {
    // The failure this module exists for, reproduced: the same message the
    // runner printed before exiting 1 with no ledger row.
    let err = serde_json::from_str::<LjsonEntry>(C18_LINE).unwrap_err();
    assert!(
      err.to_string().contains("unexpected end of hex escape"),
      "{err}"
    );
  }

  #[test]
  fn the_c18_line_parses_and_keeps_its_probe() {
    let entry = parse_ljson_line(C18_LINE).expect("repaired line parses");
    assert_eq!(entry.root_span.name, "app-command/uxTrace");
    let report = entry.root_span.attributes["report"].as_str().unwrap();
    // The verification pattern `ux-weather before-cells=[1-9].* painted=true`
    // still has its line, and the orphan became U+FFFD, not nothing.
    assert!(report.starts_with("ux-weather before-cells=9 painted=true"));
    assert!(report.ends_with("🌧️ \u{fffd}"), "{report:?}");
  }

  #[test]
  fn a_lone_trail_surrogate_is_repaired_too() {
    // `text.slice(1)` over an emoji leaves the trail half first.
    let line = C18_LINE.replace(r"\ud83c", r"\udf27");
    assert!(serde_json::from_str::<LjsonEntry>(&line).is_err());
    let entry = parse_ljson_line(&line).expect("repaired line parses");
    let report = entry.root_span.attributes["report"].as_str().unwrap();
    assert!(report.ends_with('\u{fffd}'), "{report:?}");
  }

  #[test]
  fn well_formed_pairs_and_escaped_backslashes_are_untouched() {
    // Built with `concat!` so the escapes stay escapes in any editor: a real
    // pair, an escaped backslash before `ud83c`, a BMP escape, a quote.
    let s = concat!(
      r"pair=", r"\ud83c", r"\udf27",
      r" literal=", r"\\", "ud83c",
      r" bmp=", r"\u00e9", r" quote=", r"\", "\"", " tail"
    );
    assert_eq!(repair_lone_surrogates(s), None);
    // A lone lead immediately before a pair: only the orphan changes.
    let input = concat!(r"\ud83c", r"\ud83c", r"\udf27");
    let want = concat!(r"\ufffd", r"\ud83c", r"\udf27");
    assert_eq!(repair_lone_surrogates(input).as_deref(), Some(want));
  }

  #[test]
  fn a_line_broken_some_other_way_keeps_its_original_error() {
    let truncated = &C18_LINE[..C18_LINE.len() - 20];
    let strict = serde_json::from_str::<LjsonEntry>(truncated).unwrap_err().to_string();
    let ours = parse_ljson_line(truncated).unwrap_err().to_string();
    assert_eq!(strict, ours);
  }
}
