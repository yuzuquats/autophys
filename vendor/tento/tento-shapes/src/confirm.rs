use serde_json::{Value, json};
use tento_term::confirm::{CONFIRM_V1, ConfirmBody};
use tento_term::{BOLD, DIMMED, RESET};
use tento_tui_core::input::{Event, KeyCode};

use crate::registry::{
  RenderCtx, ShapeOutput, ShapeRegistry, ShapeWidget, WidgetAction, WidgetEvent,
};

/// `confirm/v1` — one selectable line: a prompt and a button row. The first
/// interactive widget: Left/Right move the cursor (per-path view state,
/// host-held), Enter/Space submit the cursor button's control form through
/// the session's existing grammar. On the CLI the line renders statically.
///
/// Path scheme: the line is `<base>/confirm` (`<base>/confirm:<id>` with an
/// `id` — the first consumer of the reserved per-result id). Note the
/// widget claims Enter/Space on its own line, so turn-collapse on that one
/// line yields to the button; collapse stays on the turn header.
pub struct ConfirmWidget;

/// The line's path segment under the value's base.
fn seg(body: &ConfirmBody) -> String {
  match &body.id {
    Some(id) => format!("confirm:{id}"),
    None => "confirm".to_string(),
  }
}

fn cursor_of(state: Option<&Value>, buttons: usize) -> usize {
  state
    .and_then(|v| v.get("cursor"))
    .and_then(Value::as_u64)
    .map(|c| c as usize)
    .unwrap_or(0)
    .min(buttons.saturating_sub(1))
}

impl ShapeWidget for ConfirmWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[CONFIRM_V1]
  }

  fn render(
    &self,
    value: &Value,
    _width: u16,
    ctx: &RenderCtx,
    _reg: &ShapeRegistry,
  ) -> ShapeOutput {
    let Ok(body) = serde_json::from_value::<ConfirmBody>(value.clone()) else {
      return ShapeOutput::diagnostic("  (confirm/v1: malformed)");
    };
    if body.buttons.is_empty() {
      return ShapeOutput::diagnostic("  (confirm/v1: no buttons)");
    }
    let path = ctx.base_path.map(|b| format!("{b}/{}", seg(&body)));
    let cursor = cursor_of(
      path.as_deref().and_then(|p| ctx.widget_state.get(p)),
      body.buttons.len(),
    );
    // Cursor button bold, the rest dimmed — same width either way so the
    // line is stable under cursor movement.
    let buttons = body
      .buttons
      .iter()
      .enumerate()
      .map(|(i, b)| {
        if i == cursor {
          format!("[{BOLD}{}{RESET}]", b.label)
        } else {
          format!("[{DIMMED}{}{RESET}]", b.label)
        }
      })
      .collect::<Vec<_>>()
      .join(" ");
    ShapeOutput {
      lines: vec![format!("{}   {buttons}", body.prompt)],
      paths: vec![path],
      ..ShapeOutput::default()
    }
  }

  fn on_event(
    &self,
    ev: &WidgetEvent,
    value: &Value,
    _reg: &ShapeRegistry,
  ) -> Option<WidgetAction> {
    let body: ConfirmBody = serde_json::from_value(value.clone()).ok()?;
    if body.buttons.is_empty() || ev.rel_path != seg(&body) {
      return None;
    }
    let Event::Key(key) = ev.event else {
      return None;
    };
    let cursor = cursor_of(ev.state, body.buttons.len());
    match key.code {
      KeyCode::Left => Some(WidgetAction::State(
        json!({"cursor": cursor.saturating_sub(1)}),
      )),
      KeyCode::Right => Some(WidgetAction::State(
        json!({"cursor": (cursor + 1).min(body.buttons.len() - 1)}),
      )),
      KeyCode::Enter | KeyCode::Char(' ') => {
        Some(WidgetAction::Control(body.buttons[cursor].control.clone()))
      }
      _ => None,
    }
  }
}

#[cfg(test)]
mod tests {
  use std::collections::{HashMap, HashSet};

  use serde_json::json;
  use tento_tui_core::input::{Key, Mods};

  use super::*;
  use crate::FileSourceResolver;

  fn confirm_value() -> Value {
    json!({
      "shape": "confirm/v1",
      "prompt": "Deploy host-b?",
      "buttons": [
        {"label": "Deploy", "control": "(package.server-app deploy --fleet-id host-b)"},
        {"label": "Cancel", "control": "(deploy.cancel)"},
      ],
    })
  }

  fn key(code: KeyCode) -> Event {
    Event::Key(Key {
      code,
      mods: Mods::default(),
    })
  }

