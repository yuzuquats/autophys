//! Result shapes: a native returns plain data or a shape wrapper.
//!
//! `Table<T>`, `Kv<T>`, `List<T>`, `Sections<T>` and `Term` are
//! `#[serde(transparent)]`: the data — what `--json` prints and what a lisp
//! caller receives — is the inner value, unchanged. Only the human render
//! boundary asks the wrapper for its shape ([`Shape::render_data`]), which maps
//! that same data to `table/v1`, `kv/v1`, `list/v1`, `sections/v1` or
//! `term.block/v1` using the inner type's [`Schema`] and its `#[view(…)]` hints.
//!
//! ```ignore
//! #[command(name = "ls", description = "List entries")]
//! fn ls(_: Info, args: LsArgs) -> Result<Table<Entry>> { … }
//! ```
//!
//! A command returning `serde_json::Value` (or any type without a shape) keeps
//! the generic rendering, and a value carrying its own `shape`/`datatype` field
//! is never re-shaped. `#[derive(Shape)]` on an untagged enum of wrappers gives
//! one shape per case.
//!
//! A host that mounts a plugin bundle sees only the bundle's `--json` data and
//! the `result` its manifest declares ([`ResultDoc`]). It notes each mounted
//! result with [`note_declared_result`]; the display that draws a value for a
//! person asks [`take_declared_view`] for the declared shape. The data a Lisp
//! caller or `--json` receives is never touched.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::marker::PhantomData;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tento_term::{Align, CellFormat, Column, Style, project_rows};

use crate::schema::{FieldDesc, Schema, TypeDesc, ViewAlign};

pub use tento_lisp_macros::Shape;

/// `command.doc/v1` `result`: the declared result type, and the shape (plus
/// columns) the human renderer applies to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResultDoc {
  #[serde(rename = "type")]
  pub ty: TypeDesc,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub shape: Option<String>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub columns: Vec<ColumnDoc>,
  /// An enum of wrappers: one entry per case, in declaration order.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub cases: Vec<ResultDoc>,
}

/// One rendered column (or kv field) of a declared result shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnDoc {
  pub key: String,
  pub header: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub align: Option<ViewAlign>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub format: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub section: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub style: Option<String>,
}

impl ResultDoc {
  /// A plain (unshaped) result of type `ty`.
  pub fn plain(ty: TypeDesc) -> Self {
    ResultDoc {
      ty,
      shape: None,
      columns: Vec::new(),
      cases: Vec::new(),
    }
  }
  fn shaped(ty: TypeDesc, shape: &str, columns: Vec<ColumnDoc>) -> Self {
    ResultDoc {
      ty,
      shape: Some(shape.to_string()),
      columns,
      cases: Vec::new(),
    }
  }
  /// An enum of wrappers. The type is `any`: each case documents its own.
  pub fn union(cases: Vec<ResultDoc>) -> Self {
    ResultDoc {
      ty: TypeDesc::Any,
      shape: None,
      columns: Vec::new(),
      cases,
    }
  }

  /// Does this result declare a shape to draw (itself or one of its cases)?
  pub fn is_shaped(&self) -> bool {
    self.shape.is_some() || self.cases.iter().any(ResultDoc::is_shaped)
  }

  /// The shape this declared result draws `data` as — what the command's own
  /// one-shot CLI prints. `None` when the data already names its own shape,
  /// the result declares none, or the data lacks the declared form. An enum of
  /// wrappers renders through its first case that fits, as `#[derive(Shape)]`
  /// does.
  pub fn render(&self, data: &Value) -> Option<Value> {
    if carries_own_shape(data) {
      return None;
    }
    self.render_declared(data)
  }

