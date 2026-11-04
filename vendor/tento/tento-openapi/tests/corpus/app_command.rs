//! Copied from Lona `lona/so.lona/src/ai/app_command.rs` and
//! `lona/so.lona/src/ai/tools.rs` (`Proposal`, `Assignment`) at Lona
//! cbc44f384. Edits: both derives on each type; the `ToolParams` derive and
//! its `#[tool(description)]` attributes dropped (they do not touch serde
//! or the schema).
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[serde_with::skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AppCommand {
  ChangeTheme,
  ToggleDarkMode,
  ToggleSpotlight,
  RevealSettings,
  ShowCreateEventFormModal {
    title: Option<String>,
    date: Option<String>,
    #[serde(rename = "startTime")]
    start_time: Option<String>,
    #[serde(rename = "endTime")]
    end_time: Option<String>,
    description: Option<String>,
    location: Option<String>,
    #[serde(rename = "isAllDay")]
    is_all_day: Option<bool>,
    #[serde(rename = "autoSubmit")]
    auto_submit: Option<bool>,
  },
  ShowPomodoroApp,
  NavigateTo {
    key: String,
  },
  NavigateToSheet {
    #[serde(rename = "sheetKey")]
    sheet_key: Option<String>,
  },
  ShowTaskDetails {
    #[serde(rename = "taskId")]
    task_id: String,
  },
  ShowAllRows,
  ShowDocumentation {
    path: String,
    kind: Option<String>,
  },
  ShowSchedulingLink,
  ToggleDrawer,
  ShowChatSidebar,
  ShowPresentation,
  RevealPlanOptions,
  ToggleSettings,
  ShowSheetNullstate {
    #[serde(rename = "templateId")]
    template_id: Option<String>,
  },
  FocusSidebarSection {
    #[serde(rename = "sectionId")]
    section_id: String,
  },
  ShowEphemeralSheet {
    sheet: serde_json::Value,
    #[serde(rename = "anchorDate")]
    anchor_date: Option<String>,
  },
  SetEphemeralCells {
    cells: serde_json::Value,
  },
  InvalidateTasks,
  ShowAutoschedulePreview {
    proposals: Vec<Proposal>,
    #[serde(rename = "anchorDate")]
    anchor_date: Option<String>,
  },
  SetAutoschedulePreviewProposal {
    #[serde(rename = "proposalIndex")]
    proposal_index: usize,
  },
}

#[derive(Debug, Clone, Deserialize, serde::Serialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
  id: String,
  label: String,
  rationale: String,
  assignments: Vec<Assignment>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
  task_id: Uuid,
  #[serde(default)]
  display_id: Option<String>,
  #[serde(default)]
  title: Option<String>,
  scheduled_start: DateTime<Utc>,
  scheduled_end: DateTime<Utc>,
  #[serde(default)]
  rationale: Option<String>,
}
