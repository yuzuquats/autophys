//! Shape wrappers end to end: a `#[command]` returning `Table<Entry>` keeps its
//! `--json`/lisp data the bare list while its human render is `table/v1` with
//! the `#[view]` headers; `Kv`, an enum of wrappers, and an unchanged legacy
//! command beside them.

use futures::FutureExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::*;
use crate::schema::Schema;
use crate::{CommandArg, CommandMetadata, command};

#[derive(Clone)]
pub struct Info;

#[derive(Debug, Clone, Serialize, Deserialize, Schema)]
pub struct Entry {
  /// The file name.
  pub name: String,
  #[view(header = "SIZE", align = right, format = bytes)]
  pub size: u64,
  #[view(skip)]
  pub inode: u64,
  #[view(section = "Owner")]
  pub owner: String,
}

fn entries() -> Vec<Entry> {
  vec![
    Entry {
      name: "a.txt".into(),
      size: 1254,
      inode: 1,
      owner: "james".into(),
    },
    Entry {
      name: "b.bin".into(),
      size: 6,
      inode: 2,
      owner: "root".into(),
    },
  ]
}

#[derive(Debug, Deserialize, CommandArg)]
pub struct LsArgs {
  #[arg(rest)]
  #[allow(dead_code)]
  pub paths: Vec<String>,
}

#[command(name = "ls", description = "List entries")]
fn ls(_info: Info, _args: LsArgs) -> crate::Result<Table<Entry>> {
  Ok(Table(entries()))
}

#[derive(Debug, Deserialize, CommandArg)]
pub struct StatArgs {
  pub name: String,
}

#[command(name = "stat", description = "One entry")]
fn stat(_info: Info, args: StatArgs) -> crate::Result<Kv<Entry>> {
  let mut entry = entries().remove(0);
  entry.name = args.name;
  Ok(Kv(entry))
}

/// A legacy command: `Value` result, legacy arg struct. Must stay unshaped.
#[derive(Debug, Deserialize, CommandArg)]
pub struct HelloArgs {
  /// Who to greet.
  pub name: String,
  #[serde(default)]
  pub loud: bool,
}

#[command(name = "hello", description = "Greet")]
fn hello(_info: Info, args: HelloArgs) -> crate::Result<Value> {
  Ok(json!({ "greeting": format!("hi {}", args.name), "loud": args.loud }))
}

#[derive(Serialize, Shape)]
#[serde(untagged)]
enum Listing {
  Rows(Table<Entry>),
  Names(List<String>),
  Text(Term),
}

fn argv(words: &[&str]) -> Vec<String> {
  words.iter().map(|w| w.to_string()).collect()
}

fn run<C: CommandMetadata<Info>>(cmd: &C, words: &[&str]) -> Value {
  cmd
    .call_with_argv(Info, argv(words))
    .unwrap()
    .now_or_never()
    .unwrap()
    .unwrap()
}

fn text(shape: &Value) -> String {
  tento_shapes::ShapeRegistry::core()
    .render_text(shape)
    .expect("renders")
}

#[test]
fn table_command_returns_bare_list_and_renders_table_with_view_headers() {
  let data = run(&ls, &["ls"]);
  // `--json` / lisp see exactly the serialized entries: a bare list.
  assert_eq!(data, serde_json::to_value(entries()).unwrap());
  assert!(data.is_array());

  let shape = ls.render_result(&data).expect("declared shape");
  assert_eq!(shape["shape"], "table/v1");
  let headers: Vec<&str> = shape["columns"]
    .as_array()
    .unwrap()
    .iter()
    .map(|c| c["header"].as_str().unwrap())
    .collect();
  assert_eq!(
    headers,
    ["name", "SIZE", "owner"],
    "view(skip) drops inode; header renames size; the rest are lowercase names"
  );
  assert_eq!(shape["header_style"], "dimmed");
  assert_eq!(shape["columns"][1]["align"], "right");
  let rendered = text(&shape);
  assert!(
    rendered.contains("SIZE") && rendered.contains("1.2K") && rendered.contains("6B"),
    "{rendered}"
  );
  assert_eq!(
    data,
    serde_json::to_value(entries()).unwrap(),
    "render never mutates data"
  );
}

#[test]
fn command_doc_records_the_declared_result() {
  let doc = ls.doc_value();
  assert_eq!(doc["type"], "command.doc/v1");
  assert_eq!(doc["result"]["shape"], "table/v1");
  assert_eq!(doc["result"]["type"]["kind"], "list");
  assert_eq!(doc["result"]["type"]["of"]["name"], "Entry");
  assert_eq!(
    doc["result"]["columns"][1],
    json!({"key": "size", "header": "SIZE", "align": "right", "format": "size_bytes"})
  );
  // The args schema rides along: `paths` is the rest slot.
  assert_eq!(doc["options"][0]["kind"], "variadic");
  assert_eq!(
    doc["options"][0]["schema"],
    json!({"kind": "list", "of": {"kind": "string"}})
  );
  // The human help shows what the command returns.
  let help = text(&crate::reflect::reflect_shape(&doc).unwrap());
  assert!(
    help.contains("Returns") && help.contains("list<entry> as table/v1 (name, SIZE, owner)"),
    "{help}"
  );
}

