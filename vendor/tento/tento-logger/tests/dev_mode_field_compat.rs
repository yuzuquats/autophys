//! The request line's dev-mode marker survives the `yuzu.dev_mode` →
//! `app.dev_mode` field rename.
//!
//! The renamed field is emitted by the tracing middleware and read back by the
//! terminal renderer, but the two are separated by however long a host keeps
//! its logs: every row already on disk carries the old name. A renderer that
//! only knew the new name would drop the B/R/P marker off every stored request
//! without failing anywhere, so this pins the fallback rather than the rename.
//!
//! Delete this test together with the fallback arms in
//! `render/terminal/http.rs`, once no stored log predates the rename.

use tento_logger::ljson::LjsonEntry;
use tento_logger::render::render_entry;
use tento_logger::render::terminal::ColumnVisibility;

fn request_entry(dev_mode_key: &str) -> LjsonEntry {
  let line = format!(
    r#"{{"v":1,"ts":"2026-01-30T10:15:32.142Z",
        "sessionId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "rootSpan":{{"id":1001,"name":"http_request","level":"info",
          "durationMs":142,"location":{{"file":"routes/api.rs","line":45}},
          "attributes":{{"http.method":"POST","http.target":"/api/sheets",
            "http.status_code":200,"http.host":"example.com",
            "span.kind":"request","{dev_mode_key}":"beta"}},
          "children":[]}}}}"#
  );
  serde_json::from_str(&line).expect("fixture line parses")
}

#[test]
fn a_legacy_dev_mode_field_renders_exactly_like_the_current_one() {
  let viz = ColumnVisibility::all();
  let current = render_entry(&request_entry("app.dev_mode"), &viz);
  let legacy = render_entry(&request_entry("yuzu.dev_mode"), &viz);

  assert_eq!(
    legacy, current,
    "a row written before the rename must render identically to one written after"
  );

  // And the marker is actually there — otherwise the equality above would be
  // satisfied by both renderings dropping it.
  let without = render_entry(&request_entry("unrelated.attribute"), &viz);
  assert_ne!(
    current, without,
    "the dev-mode marker must change the rendered request line at all"
  );
}
