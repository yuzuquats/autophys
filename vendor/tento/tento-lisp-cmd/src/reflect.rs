//! Reflection records — the structured self-description a command surface emits.
//!
//! One shape, defined once and shared between the **emitter** (`--help` renders it,
//! root `--help --json` emits it raw) and the **consumer** (the `tento-app`
//! loader deserializes it) — no translation layer. All types round-trip through
//! serde, and the on-wire `type` tag makes each record self-identifying:
//!
//! - [`CommandDoc`] — `command.doc/v1`, a leaf command.
//! - [`CommandIndex`] — `command.index/v1`, a namespace / tree (recursive).
//! - [`CommandAlias`] — `command.alias/v1`, a unix-name alias leaf (`ls` →
//!   `std.fs.list_dir`) sourced from the prelude `def`s.
//! - [`CommandEntry`] — an index entry: a leaf doc or a nested namespace, tagged
//!   on `type` so the wire shape is exactly the record.
//! - [`ProvideEntry`] — one CAPABILITY the app declares it handles (today
//!   `syntax.provider/v1`), carried in [`AppSelfDoc::provides`].
//! - [`ServiceDecl`] — one long-running SERVICE the app can be asked to run,
//!   carried in [`AppSelfDoc::services`].
//! - [`AppSelfDoc`] — `tsh.app/v1`, the app root (what root `--help --json` emits and
//!   the loader/packager read; this retired the bespoke `__manifest` subcommand).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::dispatch::DaemonScope;

/// How an option is passed. Positional detection needs the (still-deferred)
/// schema-driven binding, so `#[derive(CommandArg)]` struct fields classify as
/// `Named`/`Flag`/`Variadic` today; `Positional` arrives with that schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OptionKind {
  Positional,
  Variadic,
  Named,
  Flag,
}

impl OptionKind {
  /// The wire token (matches the serde `snake_case` rename) — used when
  /// projecting an option into a display row.
  pub fn as_str(&self) -> &'static str {
    match self {
      OptionKind::Positional => "positional",
      OptionKind::Variadic => "variadic",
      OptionKind::Named => "named",
      OptionKind::Flag => "flag",
    }
  }
}

/// One option (arg field) of a command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionDoc {
  pub name: String,
  pub kind: OptionKind,
  /// The arg's type token (`"string"`, `"u64"`, …); `None` for a bare flag.
  #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
  pub type_tok: Option<String>,
  /// The field's `///` doc (or `#[tento_sh(help = "…")]`); `None` if undocumented.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub help: Option<String>,
  /// The single-letter alias a declared arg binds from (`#[arg(short = 'x')]`).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub short: Option<char>,
  /// The value bound when the call omits it (`#[arg(default = …)]`).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default: Option<Value>,
  /// The structured type of a declared arg whose field type has a `Schema`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub schema: Option<crate::schema::TypeDesc>,
}

/// `command.doc/v1` — a leaf command's descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandDoc {
  pub name: String,
  pub description: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub long_description: Option<String>,
  #[serde(default)]
  pub options: Vec<OptionDoc>,
  /// The declared result: its type and, for a shape wrapper, the shape and
  /// columns the human renderer applies. Absent when the command declares none.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub result: Option<crate::shape::ResultDoc>,
}

/// `command.alias/v1` — a unix-name alias leaf: a prelude `def` (`ls` →
/// `std.fs.list_dir`) reflected into the command index so completion surfaces
/// the short name. `description` is pre-composed where the entry is built
/// (`→ <target>` plus the target's own description) — a consumer shows it
/// verbatim, exactly like a `command.doc/v1` description.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandAlias {
  pub name: String,
  pub target: String,
  pub description: String,
}

/// `command.index/v1` — a namespace / command tree (recursive via [`CommandEntry`]).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CommandIndex {
  #[serde(default)]
  pub entries: BTreeMap<String, CommandEntry>,
}

/// An index entry: a leaf command doc or a nested namespace. **Internally tagged
/// on `type`**, so `CommandEntry::Doc(doc)` serializes to
/// `{"type":"command.doc/v1", …the doc fields…}` — the exact wire record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum CommandEntry {
  #[serde(rename = "command.doc/v1")]
  Doc(CommandDoc),
  #[serde(rename = "command.index/v1")]
  Index(CommandIndex),
  #[serde(rename = "command.alias/v1")]
  Alias(CommandAlias),
}

impl CommandEntry {
  /// The `description` the loader reads (empty for a namespace).
  pub fn description(&self) -> &str {
    match self {
      CommandEntry::Doc(d) => &d.description,
      CommandEntry::Index(_) => "",
      CommandEntry::Alias(a) => &a.description,
    }
  }
}

/// A daemon-transport app's connection block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonDoc {
  pub socket: String,
  #[serde(default)]
  pub start: Vec<String>,
  /// Lifecycle scope: absent = a DETACHED daemon at the fixed `socket` (today's
  /// behavior); `"session"` = a session-leased service whose socket is derived
  /// under the session dir. Serde default so manifests written before this field
  /// existed still parse as detached.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub scope: Option<DaemonScope>,
}