  fn render_declared(&self, data: &Value) -> Option<Value> {
    let Some(shape) = self.shape.as_deref() else {
      return self.cases.iter().find_map(|case| case.render_declared(data));
    };
    match shape {
      tento_term::table::TABLE_V1 => match &self.ty {
        TypeDesc::List { of } => table_value(of, data),
        _ => None,
      },
      tento_shapes::KV_V1 => kv_value(&self.ty, data),
      tento_term::SECTIONS_V1 => sections_value(&self.ty, data),
      tento_shapes::LIST_V1 => data
        .as_array()
        .map(|items| json!({ "shape": tento_shapes::LIST_V1, "items": items })),
      tento_shapes::TERM_BLOCK_V1 => term_value(data),
      _ => None,
    }
  }
}

/// How many mounted results wait for a display at most. A Lisp loop that calls
/// a mounted command and draws nothing keeps only the latest few.
const DECLARED_PENDING: usize = 8;

thread_local! {
  /// Mounted results whose command declares a shape, newest last, until the
  /// next display takes them ([`take_declared_view`]).
  static DECLARED: RefCell<VecDeque<(Value, ResultDoc)>> = const { RefCell::new(VecDeque::new()) };
}

/// Note that `data` is what a mounted command declaring `doc` just returned.
/// The loader calls this (tento-app, for a bundle's oneshot result); `data`
/// itself is unchanged and is still what Lisp and `--json` receive. A result
/// that names its own shape, or a command that declares none, is not noted.
pub fn note_declared_result(data: &Value, doc: &ResultDoc) {
  if !doc.is_shaped() || carries_own_shape(data) {
    return;
  }
  DECLARED.with(|pending| {
    let mut pending = pending.borrow_mut();
    if pending.len() == DECLARED_PENDING {
      pending.pop_front();
    }
    pending.push_back((data.clone(), doc.clone()));
  });
}

/// The declared shape of a value about to be drawn for a person: when `data`
/// equals a result a mounted command returned since the last display, that
/// command's declared `result.shape` applied to it ([`ResultDoc::render`]).
/// Every call takes all pending results, matched or not, so an equal value
/// drawn later from elsewhere is never dressed in a stale declaration. A value
/// built from a result (filtered, mapped) is not that result and draws as
/// itself.
pub fn take_declared_view(data: &Value) -> Option<Value> {
  let pending = DECLARED.with(|pending| std::mem::take(&mut *pending.borrow_mut()));
  if pending.is_empty() || carries_own_shape(data) {
    return None;
  }
  pending
    .iter()
    .rev()
    .find(|(noted, _)| noted == data)
    .and_then(|(_, doc)| doc.render(data))
}

/// A presentation for a result type: the shape it renders as, computed from the
/// plain data alone so the data itself never changes.
pub trait Shape {
  /// The declared result: data type, shape tag, columns.
  fn result_doc() -> ResultDoc;
  /// Map plain data (this type's serialized form) to a shape value; `None` when
  /// the data does not have the form this shape renders.
  fn render_data(data: &Value) -> Option<Value>;
  /// The shape value for a typed value.
  fn render(&self) -> Value
  where
    Self: Serialize,
  {
    let data = serde_json::to_value(self).unwrap_or(Value::Null);
    Self::render_data(&data).unwrap_or(data)
  }
}

/// Is `data` a value that already names its own presentation? Those keep
/// rendering exactly as before; a declared shape never overrides them.
pub fn carries_own_shape(data: &Value) -> bool {
  data.get("shape").is_some() || data.get("datatype").is_some()
}

macro_rules! transparent_wrapper {
  ($(#[$doc:meta])* $name:ident($inner:ty)) => {
    $(#[$doc])*
    #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
    #[serde(transparent)]
    pub struct $name<T>(pub $inner);

    impl<T> std::ops::Deref for $name<T> {
      type Target = $inner;
      fn deref(&self) -> &$inner {
        &self.0
      }
    }

    impl<T> std::ops::DerefMut for $name<T> {
      fn deref_mut(&mut self) -> &mut $inner {
        &mut self.0
      }
    }

    impl<T> From<$inner> for $name<T> {
      fn from(inner: $inner) -> Self {
        $name(inner)
      }
    }
  };
}

transparent_wrapper!(
  /// A list of records rendered as `table/v1`: one column per field of `T`
  /// (`#[view(header/align/format/skip)]` shape them). Data: the bare list.
  Table(Vec<T>)
);
transparent_wrapper!(
  /// A list rendered as `list/v1`, one item per line. Data: the bare list.
  List(Vec<T>)
);
transparent_wrapper!(
  /// One record rendered as `kv/v1` aligned `key   value` lines. Data: the record.
  Kv(T)
);
transparent_wrapper!(
  /// One record rendered as `sections/v1`, grouped by `#[view(section = "…")]`.
  /// Data: the record.
  Sections(T)
);

impl<T> FromIterator<T> for Table<T> {
  fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
    Table(iter.into_iter().collect())
  }
}

impl<T> FromIterator<T> for List<T> {
  fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
    List(iter.into_iter().collect())
  }
}

