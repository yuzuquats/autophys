//! `confirm/v1` — a one-line button-row render shape: a prompt and 2–N
//! buttons, each carrying the control form the session executes when the
//! button fires. The first interactive shape (proves the `on_event` widget
//! contract); serde types here, dispatch/rendering/eventing in the shape
//! registry (`tento-shapes`).

use serde::{Deserialize, Serialize};

/// The shape id for a `confirm/v1` turn-item.
pub const CONFIRM_V1: &str = "confirm/v1";

/// A shape-tagged confirm row. Build via [`ConfirmBody::new`].
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfirmBody {
  pub shape: String,
  pub prompt: String,
  /// Folded into the line path (`<base>/confirm:<id>`) so several confirms
  /// in one turn keep distinct cursor state. Optional — a lone confirm
  /// renders at `<base>/confirm`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub id: Option<String>,
  pub buttons: Vec<ConfirmButton>,
}

/// One button: its visible label and the FULL control form it submits
/// (e.g. `(package.server-app deploy --fleet-id host-b)`), dispatched exactly as
/// if the user typed it.
#[derive(Debug, Serialize, Deserialize)]
pub struct ConfirmButton {
  pub label: String,
  pub control: String,
}

impl ConfirmBody {
  pub fn new(prompt: impl Into<String>, buttons: Vec<ConfirmButton>) -> Self {
    ConfirmBody {
      shape: CONFIRM_V1.to_string(),
      prompt: prompt.into(),
      id: None,
      buttons,
    }
  }

  pub fn with_id(mut self, id: impl Into<String>) -> Self {
    self.id = Some(id.into());
    self
  }
}

impl ConfirmButton {
  pub fn new(label: impl Into<String>, control: impl Into<String>) -> Self {
    ConfirmButton {
      label: label.into(),
      control: control.into(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn confirm_body_tags_shape_and_round_trips() {
    let body = ConfirmBody::new(
      "Deploy host-b?",
      vec![
        ConfirmButton::new("Deploy", "(package.server-app deploy --fleet-id host-b)"),
        ConfirmButton::new("Cancel", "(deploy.cancel)"),
      ],
    )
    .with_id("deploy");
    let json = serde_json::to_value(&body).unwrap();
    assert_eq!(json["shape"], CONFIRM_V1);
    assert_eq!(json["buttons"][1]["label"], "Cancel");
    let back: ConfirmBody = serde_json::from_str(&json.to_string()).unwrap();
    assert_eq!(back.id.as_deref(), Some("deploy"));
    assert_eq!(back.buttons.len(), 2);
  }
}