#[test]
fn kv_command_renders_kv_from_the_record() {
  let data = run(&stat, &["stat", "--name", "z"]);
  assert_eq!(data["name"], "z");
  assert_eq!(data["inode"], 1, "data keeps view(skip) fields");
  let shape = stat.render_result(&data).expect("kv");
  assert_eq!(shape["shape"], "kv/v1");
  assert_eq!(
    shape["fields"],
    json!({"name": "z", "SIZE": "1.2K", "owner": "james"})
  );
  assert_eq!(stat.result_doc().unwrap().shape.as_deref(), Some("kv/v1"));
}

#[test]
fn legacy_value_command_is_unchanged() {
  let data = run(&hello, &["hello", "--name", "x", "--loud"]);
  assert_eq!(data, json!({"greeting": "hi x", "loud": true}));
  assert!(
    hello.render_result(&data).is_none(),
    "Value keeps generic rendering"
  );
  assert!(
    hello.result_doc().is_none(),
    "untyped results declare nothing"
  );
  let doc = hello.doc_value();
  assert!(doc.get("result").is_none());
  // The legacy option record carries exactly its old keys.
  assert_eq!(
    doc["options"],
    json!([
      {"name": "name", "kind": "named", "type": "String", "help": "Who to greet."},
      {"name": "loud", "kind": "flag"}
    ])
  );
  assert!(
    HelloArgs::arg_schema().is_empty(),
    "legacy structs keep legacy binding"
  );
}

#[test]
fn values_with_their_own_shape_are_never_reshaped() {
  let own = json!({"shape": "term.block/v1", "rows": []});
  assert!(stat.render_result(&own).is_none());
  let tagged = json!({"datatype": "x/v1", "name": "n"});
  assert!(stat.render_result(&tagged).is_none());
}

#[test]
fn enum_of_wrappers_renders_one_shape_per_case() {
  let rows = Listing::Rows(Table(entries()));
  let names = Listing::Names(List(vec!["a".into(), "b".into()]));
  let term = Listing::Text(Term("one\ntwo".into()));
  assert_eq!(rows.render()["shape"], "table/v1");
  assert_eq!(
    names.render(),
    json!({"shape": "list/v1", "items": ["a", "b"]})
  );
  assert_eq!(term.render()["shape"], "term.block/v1");
  assert_eq!(term.render()["rows"].as_array().unwrap().len(), 2);
  // Data stays transparent per case.
  assert_eq!(serde_json::to_value(&names).unwrap(), json!(["a", "b"]));
  // From plain data, the first case whose form fits wins.
  assert_eq!(
    Listing::render_data(&json!(["a"])).unwrap()["shape"],
    "list/v1"
  );
  assert_eq!(
    Listing::render_data(&json!([{"name": "x", "size": 1, "owner": "o"}])).unwrap()["shape"],
    "table/v1"
  );
  assert_eq!(
    Listing::render_data(&json!("t")).unwrap()["shape"],
    "term.block/v1"
  );
  let doc = Listing::result_doc();
  let shapes: Vec<_> = doc.cases.iter().map(|c| c.shape.clone().unwrap()).collect();
  assert_eq!(shapes, ["table/v1", "list/v1", "term.block/v1"]);
  assert!(text(&term.render()).contains("two"));
}

#[test]
fn sections_group_fields_by_view_section() {
  let data = serde_json::to_value(&entries()[0]).unwrap();
  let shape = <Sections<Entry> as Shape>::render_data(&data).unwrap();
  assert_eq!(shape["shape"], "sections/v1");
  let first = &shape["sections"][0]["value"];
  assert_eq!(first["shape"], "table/v1");
  assert_eq!(first["header_rule"], false);
  assert_eq!(first["rows"], json!([["name", "a.txt"], ["SIZE", "1.2K"]]));
  assert_eq!(shape["sections"][1]["title"], "Owner");
  assert_eq!(
    shape["sections"][1]["value"]["rows"],
    json!([["owner", "james"]])
  );
  let drawn = text(&shape);
  assert!(drawn.contains("Owner") && drawn.contains("a.txt"), "{drawn}");
}