/// The only app-root record version this binary emits and reads. A manifest
/// carrying a DIFFERENT `type` is rejected by the loader rather than parsed
/// leniently (see `tento_app::TshApp::load`).
pub const TSH_APP_SCHEMA: &str = "tsh.app/v1";
/// Source-compatibility alias. Installed manifests identify their contract in
/// the `schema` field.
pub const TSH_APP_TYPE: &str = TSH_APP_SCHEMA;

/// The `type` tag of a syntax-provider [`ProvideEntry`]: "this bundle can turn
/// a source file it claims into `returns` rows". The first capability kind; a
/// consumer that knows only this one MUST ignore every other tag it meets.
pub const SYNTAX_PROVIDER_V1: &str = "syntax.provider/v1";

/// The `type` tag of a terminal-launcher [`ProvideEntry`]: "this bundle can
/// open OS terminal windows for a window split". The core never names a
/// terminal emulator; `tsh window open` hands the mounted provider ONE
/// [`TERMINAL_LAUNCH_REQUEST_V1`] value (the whole split — layout tree and
/// per-window argv) and expects a [`TERMINAL_LAUNCH_REPORT_V1`] back. No
/// provider mounted → the core prints the per-window commands instead.
pub const TERMINAL_LAUNCH_V1: &str = "terminal.launch/v1";
/// The request datatype a launcher receives as its one JSON argument:
/// `{"datatype": …, "data": {split, layout|null, windows: [{name, title, argv,
/// host: "viewer"|"direct", cwd, env, size?}]}}`.
pub const TERMINAL_LAUNCH_REQUEST_V1: &str = "terminal.launch.request/v1";
/// The report datatype a launcher answers with: `{"datatype": …, "fields":
/// {sent: bool, launched: N, reason?: "…"}}` — `sent: false` with a reason is
/// the honest "no socket here" answer, not an error.
pub const TERMINAL_LAUNCH_REPORT_V1: &str = "terminal.launch.report/v1";

/// The `kind` of a [`ServiceDecl`] a host supervises as a long-running HTTP
/// listener: it is spawned with a `--listen <addr>` it must bind, and it is
/// reachable over TCP for as long as it runs. The first service kind; a
/// supervisor that knows only this one MUST skip every other kind it meets
/// rather than refuse the bundle.
pub const SERVICE_KIND_HTTP: &str = "http";

fn tsh_app_type() -> String {
  TSH_APP_SCHEMA.to_string()
}

/// One capability an app DECLARES it provides — the seam that lets a host route
/// work to a bundle it was never compiled against.
///
/// The binary is the single authority: a group crate declares its entries at the
/// `Scripts` builder ([`crate::Scripts::provide`]), they ride root
/// `--help --json` as `provides`, and the packager merely CACHES them into
/// `manifest.json`. Nothing hand-authors a provide.
///
/// `type` is a **versioned tag** (`"syntax.provider/v1"`), kept as a plain
/// `String` rather than an enum on purpose: an entry whose kind this binary has
/// never heard of still parses, still round-trips, and is still visible to
/// callers — which is what lets an old host ignore a new capability instead of
/// failing to read the manifest that carries it. Unknown FIELDS are tolerated
/// the same way (serde ignores them).
///
/// For `syntax.provider/v1` the fields read: this bundle answers for files whose
/// extension is in `extensions` (no leading dot) or whose `#!` line names an
/// interpreter in `interpreters`; run `command` on the file and the value comes
/// back tagged `returns` (a host that gets a different `datatype` must fail, not
/// render). `id` is the capability's own name within its kind — the language
/// name for a syntax provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvideEntry {
  #[serde(rename = "type")]
  pub type_tag: String,
  pub id: String,
  #[serde(default)]
  pub extensions: Vec<String>,
  #[serde(default)]
  pub interpreters: Vec<String>,
  /// The bundle command a host spawns. Empty for a lisp-backed entry; exactly
  /// one of `command` and [`Self::lisp`] is set (the loader enforces it).
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub command: String,
  /// A lisp-backed entry: the name of the bundle's rc export the host calls
  /// (`<ns>.<lisp>`) with the request as a value, instead of spawning a
  /// command. Absent on every executable entry, so their JSON is unchanged.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub lisp: Option<String>,
  pub returns: String,
}

impl ProvideEntry {
  /// A `syntax.provider/v1` entry: `id` is the language name, `command` the
  /// bundle command a host spawns on the file, `returns` the datatype the value
  /// must carry back. Claims nothing yet — chain [`Self::extensions`] /
  /// [`Self::interpreters`] to say which files it answers for.
  pub fn syntax_provider(
    id: impl Into<String>,
    command: impl Into<String>,
    returns: impl Into<String>,
  ) -> Self {
    ProvideEntry {
      type_tag: SYNTAX_PROVIDER_V1.to_string(),
      id: id.into(),
      extensions: Vec::new(),
      interpreters: Vec::new(),
      command: command.into(),
      lisp: None,
      returns: returns.into(),
    }
  }

