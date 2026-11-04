//! `account.kind/v1`: an app's account recipe as data.
//!
//! A kind says how one app keeps a named account apart from its others:
//! where the credential lives, which directory or variable isolates the app
//! per account, what it shares across accounts, how to log in, and how to ask
//! which account a login really is. It holds no code. The executor that runs
//! a kind lives with the process layer (`tento-app::auth::KindProvider`);
//! this module is the schema and its templates, and stays pure.
//!
//! A kind is JSON under `deny_unknown_fields`, so a misspelt field is an error
//! when the kind is read, not a setting that silently does nothing.
//!
//! # Templates
//!
//! String values may name placeholders in braces. Only these exist:
//!
//! | Placeholder | Value |
//! | --- | --- |
//! | `{home}` | the user's home directory |
//! | `{app}` | the kind's app |
//! | `{root}` | the native credential root (`credential.root`, or the first of its `fallback` stores while the default does not exist) |
//! | `{alias}` | the account alias |
//! | `{id}` | the catalog profile ID |
//! | `{profile_dir}` | `<catalog root>/<app>/<id>` |
//! | `{locator}` | the native credential locator |
//! | `{config_dir}` | the per-account config directory (`config_dir`) |
//! | `{cli}` | the resolved app executable |
//! | `{sid}` | the conversation being resumed |
//! | `{label}` | the account label a login must produce |
//! | `{key}` | the first column of a legacy import row |
//! | `{secrets}` | one secret-store base (`tento_secrets::store::candidate_base_dirs`); only in `credential.root.fallback[].path` |
//! | `{store}` | the app's own store as [`Presence::store`] finds it; only in `presence.account_file.path` |
//! | `{sha256_8:<name>}` | the first 8 hex digits of SHA-256 of another placeholder |
//!
//! An unknown placeholder, a stray brace, or a placeholder the field cannot
//! know yet (a locator cannot name `{id}`: the ID is assigned after the
//! locator is chosen) is refused. A template that expands to a path must be
//! absolute and may not contain a `..` component.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// The schema tag every kind carries.
pub const KIND_V1: &str = "account.kind/v1";

/// Every placeholder a template may name.
pub const PLACEHOLDERS: &[&str] = &[
  "home",
  "app",
  "root",
  "alias",
  "id",
  "profile_dir",
  "locator",
  "config_dir",
  "cli",
  "sid",
  "label",
  "key",
  "secrets",
  "store",
];

/// Placeholders known when a native locator is chosen (before an ID exists).
const LOCATOR_SCOPE: &[&str] = &["home", "app", "root", "alias", "key"];
/// Placeholders known when the credential root is chosen.
const ROOT_SCOPE: &[&str] = &["home", "app"];
/// Placeholders known for a whole import (not one of its rows).
const IMPORT_SCOPE: &[&str] = &["home", "app", "root"];
/// Placeholders a credential root fallback may name: the root's, and the
/// secret-store base it is tried under.
const FALLBACK_SCOPE: &[&str] = &["home", "app", "secrets"];
/// Placeholders known for the app's own login (no account is selected).
const NATIVE_SCOPE: &[&str] = &["home", "app"];
/// Placeholders known for the app's own secret: those, and its locator.
const NATIVE_SECRET_SCOPE: &[&str] = &["home", "app", "locator"];
/// Placeholders known for the file naming the app's own account: those of
/// its login, and the store [`Presence::store`] found.
const PRESENCE_SCOPE: &[&str] = &["home", "app", "store"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AccountKind {
  /// Always [`KIND_V1`].
  pub schema: String,
  /// The app this kind serves; the catalog's app name.
  pub app: String,
  /// One line for `profiles list` and the docs.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
  /// How the app's executable is found.
  pub cli: Cli,
  /// Where an account's credential lives.
  pub credential: KindCredential,
  /// The per-account config directory, created private (0700) at launch.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub config_dir: Option<String>,
  /// Entries linked from a shared directory into `config_dir`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub shared: Option<Shared>,
  /// Environment the launch sets. Values are references, never tokens.
  #[serde(default)]
  pub env: BTreeMap<String, String>,
  /// Environment the launch removes, in this order: a named account's
  /// isolation from the caller's own authentication. The app's own login
  /// ([`NativeLogin`]) removes only its `unset_env` instead.
  #[serde(default)]
  pub remove_env: Vec<String>,
  /// The launch argv; `["{cli}"]` when omitted.
  #[serde(default = "default_argv")]
  pub argv: Vec<String>,
  /// The terminal login command.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub login: Option<Login>,
  /// How the executor learns which account a login is.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub verify: Option<Verify>,
  /// Settings files that must not override the selected account. They guard
  /// named accounts; the app's own login ([`NativeLogin`]) is whatever the
  /// app's settings make it, and is not checked.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub guards: Option<Guards>,
  /// Exact-resume rules. A kind without them cannot resume a conversation.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub resume: Option<Resume>,
  /// A one-time import of accounts recorded before the catalog existed.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub import: Option<Import>,
  /// Whether a running instance can change accounts between calls.
  #[serde(default)]
  pub rebind_between_calls: bool,
  /// How to tell, from outside and without touching a credential, which
  /// login a running instance of the app is on. None declared: nothing is
  /// shown for it.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub presence: Option<Presence>,
}

/// Which login an app not bound to a named account is running on, read for
/// presentation only: no credential is selected, changed or read for its
/// value, and only a token variable's NAME is ever reported.
///
/// In order: a non-empty variable of `token_env` means the app runs on that
/// token. Otherwise the app's own store is the first of `store.env` that is
/// set, else `store.default`; `account_file` names the JSON file there that
/// says which account it is, read with `identity`. A file matching any of
/// `api_key_when` is an API-key login, named by the file, not an account.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Presence {
  /// Variables whose non-empty value is the app's credential.
  #[serde(default)]
  pub token_env: Vec<String>,
  /// Where the app keeps its own login.
  pub store: StoreLocation,
  /// The file naming the account.
  pub account_file: AccountFile,
  /// How the account file names the account.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub identity: Option<Identity>,
  /// Tests that make the account file an API-key login.
  #[serde(default)]
  pub api_key_when: Vec<JsonTest>,
  /// Substrings of a lane's command that mean a launcher chose the account
  /// (the launcher reports it, not the app's own store).
  #[serde(default)]
  pub launchers: Vec<String>,
}