/// A fieldless enum whose cases draw as labelled, toned cells.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Schema)]
#[serde(rename_all = "snake_case")]
pub enum Health {
  #[view(label = "● healthy", style = "status.ok")]
  Healthy,
  #[view(label = "✗ failing", style = "status.error")]
  Failing,
  /// No view: drawn as its serde name.
  NotProbed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Schema)]
pub struct HostRow {
  #[view(style = "bold")]
  pub host: String,
  pub health: Health,
  pub last: Option<Health>,
  /// A block field: its own section when present, left out when absent.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub notes: Option<Vec<Note>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Schema)]
pub struct Note {
  pub text: String,
}

fn host_rows() -> Vec<HostRow> {
  vec![
    HostRow { host: "a".into(), health: Health::Failing, last: Some(Health::Healthy), notes: None },
    HostRow { host: "b".into(), health: Health::NotProbed, last: None, notes: None },
  ]
}

#[test]
fn enum_case_views_draw_styled_cells_and_keep_serde_names() {
  let data = serde_json::to_value(host_rows()).unwrap();
  assert_eq!(data[0]["health"], "failing", "the data keeps the serde name");
  let shape = <Table<HostRow> as Shape>::render_data(&data).unwrap();
  assert_eq!(shape["columns"][0]["style"], "bold", "a field style is its column's");
  assert_eq!(shape["rows"][0][1], json!({"text": "✗ failing", "style": "status.error"}));
  assert_eq!(shape["rows"][0][2], json!({"text": "● healthy", "style": "status.ok"}));
  assert_eq!(shape["rows"][1][1], "not_probed", "a case without a view is its name");
  assert_eq!(shape["rows"][1][2], "-", "a missing value is a dash, never null");
  let drawn = text(&shape);
  assert!(drawn.contains("✗ failing") && !drawn.contains("null"), "{drawn}");
}

#[test]
fn short_columns_keep_their_width_and_long_ones_give_way() {
  let data = json!([{"name": "rwc-04", "tags": ["x".repeat(40)], "seen": ["failing"]}]);
  let shape = <Table<Tagged> as Shape>::render_data(&data).unwrap();
  assert_eq!(shape["columns"][0]["min_width"], 6, "the name column never truncates");
  assert_eq!(shape["columns"][1]["min_width"], 0, "a long column gives way");
}

#[test]
fn the_declared_type_carries_case_views_and_column_styles() {
  let doc = <Table<HostRow> as Shape>::result_doc();
  assert_eq!(doc.columns[0].style.as_deref(), Some("bold"));
  // What a manifest records round-trips with the views intact.
  let wire = serde_json::to_value(&doc).unwrap();
  let health = &wire["type"]["of"]["fields"][1]["type"];
  assert_eq!(health["cases"], json!(["healthy", "failing", "not_probed"]));
  assert_eq!(
    health["views"][1],
    json!({"case": "failing", "label": "✗ failing", "style": "status.error"})
  );
  assert_eq!(serde_json::from_value::<ResultDoc>(wire).unwrap(), doc);
}

#[test]
fn sections_paint_enum_cases_and_leave_out_absent_blocks() {
  let mut row = host_rows().remove(0);
  let data = serde_json::to_value(&row).unwrap();
  let shape = <Sections<HostRow> as Shape>::render_data(&data).unwrap();
  let sections = shape["sections"].as_array().unwrap();
  assert_eq!(sections.len(), 1, "the absent notes block is left out: {shape:#}");
  assert_eq!(
    sections[0]["value"]["rows"],
    json!([
      ["host", {"text": "a", "style": "bold"}],
      ["health", {"text": "✗ failing", "style": "status.error"}],
      ["last", {"text": "● healthy", "style": "status.ok"}],
    ])
  );
  row.notes = Some(vec![Note { text: "n".into() }]);
  let data = serde_json::to_value(&row).unwrap();
  let shape = <Sections<HostRow> as Shape>::render_data(&data).unwrap();
  assert_eq!(shape["sections"][1]["value"]["rows"], json!([["n"]]));
  row.notes = Some(Vec::new());
  let data = serde_json::to_value(&row).unwrap();
  let shape = <Sections<HostRow> as Shape>::render_data(&data).unwrap();
  assert_eq!(shape["sections"].as_array().unwrap().len(), 1, "an empty list is left out");
}

#[derive(Debug, Clone, Serialize, Deserialize, Schema)]
pub struct Tagged {
  pub name: String,
  pub tags: Vec<String>,
  pub seen: Vec<Health>,
}

#[test]
fn a_list_of_scalars_draws_as_one_joined_cell() {
  let data = json!([
    {"name": "a", "tags": ["x", "y"], "seen": ["failing", "not_probed"]},
    {"name": "b", "tags": [], "seen": []},
  ]);
  let table = <Table<Tagged> as Shape>::render_data(&data).unwrap();
  assert_eq!(table["rows"][0][1], "x, y");
  assert_eq!(table["rows"][0][2], "✗ failing, not_probed");
  assert_eq!(table["rows"][1][1], "-", "an empty list is a dash");
  let sections = <Sections<Tagged> as Shape>::render_data(&data[0]).unwrap();
  assert_eq!(sections["sections"].as_array().unwrap().len(), 1, "lines, not blocks");
  assert_eq!(sections["sections"][0]["value"]["rows"][1][1], "x, y");
  let sections = <Sections<Tagged> as Shape>::render_data(&data[1]).unwrap();
  assert_eq!(sections["sections"][0]["value"]["rows"].as_array().unwrap().len(), 1, "empty lists are left out");
}

#[test]
fn default_headers_are_lowercase_names_with_spaces() {
  assert_eq!(default_header("items_ok"), "items ok");
  assert_eq!(default_header("Host"), "host");
  let shape = <Table<String> as Shape>::render_data(&json!(["a", "b"])).unwrap();
  assert_eq!(shape["columns"][0]["header"], "value");
  assert_eq!(shape["header_style"], "dimmed");
  assert_eq!(shape["rows"], json!([["a"], ["b"]]));
  assert!(shape.get("title").is_none(), "an unset title is absent, not null: {shape}");
  assert!(shape["columns"][0].get("max_width").is_none(), "{shape}");
}

/// The loader's path: a mounted result is noted with the declared `result`
/// (as the manifest records it), and the next display of that same value draws
/// the declared shape — once. Own-shaped values and other values pass.
#[test]
fn a_noted_result_draws_its_declared_shape_once() {
  let manifest_result = serde_json::to_value(<Table<HostRow> as Shape>::result_doc()).unwrap();
  let doc: ResultDoc = serde_json::from_value(manifest_result).unwrap();
  let data = serde_json::to_value(host_rows()).unwrap();
  note_declared_result(&data, &doc);
  let shape = take_declared_view(&data).expect("declared shape");
  assert_eq!(shape["shape"], "table/v1");
  assert_eq!(shape["rows"][0][1], json!({"text": "✗ failing", "style": "status.error"}));
  assert!(take_declared_view(&data).is_none(), "a display takes the note");

  note_declared_result(&data, &doc);
  assert!(take_declared_view(&json!([])).is_none(), "another value draws as itself");
  assert!(take_declared_view(&data).is_none(), "and the stale note is gone");

  let own = json!({"shape": "table/v1", "columns": [], "rows": []});
  note_declared_result(&own, &doc);
  assert!(take_declared_view(&own).is_none(), "an own shape is never re-shaped");

  let plain = ResultDoc::plain(TypeDesc::String);
  note_declared_result(&json!("x"), &plain);
  assert!(take_declared_view(&json!("x")).is_none(), "nothing declared, nothing drawn");
}

#[test]
fn a_declared_union_renders_through_the_first_case_that_fits() {
  let doc = Listing::result_doc();
  assert_eq!(doc.render(&json!(["a"])).unwrap()["shape"], "list/v1");
  assert_eq!(doc.render(&json!("t")).unwrap()["shape"], "term.block/v1");
  assert!(doc.render(&json!({"shape": "kv/v1", "fields": {}})).is_none());
}

#[test]
fn wrappers_are_serde_transparent() {
  let table: Table<Entry> =
    serde_json::from_value(json!([{"name": "n", "size": 1, "inode": 0, "owner": "o"}])).unwrap();
  assert_eq!(table.len(), 1);
  assert_eq!(serde_json::to_value(Term("x".into())).unwrap(), json!("x"));
  assert_eq!(
    serde_json::to_value(Kv(json!({"a": 1}))).unwrap(),
    json!({"a": 1})
  );
  assert_eq!(<Table<Entry> as Schema>::schema(), <Vec<Entry>>::schema());
}

/// The human one-shot prints the declared shape; the plain data stays what
/// `--json` and Lisp callers get, and an undeclared command is untouched.
#[test]
fn the_human_one_shot_renders_the_declared_result_shape() {
  use crate::run_loop::human_value;
  let scripts = crate::Scripts::new(Info).add_command(ls).add_command(hello);
  let data = json!([{"name": "a.txt", "size": 1254, "inode": 1, "owner": "james"}]);
  let shown = human_value(&scripts, Some("ls"), &data);
  assert_eq!(shown["shape"], "table/v1", "{shown}");
  assert_ne!(&*shown, &data);
  let plain = json!("hello");
  assert_eq!(&*human_value(&scripts, Some("hello"), &plain), &plain);
  assert_eq!(&*human_value(&scripts, Some("missing"), &data), &data);
  assert_eq!(&*human_value(&scripts, None, &data), &data);
}
