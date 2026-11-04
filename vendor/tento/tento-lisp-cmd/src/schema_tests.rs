use serde::{Deserialize, Serialize};
use serde_json::json;

use super::*;

#[derive(Serialize, Deserialize, Schema)]
#[serde(rename_all = "snake_case")]
enum Kind {
  File,
  SymLink,
}

/// A directory entry.
#[derive(Serialize, Deserialize, Schema)]
struct Entry {
  /// The file name.
  name: String,
  #[view(header = "SIZE", align = right, format = bytes)]
  size: u64,
  #[serde(rename = "kind")]
  entry_kind: Kind,
  tags: Vec<String>,
  delta: Option<i32>,
  ratio: f32,
  #[view(skip)]
  inode: u64,
  #[serde(skip)]
  #[allow(dead_code)]
  cache: u8,
}

#[derive(Serialize, Schema)]
#[serde(rename_all = "kebab-case")]
struct Meta {
  dry_run: bool,
  #[serde(flatten)]
  extra: Inner,
}

#[derive(Serialize, Schema)]
struct Inner {
  depth: usize,
}

#[derive(Serialize, Schema)]
struct Wrapper(Vec<String>);

#[derive(Serialize, Schema)]
#[allow(dead_code)]
enum Event {
  Started,
  Moved(String),
  Resized { width: u32 },
}

#[test]
fn record_fields_carry_serde_names_types_docs_and_views() {
  let TypeDesc::Record { name, fields } = Entry::schema() else {
    panic!("record");
  };
  assert_eq!(name, "Entry");
  let names: Vec<&str> = fields.iter().map(|f| f.name.as_str()).collect();
  // serde rename honoured; serde-skipped `cache` is not data.
  assert_eq!(
    names,
    ["name", "size", "kind", "tags", "delta", "ratio", "inode"]
  );
  assert_eq!(fields[0].ty, TypeDesc::String);
  assert_eq!(fields[0].doc.as_deref(), Some("The file name."));
  assert_eq!(fields[1].ty, TypeDesc::U64);
  assert_eq!(fields[1].view.header.as_deref(), Some("SIZE"));
  assert_eq!(fields[1].view.align, Some(ViewAlign::Right));
  assert_eq!(fields[1].view.format.as_deref(), Some("size_bytes"));
  assert_eq!(
    fields[2].ty,
    TypeDesc::Enum {
      name: "Kind".into(),
      cases: vec!["file".into(), "sym_link".into()],
      views: vec![],
    }
  );
  assert_eq!(fields[3].ty, TypeDesc::list(TypeDesc::String));
  assert_eq!(fields[4].ty, TypeDesc::option(TypeDesc::S64));
  assert_eq!(fields[5].ty, TypeDesc::F64);
  assert!(
    fields[6].view.skip,
    "view(skip) is presentation, still data"
  );
}

#[test]
fn rename_all_flatten_and_newtypes_follow_serde() {
  let TypeDesc::Record { fields, .. } = Meta::schema() else {
    panic!("record");
  };
  let names: Vec<&str> = fields.iter().map(|f| f.name.as_str()).collect();
  assert_eq!(names, ["dry-run", "depth"]);
  assert_eq!(Wrapper::schema(), TypeDesc::list(TypeDesc::String));
}

#[test]
fn data_enums_describe_each_case() {
  let TypeDesc::Variant { cases, .. } = Event::schema() else {
    panic!("variant");
  };
  assert_eq!(cases[0].ty, None);
  assert_eq!(cases[1].ty, Some(TypeDesc::String));
  assert!(
    matches!(&cases[2].ty, Some(TypeDesc::Record { fields, .. }) if fields[0].ty == TypeDesc::U64)
  );
}

#[test]
fn descriptor_serializes_tagged_and_spells_wit() {
  assert_eq!(
    serde_json::to_value(TypeDesc::list(TypeDesc::option(TypeDesc::String))).unwrap(),
    json!({"kind": "list", "of": {"kind": "option", "of": {"kind": "string"}}})
  );
  assert_eq!(
    Vec::<Option<String>>::schema().wit(),
    "list<option<string>>"
  );
  assert_eq!(Kind::schema().wit(), "kind");
  assert_eq!(<Vec<Entry>>::schema().wit(), "list<entry>");
  let value = serde_json::to_value(Entry::schema()).unwrap();
  assert_eq!(
    value["fields"][1]["view"],
    json!({"header": "SIZE", "align": "right", "format": "size_bytes"})
  );
  // No view → no `view` key.
  assert!(value["fields"][0].get("view").is_none());
  let back: TypeDesc = serde_json::from_value(value).unwrap();
  assert_eq!(back, Entry::schema());
}

#[test]
fn view_never_changes_the_serialized_data() {
  let entry = Entry {
    name: "a".into(),
    size: 2048,
    entry_kind: Kind::SymLink,
    tags: vec![],
    delta: None,
    ratio: 0.5,
    inode: 7,
    cache: 1,
  };
  assert_eq!(
    serde_json::to_value(&entry).unwrap(),
    json!({"name": "a", "size": 2048, "kind": "sym_link", "tags": [], "delta": null, "ratio": 0.5, "inode": 7})
  );
}