/// Preformatted text rendered as `term.block/v1`, one row per line. Data: the
/// string.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Term(pub String);

impl From<String> for Term {
  fn from(s: String) -> Self {
    Term(s)
  }
}

impl From<&str> for Term {
  fn from(s: &str) -> Self {
    Term(s.to_string())
  }
}

// A wrapper's data model is its inner value's, so wrappers compose as fields.
impl<T: Schema> Schema for Table<T> {
  fn schema() -> TypeDesc {
    TypeDesc::list(T::schema())
  }
}
impl<T: Schema> Schema for List<T> {
  fn schema() -> TypeDesc {
    TypeDesc::list(T::schema())
  }
}
impl<T: Schema> Schema for Kv<T> {
  fn schema() -> TypeDesc {
    T::schema()
  }
}
impl<T: Schema> Schema for Sections<T> {
  fn schema() -> TypeDesc {
    T::schema()
  }
}
impl Schema for Term {
  fn schema() -> TypeDesc {
    TypeDesc::String
  }
}

/// The visible fields of a record type, in declaration order.
fn visible_fields(ty: &TypeDesc) -> Vec<&FieldDesc> {
  ty.record_fields()
    .map(|fields| fields.iter().filter(|f| !f.view.skip).collect())
    .unwrap_or_default()
}

/// A field's header: its `#[view(header = …)]`, else [`default_header`].
fn header_of(field: &FieldDesc) -> String {
  field
    .view
    .header
    .clone()
    .unwrap_or_else(|| default_header(&field.name))
}

/// The header a field gets unasked: its name, lowercase, `_` as a space
/// (`items_ok` → `items ok`) — the house style every rendered plugin uses.
pub fn default_header(name: &str) -> String {
  name.replace('_', " ").to_lowercase()
}

fn column_doc(field: &FieldDesc) -> ColumnDoc {
  ColumnDoc {
    key: field.name.clone(),
    header: header_of(field),
    align: field.view.align,
    format: field.view.format.clone(),
    section: field.view.section.clone(),
    style: field.view.style.clone(),
  }
}

fn cell_format(field: &FieldDesc) -> CellFormat {
  field
    .view
    .format
    .as_deref()
    .and_then(CellFormat::from_name)
    .unwrap_or_default()
}

fn now_ms() -> i64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

/// The cell a raw value draws as when it is an enum case carrying a view:
/// its label (else its serde name), painted with its style (else the field's).
/// `None` for any other value — the caller's cell stands.
fn case_cell(ty: &TypeDesc, field_style: Option<&str>, raw: Option<&Value>) -> Option<tento_term::Cell> {
  let case = raw?.as_str()?;
  let view = ty.case_view(case)?;
  let text = view.label.clone().unwrap_or_else(|| case.to_string());
  let style = view
    .style
    .as_deref()
    .or(field_style)
    .map(Style::from_wire)
    .unwrap_or(Style::None);
  Some(tento_term::Cell::new(text, style))
}

/// The dimmed style of a label column (and, with lowercase headers, of every
/// generated table's header row): the house style.
const HEADER_STYLE: &str = "dimmed";