/// A directory the app finds through the first set variable of `env`, else
/// at `default` (`{home}`, `{app}`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StoreLocation {
  #[serde(default)]
  pub env: Vec<String>,
  pub default: String,
}

/// The account file: `path` (with `{store}`), except that `default` (when
/// given) is used while the store is at `store.default` and none of
/// `placed_by` is set. That is an app which keeps its account file outside
/// its default store, and moves it into the store when the store is moved
/// or when one of `placed_by` relocates its configuration (even onto the
/// default directory).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AccountFile {
  pub path: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default: Option<String>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub placed_by: Vec<String>,
}

/// JSON pointers into the account file: the account's id, and its label
/// (an email, say), which may be read from a JWT's claim.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Identity {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub id: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label: Option<String>,
  /// The label pointer names a JWT; the label is this claim of its payload.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label_jwt_claim: Option<String>,
}

/// A string at `json_pointer`: equal to `equals`, or non-empty when none.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct JsonTest {
  pub json_pointer: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub equals: Option<String>,
}

fn default_argv() -> Vec<String> {
  vec!["{cli}".into()]
}

/// A directory the user may move with an environment variable.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Setting {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub env: Option<String>,
  pub default: String,
  /// Directories used instead of `default` while nothing exists there: the
  /// first that holds its `marker` wins. A path naming `{secrets}` is tried
  /// under each secret-store base in turn, in the store's own order. The
  /// variable, when set, still wins over all of them. None declared (the
  /// default) is `default` alone.
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub fallback: Vec<Fallback>,
}

/// Another app's store with the same layout, adopted while the kind's own
/// directory does not exist yet.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Fallback {
  /// The directory: a template with `default`'s placeholders, and
  /// `{secrets}`.
  pub path: String,
  /// A file, relative to `path`, whose presence says a store lives there.
  pub marker: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Cli {
  /// A variable naming the executable; when set it must name a file.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub env: Option<String>,
  /// The executable's name, searched on `PATH`.
  pub name: String,
  /// Paths tried, in order, when `PATH` has no `name`.
  #[serde(default)]
  pub fallback: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "backend", rename_all = "snake_case", deny_unknown_fields)]
pub enum KindCredential {
  /// The app keeps the credential in its own store, at a per-account
  /// locator. Refresh stays the app's job; nothing is copied.
  Native {
    root: Setting,
    locator: String,
    /// Where the app's secret can be read, when a verifier needs a bearer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret: Option<SecretSource>,
  },
  /// A vault value (`namespace/name`) handed to the app through `bind`.
  Vault {
    namespace: String,
    name: String,
    bind: Bind,
  },
  /// A core-owned credential directory (`TSH_AUTH_CREDENTIAL_DIR`).
  Local,
}

