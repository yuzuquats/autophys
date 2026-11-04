//! Copied from Lona `lona/lona-models/src/` at Lona cbc44f384: `task.rs`,
//! `sheet/cell_shapes.rs`, `sheet/new_sheet.rs`, and the types they use
//! (`rational.rs`, `time_scale.rs`, `task_status.rs`, `task_priority.rs`).
//! Edits: both derives on each type; diesel (`AsExpression`, `FromSqlRow`,
//! `#[diesel]`) and `validator` (`Validate`, `#[validate]`) dropped;
//! `deserialize_with = …` dropped (it changes parsing, not the schema);
//! impls dropped.
#![allow(dead_code)]

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize, Eq, PartialEq, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Rational {
  pub n: i32,
  pub d: i32,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TimeScale {
  Year,
  Month,
  Week,
  Day,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TimeScaleCustom {
  Year,
  Month,
  Week,
  Day,
  Custom,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
  Completed,
  InProgress,
  Planned,
  AutoScheduled,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskPriority {
  High,
  Medium,
  Low,
}

// ---- task.rs

#[skip_serializing_none]
#[derive(Clone, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttributes {
  pub title: Option<String>,

  pub description: Option<String>,
  pub status: Option<TaskStatus>,
  pub importance: Option<TaskPriority>,

  pub completed_at: Option<DateTime<Utc>>,
  pub due_date: Option<DateTime<Utc>>,

  pub position: Option<Rational>,
  pub event_id: Option<Uuid>,
  pub created_at: Option<DateTime<Utc>>,

  pub scheduled_start: Option<DateTime<Utc>>,
  pub scheduled_end: Option<DateTime<Utc>>,

  pub display_number: Option<i32>,
  pub display_id: Option<String>,
}

/// Full task with a caller-supplied id (the `POST /api/tasks` body, importers).
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
pub struct TaskInsert {
  pub id: Uuid,
  #[serde(flatten)]
  pub inner: TaskAttributes,
}

/// Canonical task object — id + attributes. Decoded from a `task.v1` cell.
#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Task {
  pub id: Uuid,
  #[serde(flatten)]
  pub inner: TaskAttributes,
  pub user_id: String,
}

/// Partial task update (`PATCH /api/tasks/{id}` body). `Some(inner)` sets the
/// field (`Some(None)` clears nullable fields); `None` leaves it unchanged.
#[derive(Default, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
pub struct TaskUpdateAttributes {
  pub title: Option<String>,

  pub description: Option<Option<String>>,
  pub status: Option<Option<TaskStatus>>,
  pub importance: Option<Option<TaskPriority>>,

  pub completed_at: Option<Option<DateTime<Utc>>>,
  pub due_date: Option<Option<DateTime<Utc>>>,

  pub position: Option<Option<Rational>>,

  pub event_id: Option<Option<Uuid>>,

  pub scheduled_start: Option<Option<DateTime<Utc>>>,
  pub scheduled_end: Option<Option<DateTime<Utc>>>,
}

// ---- sheet/cell_shapes.rs

/// Canonical task object stored in `task.v1` cells.
#[derive(Clone, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskCell {
  pub id: Uuid,
  #[serde(flatten)]
  pub inner: TaskAttributes,
}

/// Canonical day-level weather object stored in `weather.v1` cells.
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct WeatherCell {
  pub date: NaiveDate,
  pub day: serde_json::Value,
  pub astro: Option<serde_json::Value>,
  pub hours: Vec<serde_json::Value>,
  pub source: String,
  pub stored_at: DateTime<Utc>,
}

/// Canonical availability slot object stored in `slot.v1` cells.
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SlotCell {
  pub id: String,
  pub start: DateTime<Utc>,
  pub end: DateTime<Utc>,
  pub booked_by: Option<String>,
}