/// Is `ty` a list of scalars (looking through `option<…>`)? It draws as one
/// cell or line, its items joined by `, `.
fn is_scalar_list(ty: &TypeDesc) -> bool {
  match ty {
    TypeDesc::List { of } => matches!(
      **of,
      TypeDesc::String | TypeDesc::Bool | TypeDesc::S64 | TypeDesc::U64 | TypeDesc::F64 | TypeDesc::Enum { .. }
    ),
    TypeDesc::Option { of } => is_scalar_list(of),
    _ => false,
  }
}

/// A list of scalars as one text, `a, b, c` (enum cases by their label);
/// `-` for an empty list, as for a missing value. `None` when `value` is not
/// such a list.
fn joined_text(ty: &TypeDesc, value: Option<&Value>) -> Option<String> {
  if !is_scalar_list(ty) {
    return None;
  }
  let item_ty = match ty {
    TypeDesc::Option { of } => of.as_ref(),
    other => other,
  };
  let TypeDesc::List { of: item_ty } = item_ty else {
    return None;
  };
  let items = value?.as_array()?;
  let texts = items
    .iter()
    .map(|item| match item {
      Value::String(s) => Some(
        item_ty
          .case_view(s)
          .and_then(|view| view.label.clone())
          .unwrap_or_else(|| s.clone()),
      ),
      Value::Number(n) => Some(n.to_string()),
      Value::Bool(b) => Some(b.to_string()),
      _ => None,
    })
    .collect::<Option<Vec<String>>>()?;
  Some(if texts.is_empty() { "-".to_string() } else { texts.join(", ") })
}

/// A field's display text, honoring its `format`; an enum case with a view
/// shows its label (`kv/v1` cannot paint it), a list of scalars its items.
fn field_text(field: &FieldDesc, value: Option<&Value>) -> Value {
  if let Some(cell) = case_cell(&field.ty, None, value) {
    return json!(cell.plain_text());
  }
  if let Some(text) = joined_text(&field.ty, value) {
    return json!(text);
  }
  match value {
    Some(Value::Null) | None => json!(""),
    Some(v @ (Value::Object(_) | Value::Array(_))) => v.clone(),
    Some(v) if field.view.format.is_none() => v.clone(),
    Some(v) => match tento_term::format_cell(Some(v), cell_format(field), now_ms()) {
      tento_term::Cell::Styled { text, .. } | tento_term::Cell::Raw(text) => json!(text),
    },
  }
}

/// `table/v1` for a list of records of type `ty`; `None` when `data` is not a
/// list of objects (a record schema) or not a list at all.
pub fn table_value(ty: &TypeDesc, data: &Value) -> Option<Value> {
  let rows = data.as_array()?;
  let fields = visible_fields(ty);
  let mut table = if ty.record_fields().is_some() {
    if !rows.iter().all(Value::is_object) {
      return None;
    }
    let columns: Vec<Column> = fields
      .iter()
      .map(|field| {
        let mut column = Column::new(header_of(field)).key(field.name.clone());
        if let Some(format) = field.view.format.as_deref().and_then(CellFormat::from_name) {
          column = column.format(format);
        }
        if field.view.align == Some(ViewAlign::Right) {
          column = column.align(Align::Right);
        }
        if let Some(style) = field.view.style.as_deref() {
          column = column.style(Style::from_wire(style));
        }
        column
      })
      .collect();
    let mut cells = project_rows(&columns, rows, now_ms());
    for (record, row) in rows.iter().zip(cells.iter_mut()) {
      for (field, cell) in fields.iter().zip(row.iter_mut()) {
        let raw = record.get(&field.name);
        if let Some(styled) = case_cell(&field.ty, field.view.style.as_deref(), raw) {
          *cell = styled;
        } else if let Some(text) = joined_text(&field.ty, raw) {
          *cell = tento_term::Cell::plain(text);
        }
      }
    }
    let mut table = tento_term::Table::new(columns);
    table.rows = cells;
    table
  } else {
    // A list of scalars: one `value` column.
    let columns = vec![Column::new("value").key("value")];
    let records: Vec<Value> = rows.iter().map(|v| json!({ "value": v })).collect();
    let mut cells = project_rows(&columns, &records, now_ms());
    for (raw, row) in rows.iter().zip(cells.iter_mut()) {
      if let (Some(styled), Some(cell)) = (case_cell(ty, None, Some(raw)), row.first_mut()) {
        *cell = styled;
      }
    }
    let mut table = tento_term::Table::new(columns);
    table.rows = cells;
    table
  };
  table.header_style = Some(Style::from_wire(HEADER_STYLE));
  keep_short_columns(&mut table);
  table.highlighted_rows.clear();
  let mut value = serde_json::to_value(table.into_body()).ok()?;
  drop_nulls(&mut value);
  if let Some(columns) = value.get_mut("columns").and_then(Value::as_array_mut) {
    columns.iter_mut().for_each(drop_nulls);
  }
  Some(value)
}

