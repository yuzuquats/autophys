use serde_json::{Value, json};
use tento_term::{BOLD, DIMMED, RESET};
use tento_tui_core::input::{Event, KeyCode, Mouse};

use crate::registry::{
  RenderCtx, ShapeOutput, ShapeRegistry, ShapeWidget, WidgetAction, WidgetEvent,
};

/// `job/v1` — the live row of a background job: one line that follows the job
/// (`[1] 4821` while it runs, `[1]+  Stopped  cmd`, `[1]+  Done  cmd`,
/// `Exit 2`, a signal's description once it is over), and that expands the
/// job's output inline below it and collapses it again.
///
/// The value is the job's `job/v1` projection (`std.jobs.show`) plus an
/// `output` text-file source; the producer rewrites it in place on every
/// transition (a `source` file, like a terminal's grid) and the row follows.
/// The output is the job's own pane: it never mixes with the line being typed.
///
/// Path scheme: the row is `<base>/job`. Enter, Space or a click on it
/// toggles the output (per-path view state `{"expanded": bool}`, host-held).
pub const JOB_V1: &str = "job/v1";

pub struct JobWidget;

/// Most output lines an expanded row shows (the newest).
const OUTPUT_LINES: usize = 40;
/// Most output bytes read for an expanded row.
const OUTPUT_BYTES: usize = 32 * 1024;

fn expanded(state: Option<&Value>) -> bool {
  state
    .and_then(|state| state.get("expanded"))
    .and_then(Value::as_bool)
    .unwrap_or(false)
}

/// bash's status column (`Running`, `Stopped`, `Done`, `Exit 2`, a signal's
/// description): the projection's own `status_text`.
fn state_text(value: &Value) -> String {
  value
    .get("status_text")
    .and_then(Value::as_str)
    .unwrap_or("Running")
    .to_string()
}

/// The row's line: bash's announcement while the job runs, bash's `jobs` line
/// once it has stopped or finished.
fn header(value: &Value) -> String {
  let label = value
    .get("label")
    .and_then(Value::as_str)
    .map(|label| label.trim_start_matches('%'))
    .unwrap_or("?");
  let mark = match value.get("current").and_then(Value::as_str) {
    Some("+") => '+',
    Some("-") => '-',
    _ => ' ',
  };
  let command = value.get("command").and_then(Value::as_str).unwrap_or("");
  match (
    value.get("state").and_then(Value::as_str),
    value.get("pid").and_then(Value::as_u64),
  ) {
    (Some("running"), Some(pid)) => format!("[{label}] {pid}"),
    _ => format!("[{label}]{mark}  {:<27}{command}", state_text(value)),
  }
}

impl ShapeWidget for JobWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[JOB_V1]
  }

  fn render(
    &self,
    value: &Value,
    _width: u16,
    ctx: &RenderCtx,
    _reg: &ShapeRegistry,
  ) -> ShapeOutput {
    if value.get("command").is_none() {
      return ShapeOutput::diagnostic("  (job/v1: no `command`)");
    }
    let path = ctx.base_path.map(|base| format!("{base}/job"));
    let open = expanded(path.as_deref().and_then(|path| ctx.widget_state.get(path)));
    let marker = if open { "▾" } else { "▸" };
    let running = value.get("state").and_then(Value::as_str) == Some("running");
    let head = header(value);
    let head = if running {
      format!("{marker} {head}")
    } else {
      format!("{marker} {BOLD}{head}{RESET}")
    };
    let mut out = ShapeOutput {
      lines: vec![head],
      paths: vec![path],
      ..ShapeOutput::default()
    };
    if !open {
      return out;
    }
    let text = value
      .get("output")
      .and_then(|source| source.get("path"))
      .and_then(Value::as_str)
      .and_then(|path| ctx.resolver.resolve_text(path, OUTPUT_BYTES));
    let lines: Vec<&str> = text
      .as_deref()
      .map(|text| text.lines().collect())
      .unwrap_or_default();
    if lines.is_empty() {
      out.lines.push(format!("  {DIMMED}(no output){RESET}"));
      out.paths.push(None);
      return out;
    }
    let skipped = lines.len().saturating_sub(OUTPUT_LINES);
    if skipped > 0 {
      out
        .lines
        .push(format!("  {DIMMED}… {skipped} earlier lines{RESET}"));
      out.paths.push(None);
    }
    for line in &lines[skipped..] {
      out.lines.push(format!("  {line}"));
      out.paths.push(None);
    }
    out
  }

  fn on_event(
    &self,
    ev: &WidgetEvent,
    value: &Value,
    _reg: &ShapeRegistry,
  ) -> Option<WidgetAction> {
    // The value is the outer one, its `source` unresolved: the row's own
    // line is all that identifies it.
    let _ = value;
    if ev.rel_path != "job" {
      return None;
    }
    let toggles = match ev.event {
      Event::Key(key) => matches!(key.code, KeyCode::Enter | KeyCode::Char(' ')),
      Event::Mouse(Mouse::Down { .. }) => true,
      _ => false,
    };
    toggles.then(|| WidgetAction::State(json!({"expanded": !expanded(ev.state)})))
  }
}