/// Canonical timezone object stored in `timezone.v1` cells.
///
/// Minimal today — timezone rendering is driven by the row's `tz`
/// attribute. The cell payload is reserved for future per-period data
/// such as UTC-offset / DST transitions.
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimezoneCell {
  /// IANA timezone name (e.g. `"America/New_York"`).
  pub tz: String,
  /// Reserved for future UTC-offset transitions within the cell period.
  pub transitions: Option<Vec<serde_json::Value>>,
}

/// Canonical sync-log entry stored in `logs.v1` cells. Appended to
/// provider rows (e.g. weather) to surface sync activity on the row.
#[skip_serializing_none]
#[derive(Debug, Clone, Serialize, Deserialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogsCell {
  /// When the logged event occurred.
  pub at: DateTime<Utc>,
  /// Severity / outcome (e.g. `"info"`, `"warn"`, `"error"`, `"ok"`).
  pub level: String,
  /// Human-readable log message.
  pub message: String,
  /// Originating subsystem (e.g. `"weather"`).
  pub source: Option<String>,
}

// ---- sheet/new_sheet.rs

#[derive(Deserialize, Serialize, tento_openapi::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewUserSheet {
  /// Optional client-supplied UUID. When present, the server uses
  /// this id verbatim instead of generating one — enables the
  /// ephemeral→server promote flow to preserve handle identity
  /// (`handle.id` doesn't flip across promotion). Conflicts on the
  /// `spreadsheets.id` PRIMARY KEY surface as a DB-level error.
  /// When absent, server generates a v4 UUID as before.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub id: Option<Uuid>,
  pub position: Option<Rational>,
  #[serde(flatten)]
  pub inner: NewSheet,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub rows: Option<Vec<NewRowWithAttributes>>,
}

/// Common row definition fields shared across API and template types
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RowDef {
  pub label: Option<String>,
  pub attributes: Option<serde_json::Value>,
  pub formula: Option<String>,
  pub height_px: Option<i32>,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewRowWithAttributes {
  #[serde(rename = "type")]
  pub _type: String,
  pub position: Option<Rational>,
  pub icon: Option<String>,
  pub client_id: Option<String>,
  pub time_scale: Option<TimeScaleCustom>,
  /// Optional reserved/lookup key (e.g. `:~lona:tasks`, `:~weather`).
  /// When present, the server:
  ///
  /// 1. Pre-flights `(owner_id, lookup_key)` against
  ///    `spreadsheet_rows` — if a row already exists under this
  ///    owner with this lookup key, the whole POST fails.
  /// 2. Persists the new row with `spreadsheet_rows.lookup_key`
  ///    set so subsequent reads resolve it correctly.
  ///
  /// Used by the client's ephemeral-sheet promote flow (reserved
  /// sheets like `:~lona:home` whose row templates carry lookup keys
  /// naming server-side row types).
  #[serde(default)]
  pub lookup_key: Option<String>,
  #[serde(flatten)]
  pub row_def: RowDef,
}

/// Template row definition (embedded in static JSON templates)
#[derive(Serialize, Deserialize, tento_openapi::ToSchema, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRowDef {
  pub id: String,
  #[serde(rename = "type")]
  pub _type: Option<String>,
  #[serde(default)]
  pub lookup_key: Option<String>,
  pub data: Vec<serde_json::Value>,
  pub time_scale: TimeScaleCustom,
  pub is_system_row: Option<bool>,
  #[serde(flatten)]
  pub row_def: RowDef,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
pub struct NewUserSheetWithRows {
  #[serde(flatten)]
  pub sheet: NewUserSheet,
  pub rows: Vec<NewRowWithAttributes>,
}

#[derive(Serialize, Deserialize, tento_openapi::ToSchema)]
pub struct NewSheet {
  pub title: Option<String>,
  pub description: Option<String>,
  pub width: Option<i32>,
  pub time_scale: Option<TimeScale>,
  /// Canonical lookup key (e.g. `:~lona:home`). Sole address for
  /// reserved sheets.
  #[serde(default)]
  pub lookup_key: Option<String>,
}