  /// The line is addressable at `<base>/confirm`; cursor state bolds the
  /// active button without changing the line's text content.
  #[test]
  fn renders_one_addressable_line_with_cursor_state() {
    let collapsed = HashSet::new();
    let mut state = HashMap::new();
    let reg = ShapeRegistry::core();

    let ctx = RenderCtx {
      base_path: Some("turn:5"),
      collapsed: &collapsed,
      widget_state: &state,
      resolver: &FileSourceResolver,
      depth: 0,
    };
    let out = reg.render(&confirm_value(), 80, &ctx).expect("renders");
    assert_eq!(out.paths, vec![Some("turn:5/confirm".to_string())]);
    assert!(out.lines[0].contains("Deploy host-b?"), "{}", out.lines[0]);
    assert!(
      out.lines[0].contains(&format!("[{BOLD}Deploy{RESET}]")),
      "default cursor on button 0: {}",
      out.lines[0]
    );

    state.insert("turn:5/confirm".to_string(), json!({"cursor": 1}));
    let ctx = RenderCtx {
      base_path: Some("turn:5"),
      collapsed: &collapsed,
      widget_state: &state,
      resolver: &FileSourceResolver,
      depth: 0,
    };
    let out = reg.render(&confirm_value(), 80, &ctx).expect("renders");
    assert!(
      out.lines[0].contains(&format!("[{BOLD}Cancel{RESET}]")),
      "cursor state moves the bold: {}",
      out.lines[0]
    );
  }

  /// Left/Right return `State` (host stores it); Enter returns the cursor
  /// button's full control form; other keys defer.
  #[test]
  fn events_move_cursor_and_submit_the_cursor_button() {
    let reg = ShapeRegistry::core();
    let v = confirm_value();

    let right = reg.on_event(&v, "turn:5", "turn:5/confirm", &key(KeyCode::Right), None);
    let Some(WidgetAction::State(s)) = right else {
      panic!("Right yields cursor state");
    };
    assert_eq!(s["cursor"], 1);

    let enter = reg.on_event(
      &v,
      "turn:5",
      "turn:5/confirm",
      &key(KeyCode::Enter),
      Some(&json!({"cursor": 1})),
    );
    let Some(WidgetAction::Control(form)) = enter else {
      panic!("Enter submits");
    };
    assert_eq!(form, "(deploy.cancel)");

    assert!(
      reg
        .on_event(&v, "turn:5", "turn:5/confirm", &key(KeyCode::Up), None)
        .is_none(),
      "unclaimed keys defer to the host"
    );
    assert!(
      reg
        .on_event(&v, "turn:5", "turn:5/other", &key(KeyCode::Enter), None)
        .is_none(),
      "other lines defer"
    );
  }

  /// An `id` lands in the path — several confirms in one turn keep
  /// separate cursor state.
  #[test]
  fn id_disambiguates_the_path() {
    let collapsed = HashSet::new();
    let state = HashMap::new();
    let v = json!({
      "shape": "confirm/v1",
      "prompt": "Sure?",
      "id": "deploy",
      "buttons": [{"label": "Yes", "control": "(y)"}],
    });
    let ctx = RenderCtx {
      base_path: Some("turn:5"),
      collapsed: &collapsed,
      widget_state: &state,
      resolver: &FileSourceResolver,
      depth: 0,
    };
    let out = ShapeRegistry::core().render(&v, 80, &ctx).expect("renders");
    assert_eq!(out.paths, vec![Some("turn:5/confirm:deploy".to_string())]);
    let act = ShapeRegistry::core().on_event(
      &v,
      "turn:5",
      "turn:5/confirm:deploy",
      &key(KeyCode::Enter),
      None,
    );
    assert!(matches!(act, Some(WidgetAction::Control(f)) if f == "(y)"));
  }

  /// A confirm nested in sections routes through `sec:<i>` recursion.
  #[test]
  fn sections_recurse_events_to_nested_confirms() {
    let v = json!({
      "shape": "sections/v1",
      "sections": [
        {"title": "Health", "value": {"shape": "table/v1", "columns": [{"header": "A"}], "rows": [["x"]]}},
        {"title": "Actions", "value": confirm_value()},
      ],
    });
    let reg = ShapeRegistry::core();
    let act = reg.on_event(
      &v,
      "turn:5",
      "turn:5/sec:1/confirm",
      &key(KeyCode::Enter),
      None,
    );
    let Some(WidgetAction::Control(form)) = act else {
      panic!("nested confirm fires");
    };
    assert_eq!(form, "(package.server-app deploy --fleet-id host-b)");

    assert!(
      reg
        .on_event(
          &v,
          "turn:5",
          "turn:5/sec:0/row:0",
          &key(KeyCode::Enter),
          None
        )
        .is_none(),
      "table rows stay host-handled (collapse/select)"
    );
  }
}