#[cfg(test)]
mod tests {
  use std::collections::{HashMap, HashSet};

  use serde_json::json;
  use tento_tui_core::input::{Key, Mods};

  use super::*;
  use crate::FileSourceResolver;

  fn job(state: &str, status_text: &str, output: &std::path::Path) -> Value {
    json!({
      "shape": "job/v1",
      "datatype": "job/v1",
      "label": "%1",
      "current": "+",
      "pid": 4821,
      "state": state,
      "status_text": status_text,
      "command": "make build",
      "output": {"kind": "text", "path": output.to_str().unwrap()},
    })
  }

  fn render(value: &Value, state: &HashMap<String, Value>) -> ShapeOutput {
    let collapsed = HashSet::new();
    ShapeRegistry::core()
      .render(
        value,
        80,
        &RenderCtx {
          base_path: Some("turn:5"),
          collapsed: &collapsed,
          widget_state: state,
          resolver: &FileSourceResolver,
          depth: 0,
        },
      )
      .expect("renders")
  }

  fn plain(line: &str) -> String {
    line
      .replace(BOLD, "")
      .replace(RESET, "")
      .replace(DIMMED, "")
  }

  /// The row is bash's announcement while the job runs and bash's `jobs`
  /// line afterwards, and it is one addressable line.
  #[test]
  fn the_row_follows_the_job() {
    let none = HashMap::new();
    let out = std::path::Path::new("/nonexistent/job.out");
    let running = render(&job("running", "Running", out), &none);
    assert_eq!(running.paths, vec![Some("turn:5/job".to_string())]);
    assert_eq!(plain(&running.lines[0]), "▸ [1] 4821");
    let done = render(&job("succeeded", "Done", out), &none);
    assert_eq!(
      plain(&done.lines[0]),
      "▸ [1]+  Done                       make build"
    );
    let failed = render(&job("failed", "Exit 2", out), &none);
    assert!(
      plain(&failed.lines[0]).contains("Exit 2"),
      "{:?}",
      failed.lines
    );
    let stopped = render(&job("stopped", "Stopped", out), &none);
    assert!(
      plain(&stopped.lines[0]).contains("Stopped"),
      "{:?}",
      stopped.lines
    );
  }

  /// Output is hidden until the row is expanded, then shown inline below it
  /// (the newest lines), and hidden again when collapsed.
  #[test]
  fn expanding_shows_the_jobs_output_inline() {
    let dir = std::env::temp_dir().join(format!("tento-shapes-job-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("job.out");
    std::fs::write(
      &path,
      "compiling
linking
",
    )
    .unwrap();
    let value = job("running", "Running", &path);
    let mut state = HashMap::new();
    assert_eq!(
      render(&value, &state).lines.len(),
      1,
      "collapsed by default"
    );
    state.insert("turn:5/job".to_string(), json!({"expanded": true}));
    let open = render(&value, &state);
    let text: Vec<String> = open.lines.iter().map(|line| plain(line)).collect();
    assert_eq!(text, ["▾ [1] 4821", "  compiling", "  linking"]);
    assert_eq!(open.paths[1], None, "output lines stay unselectable");
    state.insert("turn:5/job".to_string(), json!({"expanded": false}));
    assert_eq!(render(&value, &state).lines.len(), 1);
    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn an_empty_or_missing_output_says_so() {
    let mut state = HashMap::new();
    state.insert("turn:5/job".to_string(), json!({"expanded": true}));
    let out = render(
      &job(
        "running",
        "Running",
        std::path::Path::new("/nonexistent/job.out"),
      ),
      &state,
    );
    assert_eq!(plain(&out.lines[1]), "  (no output)");
  }

  /// Enter, Space and a click on the row toggle it; other lines and keys
  /// defer to the host.
  #[test]
  fn enter_space_and_click_toggle_the_row() {
    let reg = ShapeRegistry::core();
    let value = job("running", "Running", std::path::Path::new("/nonexistent"));
    let key = |code| {
      Event::Key(Key {
        code,
        mods: Mods::default(),
      })
    };
    for event in [
      key(KeyCode::Enter),
      key(KeyCode::Char(' ')),
      Event::Mouse(Mouse::Down { row: 3, col: 2 }),
    ] {
      let Some(WidgetAction::State(state)) =
        reg.on_event(&value, "turn:5", "turn:5/job", &event, None)
      else {
        panic!("{event:?} toggles");
      };
      assert_eq!(state["expanded"], true);
      let Some(WidgetAction::State(state)) = reg.on_event(
        &value,
        "turn:5",
        "turn:5/job",
        &event,
        Some(&json!({"expanded": true})),
      ) else {
        panic!("{event:?} toggles back");
      };
      assert_eq!(state["expanded"], false);
    }
    assert!(
      reg
        .on_event(&value, "turn:5", "turn:5/job", &key(KeyCode::Left), None)
        .is_none()
    );
    assert!(
      reg
        .on_event(&value, "turn:5", "turn:5/other", &key(KeyCode::Enter), None)
        .is_none()
    );
  }
}