/// The widest a column can be and still never truncate when the terminal is
/// narrow: names, states, counts. Wider columns (sentences, paths) give way.
const SHORT_COLUMN: usize = 16;

/// A generated table has no per-column widths, so when it does not fit,
/// tento-term shrinks every column alike and a host name ends up `rwc…`
/// beside an untouched sentence. Pin each short column at its natural width
/// so only the long ones shrink.
fn keep_short_columns(table: &mut tento_term::Table) {
  for (i, column) in table.columns.iter_mut().enumerate() {
    let natural = table
      .rows
      .iter()
      .filter_map(|row| row.get(i))
      .map(tento_term::Cell::width)
      .chain(std::iter::once(tento_term::visual_width(&column.header)))
      .max()
      .unwrap_or(0);
    if natural <= SHORT_COLUMN {
      column.min_width = column.min_width.max(natural);
    }
  }
}

/// Remove an object's null members: unset layout options (`title`,
/// `max_width`) serialize as JSON null, which a reader of the shape would
/// otherwise take for a value.
fn drop_nulls(value: &mut Value) {
  if let Some(object) = value.as_object_mut() {
    object.retain(|_, v| !v.is_null());
  }
}

/// `kv/v1` for one record of type `ty`; `None` when `data` is not an object.
pub fn kv_value(ty: &TypeDesc, data: &Value) -> Option<Value> {
  let obj = data.as_object()?;
  let fields = visible_fields(ty);
  let mut out = Map::new();
  if fields.is_empty() {
    out.extend(obj.clone());
  } else {
    for field in fields {
      out.insert(header_of(field), field_text(field, obj.get(&field.name)));
    }
  }
  Some(json!({ "shape": tento_shapes::KV_V1, "fields": out }))
}

/// Is `ty` a record or a list of records (looking through `option<…>`) — a
/// field that draws as its own section rather than as a label/value line? A
/// list of scalars is a line.
fn is_block(ty: &TypeDesc) -> bool {
  match ty {
    TypeDesc::Record { .. } => true,
    TypeDesc::List { .. } => !is_scalar_list(ty),
    TypeDesc::Option { of } => is_block(of),
    _ => false,
  }
}

/// A scalar field's value cell in a label/value block: an enum case's view,
/// else its text painted with the field's style; a missing value is `-`, as
/// in a table.
fn field_cell(field: &FieldDesc, value: Option<&Value>) -> Value {
  let style = field.view.style.as_deref();
  if let Some(cell) = case_cell(&field.ty, style, value) {
    return serde_json::to_value(cell).unwrap_or(Value::Null);
  }
  let text = match field_text(field, value) {
    Value::String(s) if s.is_empty() => "-".to_string(),
    Value::String(s) => s,
    other => other.to_string(),
  };
  match style {
    Some(style) => json!({ "text": text, "style": style }),
    None => json!(text),
  }
}

/// Label/value lines with no header row: a dimmed label column and the value
/// column, in field order. A `table/v1`, not `kv/v1`, because only a table
/// paints a styled value and keeps the fields' order.
fn fields_table(rows: Vec<(String, Value)>) -> Value {
  let rows: Vec<Value> = rows.into_iter().map(|(label, value)| json!([label, value])).collect();
  json!({
    "shape": tento_term::table::TABLE_V1,
    "header_rule": false,
    "gap": "  ",
    "columns": [
      { "header": "", "priority": 0, "style": HEADER_STYLE },
      { "header": "", "priority": 0 },
    ],
    "rows": rows,
  })
}