/// How a vault credential reaches the app (E-A2: an env value is plaintext in
/// the child's environment, so a kind must say so).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Bind {
  /// The value itself, in this variable.
  Env(String),
  /// The path of a minted 0400 file, in this variable.
  File(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SecretSource {
  /// A macOS keychain generic-password service, read for the current user.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub keychain_service: Option<String>,
  /// A JSON file, read when the keychain has no item.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub file: Option<String>,
  /// The secret's JSON pointer inside the item or file.
  pub json_pointer: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Shared {
  /// The directory whose entries every account shares.
  pub from: String,
  /// Entry names linked when they exist in `from`.
  pub names: Vec<String>,
  /// Entries created (0700) in `from` first, so they are always shared.
  #[serde(default)]
  pub create: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Login {
  /// Arguments after the launch argv.
  pub args: Vec<String>,
  /// Arguments added when the account's expected label is known.
  #[serde(default)]
  pub label_args: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExpectedLabel {
  /// No expectation.
  #[default]
  None,
  /// The locator's last component, when it looks like an email address.
  LocatorBasenameIfEmail,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Verify {
  /// A command whose output says whether the app is signed in.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub precheck: Option<Precheck>,
  /// An HTTPS identity endpoint called with the native secret as a bearer.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub http: Option<HttpIdentity>,
  /// A JSON file the app writes, read for the account identity.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub file: Option<FileIdentity>,
  /// Files that exist only once the account is signed in.
  #[serde(default)]
  pub present: Vec<String>,
  #[serde(default)]
  pub expected_label: ExpectedLabel,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Precheck {
  /// Arguments after the launch argv.
  pub args: Vec<String>,
  /// JSON pointer → required value in the command's stdout. When empty, the
  /// exit status decides.
  #[serde(default)]
  pub expect: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HttpIdentity {
  pub url: String,
  /// JSON pointers into the response.
  pub id: String,
  pub label: String,
  /// Statuses that mean the credential is no longer valid.
  #[serde(default = "default_unauthorized")]
  pub unauthorized: Vec<u16>,
}

fn default_unauthorized() -> Vec<u16> {
  vec![401, 403]
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FileIdentity {
  pub path: String,
  /// JSON pointer to the account ID.
  pub id: String,
  /// JSON pointer to the label (or to a JWT holding it).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label: Option<String>,
  /// When set, `label` points at a JWT and the label is this claim of its
  /// payload. The token is decoded, not verified: it names an account for
  /// display and is never trusted for anything else.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub label_jwt_claim: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Guards {
  /// Settings files checked as they are.
  #[serde(default)]
  pub files: Vec<String>,
  /// Settings files checked relative to the working directory and each of
  /// its ancestors.
  #[serde(default)]
  pub cwd_files: Vec<String>,
  /// JSON pointers whose presence overrides the selected account.
  #[serde(default)]
  pub forbidden_keys: Vec<String>,
  /// A JSON pointer to an environment object in the settings. It may not
  /// set a variable the launch removes, nor one of `forbidden_env`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub env_object: Option<String>,
  #[serde(default)]
  pub forbidden_env: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Resume {
  /// Flags taking the exact conversation ID (`--resume ID`, `--resume=ID`).
  #[serde(default)]
  pub exact: Vec<String>,
  /// Flags refused outright (an inexact resume).
  #[serde(default)]
  pub refuse: Vec<String>,
  /// Flags refused alongside an exact resume.
  #[serde(default)]
  pub refuse_with_resume: Vec<String>,
  /// Variables captured from the caller's environment for a direct CLI run.
  #[serde(default)]
  pub source_env: Vec<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub history: Option<History>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub busy: Option<Busy>,
  /// The only spelling of a conversation ID this app resumes by. It is
  /// checked before the conversation is locked, so one conversation has one
  /// lock.
  #[serde(default, skip_serializing_if = "ConversationId::is_any")]
  pub id: ConversationId,
}

/// Which conversation IDs a kind resumes by.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationId {
  /// Whatever the app takes.
  #[default]
  Any,
  /// A UUID in canonical form: lowercase hex, hyphenated 8-4-4-4-12. An app
  /// that also resumes by a session name, or by another spelling of the UUID,
  /// would lock one conversation under several keys, so anything else is
  /// refused rather than normalised. A name could only be resolved through
  /// the app's own per-account index.
  Uuid,
}

impl ConversationId {
  pub fn is_any(&self) -> bool {
    *self == ConversationId::Any
  }

  /// Refuse `id` unless it is this contract's spelling.
  pub fn check(self, app: &str, id: &str) -> Result<()> {
    match self {
      ConversationId::Any => Ok(()),
      ConversationId::Uuid => {
        let canonical = id.len() == 36
          && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_digit() || ('a'..='f').contains(&c),
          });
        ensure!(
          canonical,
          "Resume a {app} conversation by its session UUID (lowercase and hyphenated, \
           8-4-4-4-12), not {id:?}: a session name or another spelling of the UUID \
           is refused"
        );
        Ok(())
      }
    }
  }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct History {
  /// The directory holding one subdirectory per project.
  pub dir: String,
  /// The conversation file inside a project directory.
  pub file: String,
  /// A source variable naming another config root; its `source_subdir`
  /// must be this same store, or the conversation is not resumable here.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub source_env: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub source_subdir: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Busy {
  /// Arguments after the launch argv; stdout is JSON.
  pub args: Vec<String>,
  /// The config variables the probe runs under (the source's, then the
  /// target's).
  pub env: Vec<String>,
  /// Keys whose string value may equal the conversation ID.
  pub id_keys: Vec<String>,
  /// Keys holding a status, first present wins.
  pub status_keys: Vec<String>,
  /// Statuses that mean not busy.
  pub idle: Vec<String>,
  /// A node with this key and value is the interactive owner; a lane switch
  /// ignores it on the source side.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub interactive: Option<KeyValue>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct KeyValue {
  pub key: String,
  pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Import {
  /// A tab-separated file of `key<TAB>alias` rows; `#` lines are comments.
  pub tsv: String,
  /// The locator of an imported row (`{key}` is its first column).
  pub locator: String,
  /// A pointer file naming the row that is the app's default account, by
  /// its key or by its alias (with or without a leading `@`). A bare key
  /// wins over another row's alias; `@alias` selects only by alias. Each
  /// import makes that row the default, so a switch recorded there is followed. A
  /// missing or empty file, or one naming no row, leaves the default alone;
  /// so does a kind that declares none (the default).
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default_from: Option<String>,
  /// The app's own login, imported as a profile when there is no table:
  /// someone who only installed the app and signed in has switching
  /// available at once. None declared (the default) imports nothing.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub native: Option<NativeLogin>,
}

/// The login the app uses when no account is selected, as a profile.
///
/// The profile's locator is the app's own location, and a launch of it
/// leaves the app on its own configuration and its own authentication: no
/// per-account directory, no links, `unset_env` unset and removed, and
/// nothing else removed (the kind's `remove_env` and `guards` are for named
/// accounts; an API key, token, key helper or provider selection the app
/// would use without the shell, it uses here too). The kind's other `env`
/// (lane markers) is still set. Nothing under the locator, and no keychain
/// item, is ever created, copied, moved or written. It is imported once,
/// when the kind's import table does not exist and no profile has the
/// locator yet, and becomes the app's default when the app has none and
/// `alias_from` names an account (a real sign-in); that check and the write
/// are one catalog transaction, so a default chosen meanwhile is kept. Its
/// identity check never blocks it: a login that cannot be confirmed, or
/// names another account than the cache or than the one the profile was
/// confirmed as, is logged and launched unverified. A profile confirmed
/// before is demoted for that launch: not `Ready`, and no identity
/// presented, while the catalog keeps the account it was bound to.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NativeLogin {
  /// The app's own config location (`{home}`, `{app}`).
  pub locator: String,
  /// Files that exist once the app has been used; with any missing there is
  /// nothing to import.
  #[serde(default)]
  pub present: Vec<String>,
  /// Where the app caches its account name, to name the profile. It must
  /// not be a secret: it is only read, and never needs the network.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub alias_from: Option<AliasSource>,
  /// The alias when none can be read, or the read one is taken.
  pub default_alias: String,
  /// Variables that would move the app off its own login (onto another
  /// account's store). For this profile they are not set, and they are the
  /// only variables its launch removes.
  #[serde(default)]
  pub unset_env: Vec<String>,
  /// Where the app's own secret is read, for the identity check; the kind's
  /// `credential.secret` is for its accounts' stores.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub secret: Option<SecretSource>,
}

/// A string in a JSON file.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AliasSource {
  pub file: String,
  pub json_pointer: String,
}

/// An alias made from a cached account name: the part before any `@`, with
/// every character an alias cannot hold made `-`, and no `-` at either end.
/// `None` when nothing is left.
pub fn native_alias(name: &str) -> Option<String> {
  let local = name.split('@').next().unwrap_or_default();
  let alias: String = local
    .chars()
    .map(|c| {
      if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
        c
      } else {
        '-'
      }
    })
    .collect();
  let alias = alias.trim_matches('-');
  (!alias.is_empty() && alias.len() <= 128).then(|| alias.to_owned())
}

/// Whether `template` names the placeholder `name` (plainly or hashed).
pub fn names_placeholder(template: &str, name: &str) -> bool {
  pieces(template).is_ok_and(|pieces| {
    pieces
      .iter()
      .any(|piece| matches!(piece, Piece::Var(n) | Piece::Sha256(n) if *n == name))
  })
}

impl Import {
  /// Whether a pointer file's `content` names the row `key<TAB>alias`.
  pub fn names(content: &str, key: &str, alias: &str) -> bool {
    let content = content.trim();
    !content.is_empty() && (content == key || content.trim_start_matches('@') == alias)
  }
}

impl AccountKind {
  /// Parse and check a kind. Every template is checked here, so a kind
  /// that names an unknown placeholder never loads.
  pub fn parse(json: &str) -> Result<Self> {
    let kind: Self = serde_json::from_str(json).context("Invalid account kind")?;
    kind.check()?;
    Ok(kind)
  }

  pub fn check(&self) -> Result<()> {
    ensure!(
      self.schema == KIND_V1,
      "Account kind schema must be {KIND_V1}"
    );
    crate::accounts::component(&self.app).context("Invalid account kind app")?;
    ensure!(
      !self.cli.name.is_empty(),
      "Account kind names no executable"
    );
    ensure!(!self.argv.is_empty(), "Account kind argv is empty");
    // `{secrets}` exists only where a root fallback is tried, and `{store}`
    // only in the presence account file.
    let general: Vec<&str> = PLACEHOLDERS
      .iter()
      .copied()
      .filter(|name| *name != "secrets" && *name != "store")
      .collect();
    for (key, value) in &self.env {
      ensure!(env_name(key), "Invalid environment name {key:?}");
      check_template(value, &general)?;
    }
    for key in &self.remove_env {
      ensure!(env_name(key), "Invalid environment name {key:?}");
    }
    for template in self.all_templates() {
      check_template(template, &general)?;
    }
    match &self.credential {
      KindCredential::Native { root, locator, .. } => {
        check_template(&root.default, ROOT_SCOPE)?;
        for fallback in &root.fallback {
          check_template(&fallback.path, FALLBACK_SCOPE)?;
          let marker = Path::new(&fallback.marker);
          ensure!(
            !fallback.marker.is_empty()
              && marker
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
            "Invalid credential root marker {:?}",
            fallback.marker
          );
        }
        check_template(locator, LOCATOR_SCOPE)?;
        if let Some(env) = &root.env {
          ensure!(env_name(env), "Invalid environment name {env:?}");
        }
      }
      KindCredential::Vault {
        namespace,
        name,
        bind,
      } => {
        crate::accounts::component(namespace).context("Invalid vault namespace")?;
        check_template(name, &["alias"])?;
        let (Bind::Env(var) | Bind::File(var)) = bind;
        ensure!(env_name(var), "Invalid environment name {var:?}");
      }
      KindCredential::Local => {}
    }
    if let Some(import) = &self.import {
      check_template(&import.locator, LOCATOR_SCOPE)?;
      if let Some(pointer) = &import.default_from {
        check_template(pointer, IMPORT_SCOPE)?;
      }
      if let Some(native) = &import.native {
        check_template(&native.locator, NATIVE_SCOPE)?;
        for file in &native.present {
          check_template(file, NATIVE_SCOPE)?;
        }
        if let Some(from) = &native.alias_from {
          check_template(&from.file, NATIVE_SCOPE)?;
        }
        crate::accounts::component(&native.default_alias)
          .context("Invalid native login default alias")?;
        for var in &native.unset_env {
          ensure!(env_name(var), "Invalid environment name {var:?}");
        }
        if let Some(secret) = &native.secret {
          for template in secret.keychain_service.iter().chain(&secret.file) {
            check_template(template, NATIVE_SECRET_SCOPE)?;
          }
        }
      }
    }
    if let Some(cli) = &self.cli.env {
      ensure!(env_name(cli), "Invalid environment name {cli:?}");
    }
    if let Some(presence) = &self.presence {
      for var in presence
        .token_env
        .iter()
        .chain(&presence.store.env)
        .chain(&presence.account_file.placed_by)
      {
        ensure!(env_name(var), "Invalid environment name {var:?}");
      }
      check_template(&presence.store.default, NATIVE_SCOPE)?;
      check_template(&presence.account_file.path, PRESENCE_SCOPE)?;
      if let Some(default) = &presence.account_file.default {
        check_template(default, NATIVE_SCOPE)?;
      }
      let identity = presence
        .identity
        .iter()
        .flat_map(|i| i.id.iter().chain(&i.label));
      for pointer in identity.chain(presence.api_key_when.iter().map(|t| &t.json_pointer)) {
        ensure!(
          pointer.is_empty() || pointer.starts_with('/'),
          "Invalid JSON pointer {pointer:?}"
        );
      }
      for launcher in &presence.launchers {
        ensure!(!launcher.trim().is_empty(), "Empty presence launcher");
      }
    }
    Ok(())
  }

  /// Every template this kind holds outside the credential root/locator,
  /// which have narrower scopes.
  fn all_templates(&self) -> Vec<&String> {
    let mut all: Vec<&String> = self.argv.iter().chain(&self.cli.fallback).collect();
    all.extend(&self.config_dir);
    if let Some(shared) = &self.shared {
      all.push(&shared.from);
    }
    if let Some(login) = &self.login {
      all.extend(&login.args);
      all.extend(&login.label_args);
    }
    if let KindCredential::Native {
      secret: Some(secret),
      ..
    } = &self.credential
    {
      all.extend(&secret.keychain_service);
      all.extend(&secret.file);
    }
    if let Some(verify) = &self.verify {
      if let Some(p) = &verify.precheck {
        all.extend(&p.args);
      }
      if let Some(h) = &verify.http {
        all.push(&h.url);
      }
      if let Some(f) = &verify.file {
        all.push(&f.path);
      }
      all.extend(&verify.present);
    }
    if let Some(guards) = &self.guards {
      all.extend(&guards.files);
    }
    if let Some(resume) = &self.resume {
      if let Some(h) = &resume.history {
        all.push(&h.dir);
        all.push(&h.file);
      }
      if let Some(b) = &resume.busy {
        all.extend(&b.args);
      }
    }
    if let Some(import) = &self.import {
      all.push(&import.tsv);
    }
    all
  }
}

fn env_name(name: &str) -> bool {
  !name.is_empty()
    && !name.starts_with(|c: char| c.is_ascii_digit())
    && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The pieces of a template: literal text and placeholder names.
enum Piece<'a> {
  Text(&'a str),
  Var(&'a str),
  Sha256(&'a str),
}

fn pieces(template: &str) -> Result<Vec<Piece<'_>>> {
  let mut out = Vec::new();
  let mut rest = template;
  while let Some(open) = rest.find(['{', '}']) {
    ensure!(
      rest.as_bytes()[open] == b'{',
      "Stray '}}' in template {template:?}"
    );
    if open > 0 {
      out.push(Piece::Text(&rest[..open]));
    }
    let after = &rest[open + 1..];
    let close = after
      .find('}')
      .with_context(|| format!("Unclosed placeholder in template {template:?}"))?;
    let name = &after[..close];
    ensure!(
      !name.contains('{'),
      "Nested placeholder in template {template:?}"
    );
    out.push(match name.strip_prefix("sha256_8:") {
      Some(inner) => Piece::Sha256(inner),
      None => Piece::Var(name),
    });
    rest = &after[close + 1..];
  }
  if !rest.is_empty() {
    out.push(Piece::Text(rest));
  }
  Ok(out)
}

/// Refuse a template naming a placeholder outside `scope`.
pub fn check_template(template: &str, scope: &[&str]) -> Result<()> {
  for piece in pieces(template)? {
    if let Piece::Var(name) | Piece::Sha256(name) = piece {
      ensure!(
        PLACEHOLDERS.contains(&name),
        "Unknown placeholder {{{name}}} in template {template:?}"
      );
      ensure!(
        scope.contains(&name),
        "Placeholder {{{name}}} is not known where template {template:?} is used"
      );
    }
  }
  Ok(())
}

/// The placeholder values one expansion may use. A name that has no value
/// yet (no conversation, no label) fails the expansion that names it.
#[derive(Clone, Debug, Default)]
pub struct Vars(BTreeMap<&'static str, String>);

impl Vars {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn set(&mut self, name: &'static str, value: impl Into<String>) -> &mut Self {
    debug_assert!(PLACEHOLDERS.contains(&name), "{name}");
    self.0.insert(name, value.into());
    self
  }

  pub fn with(mut self, name: &'static str, value: impl Into<String>) -> Self {
    self.set(name, value);
    self
  }

  pub fn get(&self, name: &str) -> Option<&str> {
    self.0.get(name).map(String::as_str)
  }

  pub fn has(&self, name: &str) -> bool {
    self.0.contains_key(name)
  }

  /// Expand a template.
  pub fn expand(&self, template: &str) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut out = String::new();
    for piece in pieces(template)? {
      match piece {
        Piece::Text(text) => out.push_str(text),
        Piece::Var(name) => out.push_str(self.value(name, template)?),
        Piece::Sha256(name) => {
          let digest = hex::encode(Sha256::digest(self.value(name, template)?.as_bytes()));
          out.push_str(&digest[..8]);
        }
      }
    }
    Ok(out)
  }

  fn value(&self, name: &str, template: &str) -> Result<&str> {
    ensure!(
      PLACEHOLDERS.contains(&name),
      "Unknown placeholder {{{name}}} in template {template:?}"
    );
    self
      .get(name)
      .with_context(|| format!("Placeholder {{{name}}} has no value for template {template:?}"))
  }

  /// Expand a template that names a path: absolute, and no `..`.
  pub fn expand_path(&self, template: &str) -> Result<PathBuf> {
    let path = PathBuf::from(self.expand(template)?);
    checked_path(&path)?;
    Ok(path)
  }
}

/// A path a kind may name: absolute, with no `..` component.
pub fn checked_path(path: &Path) -> Result<()> {
  ensure!(
    path.is_absolute(),
    "Account kind path {} is not absolute",
    path.display()
  );
  if path.components().any(|c| matches!(c, Component::ParentDir)) {
    bail!("Account kind path {} may not contain '..'", path.display());
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  const MINIMAL: &str = r#"{
    "schema": "account.kind/v1",
    "app": "fixture",
    "cli": {"name": "fixture"},
    "credential": {"backend": "native", "root": {"default": "{home}/accounts"}, "locator": "{root}/{alias}"}
  }"#;

  #[test]
  fn a_minimal_kind_parses_and_defaults_its_argv() {
    let kind = AccountKind::parse(MINIMAL).unwrap();
    assert_eq!(kind.argv, vec!["{cli}"]);
    assert!(!kind.rebind_between_calls);
    assert!(kind.resume.is_none());
  }

  #[test]
  fn unknown_fields_are_refused_at_every_level() {
    let top = MINIMAL.replacen("\"app\"", "\"colour\": 1, \"app\"", 1);
    assert!(AccountKind::parse(&top).is_err());
    let nested = MINIMAL.replace(
      "\"name\": \"fixture\"",
      "\"name\": \"fixture\", \"path\": 1",
    );
    assert!(AccountKind::parse(&nested).is_err());
    let schema = MINIMAL.replace("account.kind/v1", "account.kind/v2");
    assert!(AccountKind::parse(&schema).is_err());
    let app = MINIMAL.replace("\"app\": \"fixture\"", "\"app\": \"../x\"");
    assert!(AccountKind::parse(&app).is_err());
  }

  /// MINIMAL with `presence` set to `json`.
  fn with_presence(json: &str) -> String {
    MINIMAL.replacen("\"cli\"", &format!("\"presence\": {json}, \"cli\""), 1)
  }

  #[test]
  fn presence_describes_the_apps_own_login_as_data() {
    // A store a variable chain can move, and an account file that sits
    // outside the default store.
    let kind = AccountKind::parse(&with_presence(
      r#"{"token_env": ["FIXTURE_TOKEN"],
          "store": {"env": ["FIXTURE_SECURE_DIR", "FIXTURE_CONFIG_DIR"], "default": "{home}/.fixture"},
          "account_file": {"path": "{store}/.fixture.json", "default": "{home}/.fixture.json",
                           "placed_by": ["FIXTURE_CONFIG_DIR"]},
          "identity": {"id": "/account/id", "label": "/account/email"},
          "api_key_when": [{"json_pointer": "/mode", "equals": "apikey"}, {"json_pointer": "/API_KEY"}],
          "launchers": ["fixture-launch"]}"#,
    ))
    .unwrap();
    let presence = kind.presence.unwrap();
    assert_eq!(
      presence.store.env,
      ["FIXTURE_SECURE_DIR", "FIXTURE_CONFIG_DIR"]
    );
    assert_eq!(
      presence.account_file.default.as_deref(),
      Some("{home}/.fixture.json")
    );
    assert_eq!(presence.account_file.placed_by, ["FIXTURE_CONFIG_DIR"]);
    assert_eq!(presence.api_key_when[1].equals, None);
    assert!(AccountKind::parse(MINIMAL).unwrap().presence.is_none());
  }

  #[test]
  fn presence_is_checked_like_the_rest_of_a_kind() {
    let base = r#"{"store": {"default": "{home}/.f"}, "account_file": {"path": "{store}/a.json"}}"#;
    assert!(AccountKind::parse(&with_presence(base)).is_ok());
    // `{store}` exists only in the account file's path.
    let store_default = base.replace("{home}/.f", "{store}/.f");
    assert!(AccountKind::parse(&with_presence(&store_default)).is_err());
    let elsewhere = MINIMAL.replacen("\"cli\"", "\"env\": {\"X\": \"{store}\"}, \"cli\"", 1);
    assert!(AccountKind::parse(&elsewhere).is_err());
    let bad_env = base.replace("\"default\"", "\"env\": [\"A B\"], \"default\"");
    assert!(AccountKind::parse(&with_presence(&bad_env)).is_err());
    let pointer = base.replace("}}", "}, \"identity\": {\"id\": \"account/id\"}}");
    assert!(
      format!(
        "{:#}",
        AccountKind::parse(&with_presence(&pointer)).unwrap_err()
      )
      .contains("JSON pointer")
    );
    let unknown = base.replace("}}", "}, \"colour\": 1}");
    assert!(AccountKind::parse(&with_presence(&unknown)).is_err());
  }

  #[test]
  fn templates_refuse_unknown_and_out_of_scope_placeholders() {
    let unknown = MINIMAL.replace("{root}/{alias}", "{root}/{user}");
    assert!(
      format!("{:#}", AccountKind::parse(&unknown).unwrap_err()).contains("Unknown placeholder")
    );
    // The locator is chosen before the catalog assigns an ID.
    let early = MINIMAL.replace("{root}/{alias}", "{root}/{id}");
    assert!(format!("{:#}", AccountKind::parse(&early).unwrap_err()).contains("not known"));
    let env = MINIMAL.replacen("\"cli\"", "\"env\": {\"X\": \"{nope}\"}, \"cli\"", 1);
    assert!(AccountKind::parse(&env).is_err());
    let bad_name = MINIMAL.replacen("\"cli\"", "\"env\": {\"A B\": \"x\"}, \"cli\"", 1);
    assert!(AccountKind::parse(&bad_name).is_err());
    for template in ["{", "}", "a{b", "{a{b}}", "x}"] {
      assert!(
        check_template(template, PLACEHOLDERS).is_err(),
        "{template}"
      );
    }
  }

  #[test]
  fn expansion_fills_values_hashes_and_refuses_parent_components() {
    let vars = Vars::new()
      .with("home", "/home/user")
      .with("alias", "work")
      .with("locator", "/store/cred/a@example.com");
    assert_eq!(
      vars.expand("{home}/x/{alias}").unwrap(),
      "/home/user/x/work"
    );
    // SHA-256 of the locator, first 8 hex digits.
    let digest = {
      use sha2::{Digest, Sha256};
      hex::encode(Sha256::digest(b"/store/cred/a@example.com"))[..8].to_string()
    };
    assert_eq!(
      vars.expand("Service-{sha256_8:locator}").unwrap(),
      format!("Service-{digest}")
    );
    assert!(vars.expand("{sid}").is_err(), "a placeholder with no value");
    assert!(vars.expand("{user}").is_err());
    assert!(vars.expand_path("relative/{alias}").is_err());
    assert!(vars.expand_path("{home}/../{alias}").is_err());
    let escape = Vars::new().with("home", "/home/user").with("alias", "..");
    assert!(escape.expand_path("{home}/{alias}").is_err());
    assert_eq!(
      vars.expand_path("{home}/{alias}").unwrap(),
      PathBuf::from("/home/user/work")
    );
  }

  #[test]
  fn a_vault_credential_names_its_binding() {
    let vault = MINIMAL.replace(
      r#"{"backend": "native", "root": {"default": "{home}/accounts"}, "locator": "{root}/{alias}"}"#,
      r#"{"backend": "vault", "namespace": "grok", "name": "api-key-{alias}", "bind": {"env": "XAI_API_KEY"}}"#,
    );
    let kind = AccountKind::parse(&vault).unwrap();
    assert_eq!(
      kind.credential,
      KindCredential::Vault {
        namespace: "grok".into(),
        name: "api-key-{alias}".into(),
        bind: Bind::Env("XAI_API_KEY".into()),
      }
    );
    let outside = vault.replace("api-key-{alias}", "api-key-{home}");
    assert!(AccountKind::parse(&outside).is_err());
    let namespace = vault.replace("\"grok\"", "\"../grok\"");
    assert!(AccountKind::parse(&namespace).is_err());
  }

  #[test]
  fn a_root_fallback_and_a_default_pointer_are_optional_and_checked() {
    let plain = AccountKind::parse(MINIMAL).unwrap();
    let KindCredential::Native { root, .. } = &plain.credential else {
      panic!("native")
    };
    assert!(root.fallback.is_empty(), "none declared: the default alone");
    assert!(
      serde_json::to_value(&plain).unwrap()["credential"]["root"]
        .get("fallback")
        .is_none(),
      "an undeclared fallback is not written back"
    );

    let declared = MINIMAL.replace(
      r#""root": {"default": "{home}/accounts"}"#,
      r#""root": {"default": "{home}/accounts", "fallback": [{"path": "{home}/other/{app}", "marker": "profiles.tsv"}]}"#,
    );
    let kind = AccountKind::parse(&declared).unwrap();
    let KindCredential::Native { root, .. } = &kind.credential else {
      panic!("native")
    };
    assert_eq!(
      root.fallback,
      vec![Fallback {
        path: "{home}/other/{app}".into(),
        marker: "profiles.tsv".into()
      }]
    );
    // A fallback is chosen before any account exists: it cannot name one.
    let early = declared.replace("{home}/other/{app}", "{home}/other/{alias}");
    assert!(format!("{:#}", AccountKind::parse(&early).unwrap_err()).contains("not known"));
    for marker in ["", "/abs", "../up", "a/../b", "."] {
      let bad = declared.replace("\"profiles.tsv\"", &format!("{marker:?}"));
      assert!(AccountKind::parse(&bad).is_err(), "marker {marker:?}");
    }
    let nested = declared.replace("\"marker\"", "\"when\": 1, \"marker\"");
    assert!(
      AccountKind::parse(&nested).is_err(),
      "unknown fallback field"
    );

    let import = |extra: &str| {
      MINIMAL.replacen(
        "\"cli\"",
        &format!(
          "\"import\": {{\"tsv\": \"{{root}}/t.tsv\", \"locator\": \"{{root}}/{{key}}\"{extra}}}, \"cli\""
        ),
        1,
      )
    };
    assert_eq!(
      AccountKind::parse(&import(""))
        .unwrap()
        .import
        .unwrap()
        .default_from,
      None,
      "a kind that declares no pointer keeps today's behaviour"
    );
    let pointer = AccountKind::parse(&import(", \"default_from\": \"{root}/active\""))
      .unwrap()
      .import
      .unwrap();
    assert_eq!(pointer.default_from.as_deref(), Some("{root}/active"));
    // The pointer names the whole import, never one row.
    assert!(AccountKind::parse(&import(", \"default_from\": \"{root}/{key}\"")).is_err());
    assert!(AccountKind::parse(&import(", \"default_from\": \"{root}/{alias}\"")).is_err());
  }

  #[test]
  fn only_a_root_fallback_names_a_secrets_base() {
    let fallback = MINIMAL.replace(
      r#""root": {"default": "{home}/accounts"}"#,
      r#""root": {"default": "{home}/accounts", "fallback": [{"path": "{secrets}/{app}-accounts", "marker": "t.tsv"}]}"#,
    );
    let kind = AccountKind::parse(&fallback).unwrap();
    let KindCredential::Native { root, .. } = &kind.credential else {
      panic!("native")
    };
    assert!(names_placeholder(&root.fallback[0].path, "secrets"));
    assert!(!names_placeholder(&root.default, "secrets"));
    assert!(
      !names_placeholder("{", "secrets"),
      "a bad template names nothing"
    );
    let in_default = MINIMAL.replace("{home}/accounts", "{secrets}/accounts");
    assert!(
      AccountKind::parse(&in_default).is_err(),
      "not in the default"
    );
    let in_env = MINIMAL.replacen("\"cli\"", "\"env\": {\"X\": \"{secrets}\"}, \"cli\"", 1);
    assert!(AccountKind::parse(&in_env).is_err(), "not in the launch");
    let in_locator = MINIMAL.replace("{root}/{alias}", "{secrets}/{alias}");
    assert!(AccountKind::parse(&in_locator).is_err(), "not in a locator");
  }

  #[test]
  fn a_native_login_is_optional_and_checked() {
    let import = |native: &str| {
      MINIMAL.replacen(
        "\"cli\"",
        &format!(
          "\"import\": {{\"tsv\": \"{{root}}/t.tsv\", \"locator\": \"{{root}}/{{key}}\"{native}}}, \"cli\""
        ),
        1,
      )
    };
    assert_eq!(
      AccountKind::parse(&import(""))
        .unwrap()
        .import
        .unwrap()
        .native,
      None,
      "a kind that declares none imports nothing"
    );
    let declared = r#", "native": {
      "locator": "{home}/.fixture",
      "present": ["{home}/.fixture.json"],
      "alias_from": {"file": "{home}/.fixture.json", "json_pointer": "/account/email"},
      "default_alias": "default",
      "unset_env": ["FIXTURE_CONFIG_DIR"],
      "secret": {"keychain_service": "Fixture", "file": "{locator}/creds.json", "json_pointer": "/token"}
    }"#;
    let native = AccountKind::parse(&import(declared))
      .unwrap()
      .import
      .unwrap()
      .native
      .unwrap();
    assert_eq!(native.locator, "{home}/.fixture");
    assert_eq!(native.unset_env, vec!["FIXTURE_CONFIG_DIR"]);
    for bad in [
      declared.replace("{home}/.fixture\"", "{root}/.fixture\""),
      declared.replace("{locator}/creds", "{alias}/creds"),
      declared.replace("\"default\"", "\"not ok\""),
      declared.replace("FIXTURE_CONFIG_DIR", "A B"),
      declared.replace("\"present\"", "\"when\""),
    ] {
      assert!(AccountKind::parse(&import(&bad)).is_err(), "{bad}");
    }
  }

  #[test]
  fn a_cached_account_name_becomes_an_alias() {
    for (name, alias) in [
      ("james@example.com", Some("james")),
      ("james.kao@example.com", Some("james-kao")),
      ("J_K-1", Some("J_K-1")),
      (".x.@y", Some("x")),
      ("@example.com", None),
      ("", None),
      ("é", None),
    ] {
      assert_eq!(native_alias(name).as_deref(), alias, "{name}");
    }
  }

  #[test]
  fn a_pointer_names_a_row_by_its_key_or_its_alias() {
    for content in [
      "a@example.com",
      "a@example.com\n",
      "  a@example.com  ",
      "@work",
      "work",
      "@work\n",
    ] {
      assert!(
        Import::names(content, "a@example.com", "work"),
        "{content:?}"
      );
    }
    for content in [
      "",
      "\n",
      "@",
      "b@example.com",
      "@other",
      "A@EXAMPLE.COM",
      "@a@example.com",
    ] {
      assert!(
        !Import::names(content, "a@example.com", "work"),
        "{content:?}"
      );
    }
  }

  #[test]
  fn a_uuid_conversation_contract_takes_only_the_canonical_spelling() {
    let declared = MINIMAL.replacen(
      "\"cli\"",
      "\"resume\": {\"exact\": [\"resume\"], \"id\": \"uuid\"}, \"cli\"",
      1,
    );
    let kind = AccountKind::parse(&declared).unwrap();
    let id = kind.resume.as_ref().unwrap().id;
    assert_eq!(id, ConversationId::Uuid);
    let bad = declared.replace("\"uuid\"", "\"name\"");
    assert!(AccountKind::parse(&bad).is_err());
    let undeclared = MINIMAL.replacen(
      "\"cli\"",
      "\"resume\": {\"exact\": [\"resume\"]}, \"cli\"",
      1,
    );
    assert_eq!(
      AccountKind::parse(&undeclared).unwrap().resume.unwrap().id,
      ConversationId::Any,
      "a kind that declares nothing keeps today's behaviour"
    );

    let canonical = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
    assert!(id.check("fixture", canonical).is_ok());
    for refused in [
      "my-session",
      "0199AAAA-BBBB-7CCC-8DDD-EEEEEEEEEEEE",
      "0199aaaabbbb7ccc8dddeeeeeeeeeeee",
      "{0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee}",
      "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeeg",
      "0199aaa-abbbb-7ccc-8ddd-eeeeeeeeeeee",
      "",
    ] {
      let error = id.check("fixture", refused).unwrap_err().to_string();
      assert!(error.contains("session UUID"), "{refused}: {error}");
    }
    assert!(ConversationId::Any.check("fixture", "my-session").is_ok());
  }
}