  /// A lisp-backed entry of kind `type_tag`: the host calls the bundle's rc
  /// export `<ns>.<export>` with the request and reads its return value as the
  /// answer, which must carry `returns`. No executable is involved.
  pub fn lisp_provider(
    type_tag: impl Into<String>,
    id: impl Into<String>,
    export: impl Into<String>,
    returns: impl Into<String>,
  ) -> Self {
    ProvideEntry {
      type_tag: type_tag.into(),
      id: id.into(),
      extensions: Vec::new(),
      interpreters: Vec::new(),
      command: String::new(),
      lisp: Some(export.into()),
      returns: returns.into(),
    }
  }

  /// The file extensions this entry claims, WITHOUT the leading dot (`"go"`).
  /// Builder-style.
  pub fn extensions<S: Into<String>>(mut self, extensions: impl IntoIterator<Item = S>) -> Self {
    self.extensions = extensions.into_iter().map(Into::into).collect();
    self
  }

  /// The `#!` interpreter names this entry claims (`"python3"`) — the only clue
  /// an extensionless script gives. Builder-style.
  pub fn interpreters<S: Into<String>>(
    mut self,
    interpreters: impl IntoIterator<Item = S>,
  ) -> Self {
    self.interpreters = interpreters.into_iter().map(Into::into).collect();
    self
  }
}

/// One long-running SERVICE an app declares it can run — the seam that lets a
/// supervisor bring a listener up out of an installed bundle WITHOUT spawning
/// the binary first to ask.
///
/// Same authority chain as [`ProvideEntry`]: the group crate declares it at the
/// `Scripts` builder ([`crate::Scripts::service`]), it rides root
/// `--help --json` as `services`, and the packager merely CACHES it into
/// `manifest.json`. Nothing hand-authors a service; a manifest can never offer
/// a listener the binary does not implement.
///
/// `kind` is a forward-compatible tag kept as a plain `String` (not an enum) for
/// the reason the provides tag is: a bundle built against a newer tento may
/// declare a kind this supervisor has never heard of, and the right behavior is
/// to parse it, keep it visible, and SKIP it — never to fail reading the
/// manifest that carries it.
///
/// For [`SERVICE_KIND_HTTP`] the fields read: run the bundle command `command`,
/// which must accept `--listen <ip:port>` and bind exactly that address; if
/// `health_path` is set, a GET of that path on the bound address answers while
/// the service is healthy. `id` is the service's name within the bundle — the
/// handle `tsh services start <id>` takes, and the label a fleet record matches
/// when it claims ownership of the same service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceDecl {
  pub id: String,
  pub command: String,
  pub kind: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub health_path: Option<String>,
}

impl ServiceDecl {
  /// An [`SERVICE_KIND_HTTP`] service: `id` is the service name, `command` the
  /// bundle command a supervisor spawns with `--listen <ip:port>`. Declares no
  /// health probe — chain [`Self::health_path`] to add one.
  pub fn http(id: impl Into<String>, command: impl Into<String>) -> Self {
    ServiceDecl {
      id: id.into(),
      command: command.into(),
      kind: SERVICE_KIND_HTTP.to_string(),
      health_path: None,
    }
  }

  /// The absolute request path a supervisor may GET to check liveness
  /// (`"/health"`). Builder-style.
  pub fn health_path(mut self, path: impl Into<String>) -> Self {
    self.health_path = Some(path.into());
    self
  }
}

/// `tsh.app/v1` — the app root self-description: what root `--help-json` emits and
/// the loader (`tento-app`) + packager read. `commands` top-level keys are flat
/// dispatchable command names, each an entry carrying `description` (the loader
/// contract); `transport` (+ `daemon`) tell a loader how to talk to the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSelfDoc {
  #[serde(default = "tsh_app_type")]
  pub schema: String,
  /// The packager fills these fields with the installed bundle identity.
  /// An unset identity is omitted from the wire rather than written as `""`,
  /// so a packager that predates these fields (it copies this doc into
  /// `manifest.json` and adds only `version`) writes a manifest with no
  /// identity at all, which the loader completes from the bundle folder.
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub name: String,
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub version: String,
  #[serde(default, skip_serializing_if = "String::is_empty")]
  pub entrypoint: String,
  #[serde(default = "default_transport")]
  pub transport: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub daemon: Option<DaemonDoc>,
  /// Per-command transport overrides: full space-joined command path
  /// (`"acme.releases changelog show"`) → transport (`"oneshot"`/`"streaming"`/
  /// `"daemon"`), set via `#[command(transport = "…")]`. Lets a single bundle
  /// mix transports — a shape-returning command routes oneshot (the host
  /// renders the shape) even in an otherwise-streaming bundle. Read by the
  /// `tento-app` loader (`AppManifest.transports` → `RemoteGroup` routing);
  /// absent/empty ⇒ every command inherits `transport`.
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub transports: BTreeMap<String, String>,
  /// The CAPABILITIES this app declares ([`ProvideEntry`]) — what a host may
  /// route to it without being compiled against it. Omitted from the wire when
  /// empty, which is the overwhelming majority of bundles.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub provides: Vec<ProvideEntry>,
  /// The long-running SERVICES this app declares ([`ServiceDecl`]) — what a
  /// supervisor may bring up out of the installed bundle without spawning the
  /// binary to ask. Omitted from the wire when empty, like `provides`.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub services: Vec<ServiceDecl>,
  #[serde(default)]
  pub commands: BTreeMap<String, CommandEntry>,
}