/// `sections/v1` for one record of type `ty`: scalar fields (and lists of
/// scalars) grouped into a label/value block per `section` (untitled first);
/// each record or list-of-records field becomes its own titled section (a list
/// renders as a table, a record as label/value lines), and one that is absent,
/// null or an empty list is left out.
pub fn sections_value(ty: &TypeDesc, data: &Value) -> Option<Value> {
  let obj = data.as_object()?;
  let mut groups: Vec<(Option<String>, Vec<(String, Value)>)> = Vec::new();
  let mut blocks: Vec<Value> = Vec::new();
  for field in visible_fields(ty) {
    let value = obj.get(&field.name);
    let empty = match value {
      None | Some(Value::Null) => true,
      Some(Value::Array(items)) => items.is_empty(),
      Some(_) => false,
    };
    let empty_list = matches!(value, Some(Value::Array(items)) if items.is_empty());
    if (is_block(&field.ty) && empty) || empty_list {
      continue;
    }
    if let Some(v @ (Value::Object(_) | Value::Array(_))) = value.filter(|_| !is_scalar_list(&field.ty)) {
      let rendered = match &field.ty {
        TypeDesc::List { of } => table_value(of, v).unwrap_or_else(|| v.clone()),
        TypeDesc::Option { of } if matches!(**of, TypeDesc::List { .. }) => match &**of {
          TypeDesc::List { of } => table_value(of, v).unwrap_or_else(|| v.clone()),
          _ => v.clone(),
        },
        record if record.record_fields().is_some() => match v.as_object() {
          Some(inner) => fields_table(
            visible_fields(record)
              .into_iter()
              .map(|f| (header_of(f), field_cell(f, inner.get(&f.name))))
              .collect(),
          ),
          None => v.clone(),
        },
        _ => v.clone(),
      };
      let title = field
        .view
        .section
        .clone()
        .unwrap_or_else(|| header_of(field));
      blocks.push(json!({ "title": title, "value": rendered }));
      continue;
    }
    let section = field.view.section.clone();
    let line = (header_of(field), field_cell(field, value));
    match groups.iter_mut().find(|(title, _)| *title == section) {
      Some((_, fields)) => fields.push(line),
      None => groups.push((section, vec![line])),
    }
  }
  // Untitled scalars lead; titled groups and block sections follow in order.
  groups.sort_by_key(|(title, _)| title.is_some());
  let mut sections: Vec<Value> = groups
    .into_iter()
    .map(|(title, fields)| {
      let value = fields_table(fields);
      match title {
        Some(title) => json!({ "title": title, "value": value }),
        None => json!({ "value": value }),
      }
    })
    .collect();
  sections.extend(blocks);
  Some(json!({ "shape": tento_term::SECTIONS_V1, "sections": sections }))
}

/// `term.block/v1`, one row per line of `data` (a string).
pub fn term_value(data: &Value) -> Option<Value> {
  let text = data.as_str()?;
  let rows: Vec<Value> = text
    .lines()
    .map(|line| json!({ "spans": [{ "text": line }], "wrap": "none" }))
    .collect();
  Some(json!({ "shape": tento_shapes::TERM_BLOCK_V1, "rows": rows }))
}

fn columns_of(ty: &TypeDesc) -> Vec<ColumnDoc> {
  visible_fields(ty).into_iter().map(column_doc).collect()
}

impl<T: Schema> Shape for Table<T> {
  fn result_doc() -> ResultDoc {
    let row = T::schema();
    let columns = columns_of(&row);
    ResultDoc::shaped(TypeDesc::list(row), tento_term::table::TABLE_V1, columns)
  }
  fn render_data(data: &Value) -> Option<Value> {
    table_value(&T::schema(), data)
  }
}

