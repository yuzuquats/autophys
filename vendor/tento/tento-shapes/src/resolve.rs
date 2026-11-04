use std::path::Path;

use serde_json::Value;
use tento_tui_core::source::read_all;

/// Resolves a `source` DataRef (`{kind:"file", path}`) to its current value.
/// Resolution happens in [`ShapeRegistry::render`](crate::ShapeRegistry::render),
/// before widget dispatch, so live file-backed content is shape-agnostic —
/// except `row_shape:"records"` sources, which the owning widget composes
/// itself via [`SourceResolver::resolve_records`] (the records are the rows of
/// the outer value, not a replacement for it).
pub trait SourceResolver {
  fn resolve(&self, source: &Value) -> Option<Value>;

  /// ALL records of a `row_shape:"records"` file source, in file order.
  /// Default `None` — a resolver that can't serve records degrades the render
  /// to the standard unresolved-source diagnostic.
  fn resolve_records(&self, source: &Value) -> Option<Vec<Value>> {
    let _ = source;
    None
  }

  /// A small plain-JSON sidecar by path (a table's mutable view file).
  /// Default `None` — callers treat that as "no sidecar" (view defaults).
  fn resolve_json(&self, path: &str) -> Option<Value> {
    let _ = path;
    None
  }

  /// The tail of a plain text file by path (a background job's output): at
  /// most `max_bytes`, from a line start. Default `None` — a host that cannot
  /// read files shows no output.
  fn resolve_text(&self, path: &str, max_bytes: usize) -> Option<String> {
    let _ = (path, max_bytes);
    None
  }

  /// Numeric `(ts_ms, value)` points of a windowed series source —
  /// `kind:"bucket"` (node-bucket time series) today. Resolved per series
  /// by the `chart/v1` widget, not pre-dispatch (the points feed the OUTER
  /// chart's rows, same composition rule as `row_shape:"records"`). Default
  /// `None` — a host without bucket access degrades that series to a
  /// per-series diagnostic line.
  fn resolve_points(&self, source: &Value, from_ms: i64, to_ms: i64) -> Option<Vec<(i64, f64)>> {
    let _ = (source, from_ms, to_ms);
    None
  }
}

/// `kind:"file"` — the latest record of a headered pane file, re-read fresh on
/// every paint so the rendered value tracks the file (the hosting pane watches
/// the session `aliases/` dir for repaints). `kind:"bucket"` (windowed,
/// node-log-scale) is reserved and unresolved here.
pub struct FileSourceResolver;

impl SourceResolver for FileSourceResolver {
  fn resolve(&self, source: &Value) -> Option<Value> {
    match source.get("kind").and_then(Value::as_str)? {
      "file" => {
        let path = source.get("path").and_then(Value::as_str)?;
        // One read: this resolves on every paint, and the follower's
        // open-then-poll read the file twice for its last line.
        let (_header, lines) = read_all(Path::new(path)).ok()?;
        serde_json::from_str::<Value>(lines.last()?).ok()
      }
      _ => None,
    }
  }

  fn resolve_records(&self, source: &Value) -> Option<Vec<Value>> {
    match source.get("kind").and_then(Value::as_str)? {
      "file" => {
        let path = source.get("path").and_then(Value::as_str)?;
        let (_header, lines) = read_all(Path::new(path)).ok()?;
        // A malformed line (partial write) drops rather than killing the
        // whole table.
        Some(
          lines
            .iter()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect(),
        )
      }
      _ => None,
    }
  }

  fn resolve_json(&self, path: &str) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
  }

  fn resolve_text(&self, path: &str, max_bytes: usize) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes as u64);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
      // The tail starts mid-line: drop the partial first line.
      match text.find('\n') {
        Some(newline) => text.drain(..=newline),
        None => text.drain(..),
      };
    }
    Some(text)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  /// `kind:"file"` resolves to the LAST record of a headered pane file.
  #[test]
  fn file_source_resolves_latest_record() {
    let path =
      std::env::temp_dir().join(format!("tento-shapes-resolve-{}.ljson", std::process::id()));
    let mut f = std::fs::File::create(&path).unwrap();
    writeln!(
      f,
      "{}",
      serde_json::json!({"v":1,"shape":"table/v1","encoding":"records"})
    )
    .unwrap();
    writeln!(
      f,
      "{}",
      serde_json::json!({"shape":"table/v1","columns":[{"header":"Old"}],"rows":[]})
    )
    .unwrap();
    writeln!(
      f,
      "{}",
      serde_json::json!({"shape":"table/v1","columns":[{"header":"New"}],"rows":[]})
    )
    .unwrap();

    let src = serde_json::json!({"kind": "file", "path": path.to_str().unwrap()});
    let resolved = FileSourceResolver.resolve(&src).expect("resolves");
    assert_eq!(resolved["columns"][0]["header"], "New");
    std::fs::remove_file(&path).ok();
  }

  #[test]
  fn unknown_kind_and_missing_file_resolve_to_none() {
    assert!(
      FileSourceResolver
        .resolve(&serde_json::json!({"kind": "bucket"}))
        .is_none()
    );
    assert!(
      FileSourceResolver
        .resolve(&serde_json::json!({"kind": "file", "path": "/nonexistent/x.ljson"}))
        .is_none()
    );
  }

  /// `resolve_records` returns ALL records in file order (not last-wins) and
  /// drops a malformed line instead of failing the table.
  #[test]
  fn file_source_resolves_all_records() {
    let path =
      std::env::temp_dir().join(format!("tento-shapes-records-{}.ljson", std::process::id()));
    let mut f = std::fs::File::create(&path).unwrap();
    writeln!(
      f,
      "{}",
      serde_json::json!({"v":1,"shape":"table-rows/v1","encoding":"records"})
    )
    .unwrap();
    writeln!(f, "{}", serde_json::json!({"name":"a"})).unwrap();
    writeln!(f, "{{truncated partial wri").unwrap();
    writeln!(f, "{}", serde_json::json!({"name":"b"})).unwrap();

    let src =
      serde_json::json!({"kind": "file", "path": path.to_str().unwrap(), "row_shape": "records"});
    let records = FileSourceResolver.resolve_records(&src).expect("resolves");
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["name"], "a");
    assert_eq!(records[1]["name"], "b");
    std::fs::remove_file(&path).ok();
  }
}