fn default_transport() -> String {
  "oneshot".to_string()
}

impl AppSelfDoc {
  /// A fresh `tsh.app/v1` with the given transport and no commands yet.
  pub fn new(transport: impl Into<String>) -> Self {
    AppSelfDoc {
      schema: tsh_app_type(),
      name: String::new(),
      version: String::new(),
      entrypoint: String::new(),
      transport: transport.into(),
      daemon: None,
      transports: BTreeMap::new(),
      provides: Vec::new(),
      services: Vec::new(),
      commands: BTreeMap::new(),
    }
  }
}

/// Presentation transform: a **pure** reflection record → an equivalent render
/// **shape** value (`sections/v1` / `table/v1`) for the human surface. The record
/// itself never carries a `shape`/presentation field — `--json` emits it verbatim
/// and the loader reads it; only the human render boundary maps it, here, so the
/// existing `ShapeRegistry` styles it. Returns `None` for a non-reflection value.
///
/// - `command.doc/v1` → a `sections/v1`: the name/description header, then an
///   options table (only when the command has options).
/// - `command.index/v1` / `tsh.app/v1` → a `table/v1` command menu
///   (`COMMAND` │ `DESCRIPTION`). An app root is recognised by its `schema`
///   tag, or by the `type` tag a binary built before the rename still emits.
pub fn reflect_shape(value: &Value) -> Option<Value> {
  let tag = |key: &str| value.get(key).and_then(Value::as_str);
  // An explicit presentation supplied by a plugin takes precedence.
  if tag("shape").is_some() || tag("datatype").is_some() {
    return None;
  }
  if tag("schema") == Some(TSH_APP_SCHEMA) || tag("type") == Some(TSH_APP_SCHEMA) {
    return value.get("commands")?.as_object().map(entries_table);
  }
  match tag("type") {
    Some("command.index/v1") => value.get("entries")?.as_object().map(entries_table),
    Some("command.doc/v1") => doc_shape(value),
    // Mounted bundles historically return a bare map. Require every entry to
    // identify itself as command metadata; ordinary data must retain its values.
    None if tag("schema").is_none() => {
      let entries = value.as_object()?;
      (!entries.is_empty()
        && entries.values().all(|entry| {
          matches!(
            entry.get("type").and_then(Value::as_str),
            Some("command.doc/v1" | "command.index/v1" | "command.alias/v1")
          )
        }))
      .then(|| entries_table(entries))
    }
    _ => None,
  }
}

/// Menus need only names and summaries, not a complete option-schema decode.
fn entries_table(entries: &serde_json::Map<String, Value>) -> Value {
  let rows: Vec<Value> = entries
    .iter()
    .map(|(name, entry)| {
      let desc = entry
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
          if entry.get("type").and_then(Value::as_str) == Some("command.index/v1") {
            "(namespace)"
          } else {
            ""
          }
        });
      json!([name, desc])
    })
    .collect();
  // A menu row is only as useful as its name: the COMMAND column never
  // shrinks below the longest name (an `std.fs.…` seven times over names
  // nothing). DESCRIPTION takes what is left and truncates, or drops to a
  // sub-line when even that does not fit.
  let name_width = entries
    .keys()
    .map(|name| tento_term::width::visual_width(name))
    .max()
    .unwrap_or(0);
  json!({
    "shape": "table/v1",
    "columns": [
      { "header": "COMMAND", "min_width": name_width },
      { "header": "DESCRIPTION", "priority": 1 },
    ],
    "rows": rows,
  })
}