impl<T: Schema> Shape for List<T> {
  fn result_doc() -> ResultDoc {
    ResultDoc::shaped(
      TypeDesc::list(T::schema()),
      tento_shapes::LIST_V1,
      Vec::new(),
    )
  }
  fn render_data(data: &Value) -> Option<Value> {
    let items = data.as_array()?;
    Some(json!({ "shape": tento_shapes::LIST_V1, "items": items }))
  }
}

impl<T: Schema> Shape for Kv<T> {
  fn result_doc() -> ResultDoc {
    let ty = T::schema();
    let columns = columns_of(&ty);
    ResultDoc::shaped(ty, tento_shapes::KV_V1, columns)
  }
  fn render_data(data: &Value) -> Option<Value> {
    kv_value(&T::schema(), data)
  }
}

impl<T: Schema> Shape for Sections<T> {
  fn result_doc() -> ResultDoc {
    let ty = T::schema();
    let columns = columns_of(&ty);
    ResultDoc::shaped(ty, tento_term::SECTIONS_V1, columns)
  }
  fn render_data(data: &Value) -> Option<Value> {
    sections_value(&T::schema(), data)
  }
}

impl Shape for Term {
  fn result_doc() -> ResultDoc {
    ResultDoc::shaped(TypeDesc::String, tento_shapes::TERM_BLOCK_V1, Vec::new())
  }
  fn render_data(data: &Value) -> Option<Value> {
    term_value(data)
  }
}

/// The `#[command]` result probe: picks, at the macro's expansion site, the
/// richest description the concrete result type offers — a [`Shape`], else a
/// [`Schema`], else nothing (the type keeps today's generic rendering). This is
/// autoref specialization; it needs no bound on the command's return type.
#[doc(hidden)]
pub mod __probe {
  use super::*;

  pub struct Probe<R: ?Sized>(PhantomData<fn() -> PhantomData<R>>);

  impl<R: ?Sized> Probe<R> {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
      Probe(PhantomData)
    }
  }

  pub trait ViaShape {
    fn result_doc(&self) -> Option<ResultDoc>;
    fn render_result(&self, data: &Value) -> Option<Value>;
  }
  impl<R: Shape> ViaShape for &&Probe<R> {
    fn result_doc(&self) -> Option<ResultDoc> {
      Some(R::result_doc())
    }
    fn render_result(&self, data: &Value) -> Option<Value> {
      if carries_own_shape(data) {
        return None;
      }
      R::render_data(data)
    }
  }

  pub trait ViaSchema {
    fn result_doc(&self) -> Option<ResultDoc>;
    fn render_result(&self, data: &Value) -> Option<Value>;
  }
  impl<R: Schema + ?Sized> ViaSchema for &Probe<R> {
    fn result_doc(&self) -> Option<ResultDoc> {
      // Untyped JSON declares nothing worth recording.
      let ty = R::schema();
      (ty != TypeDesc::Any).then(|| ResultDoc::plain(ty))
    }
    fn render_result(&self, _data: &Value) -> Option<Value> {
      None
    }
  }

  pub trait ViaPlain {
    fn result_doc(&self) -> Option<ResultDoc>;
    fn render_result(&self, data: &Value) -> Option<Value>;
  }
  impl<R: ?Sized> ViaPlain for Probe<R> {
    fn result_doc(&self) -> Option<ResultDoc> {
      None
    }
    fn render_result(&self, _data: &Value) -> Option<Value> {
      None
    }
  }

  /// The argument-field twin: a field's [`TypeDesc`] when its type has a
  /// [`Schema`], else `None` (the legacy `type` token still describes it).
  pub trait FieldViaSchema {
    fn field_type(&self) -> Option<TypeDesc>;
  }
  impl<R: Schema + ?Sized> FieldViaSchema for &Probe<R> {
    fn field_type(&self) -> Option<TypeDesc> {
      Some(R::schema())
    }
  }
  pub trait FieldViaPlain {
    fn field_type(&self) -> Option<TypeDesc>;
  }
  impl<R: ?Sized> FieldViaPlain for Probe<R> {
    fn field_type(&self) -> Option<TypeDesc> {
      None
    }
  }
}

#[cfg(test)]
#[path = "shape_tests.rs"]
mod tests;