/// Project both native and external-plugin option vocabularies at the display
/// boundary. The wire record stays untouched for reflection and JSON consumers.
fn doc_shape(doc: &Value) -> Option<Value> {
  let mut sections = vec![json!({
    "title": doc.get("name")?.as_str()?,
    "value": doc.get("description")?.as_str()?,
  })];
  if let Some(long) = doc.get("long_description").and_then(Value::as_str) {
    sections.push(json!({ "title": "Details", "value": long }));
  }
  if let Some(options) = doc
    .get("options")
    .and_then(Value::as_array)
    .filter(|o| !o.is_empty())
  {
    let has_defaults = options
      .iter()
      .any(|o| o.get("default").is_some_and(|v| !v.is_null()));
    let mut rows = Vec::new();
    for option in options {
      let name = option.get("name")?.as_str()?;
      let kind = option.get("kind").and_then(Value::as_str);
      let value = option
        .get("value")
        .or_else(|| option.get("type"))
        .and_then(Value::as_str);
      let usage = match (kind, value) {
        (Some("flag"), _) | (_, None) => name.to_string(),
        (Some("positional"), Some(value)) => format!("{name} <{value}>"),
        (Some("variadic"), Some(value)) => format!("{name} <{value}>…"),
        (_, Some(value)) => format!("{name} <{value}>"),
      };
      // A declared short alias leads its option (`-a, all`).
      let usage = match option.get("short").and_then(Value::as_str) {
        Some(short) => format!("-{short}, {usage}"),
        None => usage,
      };
      let help = option
        .get("help")
        .or_else(|| option.get("description"))
        .and_then(Value::as_str)
        .unwrap_or("");
      let mut row = vec![json!(usage), json!(help)];
      if has_defaults {
        row.push(match option.get("default") {
          None | Some(Value::Null) => json!(""),
          Some(Value::String(s)) => json!(s),
          Some(value) => json!(value.to_string()),
        });
      }
      rows.push(Value::Array(row));
    }
    let mut columns = vec![
      json!({"header": "OPTION"}),
      json!({"header": "DESCRIPTION"}),
    ];
    if has_defaults {
      columns.push(json!({"header": "DEFAULT"}));
    }
    sections.push(json!({
      "title": "Options",
      "value": { "shape": "table/v1", "columns": columns, "rows": rows },
    }));
  }
  // A declared result: its type, and the shape the human render applies.
  if let Some(result) = doc
    .get("result")
    .and_then(|r| serde_json::from_value::<crate::shape::ResultDoc>(r.clone()).ok())
  {
    let mut text = result.ty.wit();
    if let Some(shape) = &result.shape {
      text.push_str(&format!(" as {shape}"));
    }
    if !result.columns.is_empty() {
      let headers: Vec<&str> = result.columns.iter().map(|c| c.header.as_str()).collect();
      text.push_str(&format!(" ({})", headers.join(", ")));
    }
    sections.push(json!({ "title": "Returns", "value": text }));
  }
  Some(json!({ "shape": "sections/v1", "sections": sections }))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn web_doc() -> Value {
    json!({"type":"command.doc/v1", "name":"serve", "description":"Serve the browser",
    "options":[
      {"name":"--listen", "value":"host:port", "description":"Loopback address", "default":"127.0.0.1:4790"},
      {"name":"--verbose", "value":null, "description":"Log requests", "default":null}
    ]})
  }

  #[test]
  fn plugin_help_menus_do_not_decode_option_schemas() {
    let entries =
      json!({"serve":web_doc(), "status":{"type":"command.doc/v1", "description":"Read health"}});
    for menu in [
      entries.clone(),
      json!({"type":"command.index/v1", "entries":entries}),
      json!({"schema":"tsh.app/v1", "commands":entries}),
    ] {
      let shape = reflect_shape(&menu).expect("plugin menu");
      assert_eq!(
        shape["rows"],
        json!([["serve", "Serve the browser"], ["status", "Read health"]])
      );
    }
  }

  #[test]
  fn plugin_options_show_usage_description_and_defaults_without_nulls() {
    let doc = web_doc();
    let original = doc.clone();
    let shape = reflect_shape(&doc).expect("plugin command doc");
    assert_eq!(
      shape["sections"][1]["value"]["rows"],
      json!([
        ["--listen <host:port>", "Loopback address", "127.0.0.1:4790"],
        ["--verbose", "Log requests", ""]
      ])
    );
    let text = tento_shapes::ShapeRegistry::core()
      .render_text(&shape)
      .unwrap();
    assert!(text.contains("127.0.0.1:4790"), "{text}");
    assert!(!text.contains("null"), "{text}");
    assert_eq!(doc, original, "display must not mutate reflection data");
  }

  #[test]
  fn reflection_preserves_explicit_shapes_and_unrelated_maps() {
    assert!(
      reflect_shape(&json!({"item":{"description":"Not command metadata", "price":42}})).is_none()
    );
    assert!(
      reflect_shape(&json!({"shape":"term.block/v1", "type":"command.index/v1", "entries":{}}))
        .is_none()
    );
  }

  #[test]
  fn command_entry_doc_wire_shape_round_trips() {
    let entry = CommandEntry::Doc(CommandDoc {
      name: "ls".into(),
      description: "list a directory".into(),
      long_description: None,
      result: None,
      options: vec![
        OptionDoc {
          name: "all".into(),
          kind: OptionKind::Flag,
          type_tok: None,
          help: Some("include hidden".into()),
          short: None,
          default: None,
          schema: None,
        },
        OptionDoc {
          name: "limit".into(),
          kind: OptionKind::Named,
          type_tok: Some("u64".into()),
          help: None,
          short: None,
          default: None,
          schema: None,
        },
      ],
    });
    let json = serde_json::to_value(&entry).unwrap();
    // The `type` tag is present at the leaf and options are structured.
    assert_eq!(json["type"], "command.doc/v1");
    assert_eq!(json["name"], "ls");
    assert_eq!(json["options"][0]["kind"], "flag");
    assert_eq!(json["options"][1]["type"], "u64");
    // Round-trips back to the same value.
    let back: CommandEntry = serde_json::from_value(json).unwrap();
    assert_eq!(back, entry);
  }

  #[test]
  fn app_self_doc_carries_type_and_flat_command_keys() {
    let mut app = AppSelfDoc::new("oneshot");
    app.commands.insert(
      "user-profile".into(),
      CommandEntry::Doc(CommandDoc {
        name: "user-profile".into(),
        description: "the profile".into(),
        long_description: None,
        result: None,
        options: vec![],
      }),
    );
    let json = serde_json::to_value(&app).unwrap();
    assert_eq!(json["schema"], TSH_APP_SCHEMA);
    assert_eq!(json["transport"], "oneshot");
    // Flat top-level command-name key + a readable description — the loader contract.
    assert_eq!(
      json["commands"]["user-profile"]["description"],
      "the profile"
    );
    let back: AppSelfDoc = serde_json::from_value(json).unwrap();
    assert_eq!(back, app);
    assert_eq!(back.commands["user-profile"].description(), "the profile");
  }

  /// An older `tsh.app/v1` without the `transports` field still parses
  /// (`serde(default)` ⇒ empty map = every command inherits the bundle
  /// transport), and a populated map round-trips.
  #[test]
  fn app_self_doc_transports_defaults_and_round_trips() {
    // Old manifest: no `transports` key.
    let old = serde_json::json!({
      "schema": "tsh.app/v1",
      "transport": "streaming",
      "commands": {}
    });
    let app: AppSelfDoc = serde_json::from_value(old).unwrap();
    assert!(app.transports.is_empty());

    // Populated map serializes as the `"path" → "transport"` object the
    // tento-app loader (`AppManifest.transports`) reads, and round-trips.
    let mut app = AppSelfDoc::new("streaming");
    app
      .transports
      .insert("changelog show".into(), "oneshot".into());
    let json = serde_json::to_value(&app).unwrap();
    assert_eq!(json["transports"]["changelog show"], "oneshot");
    let back: AppSelfDoc = serde_json::from_value(json).unwrap();
    assert_eq!(back, app);
  }

  /// The self-doc CARRIES provides: a declared entry rides `--help --json` in
  /// the shape the loader reads, an app with none omits the key entirely (so an
  /// older reader sees exactly the manifest it saw before), and the whole record
  /// round-trips.
  #[test]
  fn app_self_doc_carries_provides_and_omits_them_when_empty() {
    // No provides → no key on the wire.
    let bare = AppSelfDoc::new("oneshot");
    let json = serde_json::to_value(&bare).unwrap();
    assert!(json.get("provides").is_none(), "empty is omitted: {json}");

    let mut app = AppSelfDoc::new("oneshot");
    app
      .provides
      .push(ProvideEntry::syntax_provider("go", "tokens", "syntax.tokens/v1").extensions(["go"]));
    let json = serde_json::to_value(&app).unwrap();
    assert_eq!(json["provides"][0]["type"], SYNTAX_PROVIDER_V1);
    assert_eq!(json["provides"][0]["id"], "go");
    assert_eq!(json["provides"][0]["extensions"][0], "go");
    assert_eq!(json["provides"][0]["command"], "tokens");
    assert_eq!(json["provides"][0]["returns"], "syntax.tokens/v1");
    // Interpreters are declared-empty, not absent — a consumer reads a list.
    assert_eq!(json["provides"][0]["interpreters"], json!([]));
    let back: AppSelfDoc = serde_json::from_value(json).unwrap();
    assert_eq!(back, app);
  }

  /// Forward compat, both directions: an entry whose `type` this binary has
  /// never heard of SURVIVES the parse and stays visible (callers ignore it by
  /// tag, they are never handed a manifest with it silently dropped), and an
  /// unknown FIELD on a known entry is tolerated rather than fatal.
  #[test]
  fn unknown_provide_types_survive_the_parse_and_stay_visible() {
    let wire = json!({
      "schema": "tsh.app/v1",
      "transport": "oneshot",
      "provides": [
        { "type": "syntax.provider/v1", "id": "go", "extensions": ["go"],
          "interpreters": [], "command": "tokens", "returns": "syntax.tokens/v1",
          "future_field": 7 },
        { "type": "formatter.provider/v9", "id": "go", "extensions": ["go"],
          "interpreters": [], "command": "format", "returns": "text/v1" }
      ],
      "commands": {}
    });
    let app: AppSelfDoc = serde_json::from_value(wire).expect("a future kind still parses");
    assert_eq!(app.provides.len(), 2, "nothing was dropped");
    assert_eq!(app.provides[1].type_tag, "formatter.provider/v9");
    // A syntax-only consumer filters by tag; the rest simply isn't its business.
    let syntax: Vec<&ProvideEntry> = app
      .provides
      .iter()
      .filter(|p| p.type_tag == SYNTAX_PROVIDER_V1)
      .collect();
    assert_eq!(syntax.len(), 1);
    assert_eq!(syntax[0].command, "tokens");
  }

  /// The self-doc CARRIES services on the same terms as provides: a declared
  /// service rides `--help --json` in the shape the supervisor reads, an app
  /// with none omits the key entirely (an older reader sees exactly the manifest
  /// it saw before), and the whole record round-trips. `health_path` is absent
  /// rather than null when undeclared — a probe is opt-in.
  #[test]
  fn app_self_doc_carries_services_and_omits_them_when_empty() {
    let bare = AppSelfDoc::new("oneshot");
    let json = serde_json::to_value(&bare).unwrap();
    assert!(json.get("services").is_none(), "empty is omitted: {json}");

    let mut app = AppSelfDoc::new("oneshot");
    app.services.push(ServiceDecl::http("board", "serve"));
    app
      .services
      .push(ServiceDecl::http("api", "api.serve").health_path("/health"));
    let json = serde_json::to_value(&app).unwrap();
    assert_eq!(json["services"][0]["kind"], SERVICE_KIND_HTTP);
    assert_eq!(json["services"][0]["id"], "board");
    assert_eq!(json["services"][0]["command"], "serve");
    assert!(
      json["services"][0].get("health_path").is_none(),
      "an undeclared probe is absent, not null: {json}"
    );
    assert_eq!(json["services"][1]["health_path"], "/health");
    let back: AppSelfDoc = serde_json::from_value(json).unwrap();
    assert_eq!(back, app);
  }

  /// Forward compat for the supervision plane: a service whose `kind` this
  /// binary has never heard of SURVIVES the parse and stays visible, so a
  /// supervisor skips it BY KIND rather than being handed a manifest with it
  /// silently dropped — and an unknown field on a known kind is tolerated.
  #[test]
  fn unknown_service_kinds_survive_the_parse_and_stay_visible() {
    let wire = json!({
      "schema": "tsh.app/v1",
      "transport": "oneshot",
      "services": [
        { "id": "board", "command": "serve", "kind": "http",
          "health_path": "/health", "future_field": 7 },
        { "id": "bus", "command": "bus.run", "kind": "grpc/v9" }
      ],
      "commands": {}
    });
    let app: AppSelfDoc = serde_json::from_value(wire).expect("a future kind still parses");
    assert_eq!(app.services.len(), 2, "nothing was dropped");
    assert_eq!(app.services[1].kind, "grpc/v9");
    // An http-only supervisor filters by kind; the rest simply isn't its business.
    let http: Vec<&ServiceDecl> = app
      .services
      .iter()
      .filter(|s| s.kind == SERVICE_KIND_HTTP)
      .collect();
    assert_eq!(http.len(), 1);
    assert_eq!(http[0].command, "serve");
    assert_eq!(http[0].health_path.as_deref(), Some("/health"));
  }

  /// A nested namespace deserializes as `Index` (loader can recurse or skip),
  /// while a flat app is all `Doc` — proving the recursive shape round-trips.
  #[test]
  fn nested_namespace_round_trips() {
    let mut fs = CommandIndex::default();
    fs.entries.insert(
      "list_dir".into(),
      CommandEntry::Doc(CommandDoc {
        name: "list_dir".into(),
        description: "list".into(),
        long_description: None,
        result: None,
        options: vec![],
      }),
    );
    let entry = CommandEntry::Index(fs);
    let json = serde_json::to_value(&entry).unwrap();
    assert_eq!(json["type"], "command.index/v1");
    assert_eq!(json["entries"]["list_dir"]["type"], "command.doc/v1");
    let back: CommandEntry = serde_json::from_value(json).unwrap();
    assert_eq!(back, entry);
  }

  /// A `command.doc/v1` record maps to a `sections/v1` (header + options table)
  /// and the result renders through the shape registry — the human `--help` path.
  #[test]
  fn doc_record_maps_to_a_renderable_sections_shape() {
    let doc = serde_json::to_value(CommandEntry::Doc(CommandDoc {
      name: "ls".into(),
      description: "list a directory".into(),
      long_description: None,
      result: None,
      options: vec![OptionDoc {
        name: "all".into(),
        kind: OptionKind::Flag,
        type_tok: None,
        help: Some("include hidden".into()),
        short: None,
        default: None,
        schema: None,
      }],
    }))
    .unwrap();
    let shape = reflect_shape(&doc).expect("doc maps to a shape");
    assert_eq!(shape["shape"], "sections/v1");
    assert_eq!(shape["sections"][0]["title"], "ls");
    assert_eq!(shape["sections"][0]["value"], "list a directory");
    assert_eq!(shape["sections"][1]["title"], "Options");
    assert_eq!(shape["sections"][1]["value"]["rows"][0][0], "all");
    assert_eq!(
      shape["sections"][1]["value"]["rows"][0][1],
      "include hidden"
    );
    // Renders through the same registry the CLI/TUI use.
    let text = tento_shapes::ShapeRegistry::core()
      .render_text(&shape)
      .expect("sections shape renders");
    assert!(text.contains("ls") && text.contains("all"), "got: {text}");
  }

  /// `DaemonDoc.scope`: an old manifest (no `scope` key) parses as detached
  /// (`None`), a detached doc omits the key on the wire, and a `"session"` doc
  /// round-trips.
  #[test]
  fn daemon_doc_scope_defaults_and_round_trips() {
    // Old manifest: no `scope` → None (detached).
    let old: DaemonDoc =
      serde_json::from_value(json!({ "socket": "/run/x.sock", "start": ["run"] })).unwrap();
    assert_eq!(old.scope, None);

    // Detached: the key is skipped on the wire so old readers stay happy.
    let detached = DaemonDoc {
      socket: "/run/x.sock".into(),
      start: vec!["run".into()],
      scope: None,
    };
    let v = serde_json::to_value(&detached).unwrap();
    assert!(v.get("scope").is_none(), "detached omits scope: {v}");

    // Session: derived socket (empty) + scope round-trips through JSON.
    let session = DaemonDoc {
      socket: String::new(),
      start: vec!["serve".into()],
      scope: Some(DaemonScope::Session),
    };
    let v = serde_json::to_value(&session).unwrap();
    assert_eq!(v["scope"], "session");
    let back: DaemonDoc = serde_json::from_value(v).unwrap();
    assert_eq!(back, session);

    // A newer producer's token remains readable and retains its spelling. The
    // current router can therefore reject it explicitly instead of silently
    // giving it detached lifetime semantics.
    let future: DaemonDoc = serde_json::from_value(json!({
      "socket": "",
      "start": ["serve"],
      "scope": "workspace"
    }))
    .unwrap();
    assert_eq!(future.scope, Some(DaemonScope::Other("workspace".into())));
    assert_eq!(serde_json::to_value(future).unwrap()["scope"], "workspace");
  }

  /// A `tsh.app/v1` root maps to a `table/v1` command menu; a namespace entry
  /// shows `(namespace)`. Non-reflection values map to `None`.
  #[test]
  fn app_record_maps_to_a_command_menu_table() {
    let mut app = AppSelfDoc::new("oneshot");
    app.commands.insert(
      "session".into(),
      CommandEntry::Doc(CommandDoc {
        name: "session".into(),
        description: "show the session".into(),
        long_description: None,
        result: None,
        options: vec![],
      }),
    );
    app
      .commands
      .insert("std".into(), CommandEntry::Index(CommandIndex::default()));
    let shape = reflect_shape(&serde_json::to_value(&app).unwrap()).expect("app maps to a shape");
    assert_eq!(shape["shape"], "table/v1");
    assert_eq!(shape["columns"][0]["header"], "COMMAND");
    let rows = shape["rows"].as_array().unwrap();
    assert!(
      rows.contains(&json!(["session", "show the session"])),
      "got: {shape}"
    );
    assert!(
      rows.contains(&json!(["std", "(namespace)"])),
      "got: {shape}"
    );
    // A plain value is not a reflection record.
    assert!(reflect_shape(&json!({"hello": "world"})).is_none());
  }

  /// The command menu never truncates a name: at 80 columns the COMMAND
  /// column is as wide as the longest name and DESCRIPTION takes the rest.
  #[test]
  fn a_command_menu_keeps_every_name_whole() {
    let long = "std.process.run-capturing-every-status";
    let index = json!({
      "type": "command.index/v1",
      "entries": {
        "ls": {"type": "command.doc/v1", "name": "ls", "description": "list"},
        long: {"type": "command.doc/v1", "name": long,
               "description": "Run a program under the declared session env; ANY exit status is data"},
      },
    });
    let shape = reflect_shape(&index).expect("an index maps to a menu");
    assert_eq!(shape["columns"][0]["min_width"], long.len());
    let out = tento_shapes::ShapeRegistry::core()
      .render(&shape, 80, &tento_shapes::RenderCtx::cli())
      .expect("the menu renders");
    let row = out.lines.iter().find(|line| line.contains(long)).unwrap_or_else(|| {
      panic!("the long name is whole: {:#?}", out.lines)
    });
    assert!(row.contains("Run a"), "the description keeps the rest: {row}");
    assert!(
      out.lines.iter().all(|line| tento_term::width::visual_width(line) <= 80),
      "{:#?}",
      out.lines
    );
  }

  /// A binary built before the `type` → `schema` rename still emits
  /// `type: tsh.app/v1` (with a `source_dir`); its root help still renders
  /// as the command menu.
  #[test]
  fn app_record_under_the_older_type_tag_maps_to_a_command_menu() {
    let older = json!({
      "type": TSH_APP_SCHEMA,
      "source_dir": "/build/checkout/app",
      "transport": "oneshot",
      "commands": {"session": {
        "type": "command.doc/v1", "name": "session", "description": "show the session",
      }},
    });
    let shape = reflect_shape(&older).expect("the older tag maps to a shape");
    assert_eq!(shape["shape"], "table/v1");
    assert_eq!(shape["rows"], json!([["session", "show the session"]]));
    assert!(reflect_shape(&json!({"type": "tsh.app/v2", "commands": {}})).is_none());
  }

  /// An unset identity stays off the wire — a packager that copies the doc
  /// verbatim must not write `""` into `manifest.json` — and a set one rides it.
  #[test]
  fn app_self_doc_omits_an_unset_identity() {
    let bare = serde_json::to_value(AppSelfDoc::new("oneshot")).unwrap();
    for key in ["name", "version", "entrypoint"] {
      assert!(bare.get(key).is_none(), "{key} must be omitted: {bare}");
    }
    let mut app = AppSelfDoc::new("oneshot");
    app.name = "weather".into();
    app.version = "1.2.0".into();
    app.entrypoint = "bin/weather".into();
    let json = serde_json::to_value(&app).unwrap();
    assert_eq!(json["name"], "weather");
    assert_eq!(json["version"], "1.2.0");
    assert_eq!(json["entrypoint"], "bin/weather");
    assert_eq!(serde_json::from_value::<AppSelfDoc>(json).unwrap(), app);
  }
}
