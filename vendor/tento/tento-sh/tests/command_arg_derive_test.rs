use serde::{Deserialize, Serialize};
use tento_sh::{CommandArg, parse_arguments};

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone, PartialEq)]
struct RenamedArgs {
  name: String,
  #[serde(rename = "credentials-ref", alias = "credentials_ref")]
  credentials_ref: String,
  #[serde(default, rename = "target-table", alias = "target_table")]
  target_table: Option<String>,
}

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone, PartialEq)]
struct AllOptionalArgs {
  release: Option<bool>,
  version: Option<String>,
}

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(untagged)]
enum ShowArgs {
  #[tento_sh(help = "<name>")]
  Name(String),
  Named {
    name: String,
  },
}

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(untagged)]
enum QueryArgs {
  #[tento_sh(help = "<sql>")]
  Sql(String),
  Named {
    sql: String,
    #[serde(default)]
    #[tento_sh(help = "--store: knowledge|account")]
    store: Option<String>,
  },
}

#[derive(CommandArg, Serialize, Deserialize, Debug, Clone, PartialEq)]
#[tento_sh(help = "<file|json> or --payload: String")]
#[serde(untagged)]
enum PayloadArgs {
  Payload(String),
  Named { payload: String },
}

#[test]
fn named_struct_help_uses_serde_facing_names() {
  assert_eq!(
    RenamedArgs::display_help(),
    vec![
      "--name: String".to_string(),
      "--credentials-ref: String".to_string(),
      "--target-table: Option<String>".to_string(),
    ]
  );
}

#[test]
fn renamed_flags_still_parse_through_serde_aliases() {
  let parsed: RenamedArgs = parse_arguments(vec![
    "cmd".to_string(),
    "--name".to_string(),
    "alice".to_string(),
    "--credentials-ref".to_string(),
    "ALICE".to_string(),
    "--target-table=characters".to_string(),
  ])
  .expect("renamed args should parse");

  assert_eq!(
    parsed,
    RenamedArgs {
      name: "alice".to_string(),
      credentials_ref: "ALICE".to_string(),
      target_table: Some("characters".to_string()),
    }
  );
}

#[test]
fn all_optional_struct_parses_from_no_args() {
  // A command whose every field is `Option<T>` must accept zero args — each
  // field defaults to `None`. The parser falls back from `null` to `{}` so the
  // struct builds (regression: `null` -> struct fails, mis-reporting the
  // optional fields as "Missing required arguments").
  let parsed: AllOptionalArgs =
    parse_arguments(vec!["cmd".to_string()]).expect("all-optional struct parses from no args");
  assert_eq!(
    parsed,
    AllOptionalArgs {
      release: None,
      version: None,
    }
  );
}

#[test]
fn all_optional_struct_still_takes_a_single_flag() {
  // The `{}` fallback must not disturb the normal flag path: one flag set, the
  // other defaults to `None`.
  let parsed: AllOptionalArgs = parse_arguments(vec![
    "cmd".to_string(),
    "--release".to_string(),
    "false".to_string(),
  ])
  .expect("single flag parses");
  assert_eq!(
    parsed,
    AllOptionalArgs {
      release: Some(false),
      version: None,
    }
  );
}

#[test]
fn required_field_still_fails_with_no_args() {
  // The `{}` fallback must not mask genuinely-required fields: `null` fails,
  // `{}` fails (missing `name`/`credentials-ref`), so it still errors.
  let err = parse_arguments::<RenamedArgs>(vec!["cmd".to_string()])
    .expect_err("a struct with required fields must reject zero args");
  assert!(
    err.to_string().contains("Missing required arguments"),
    "unexpected error: {err}"
  );
}

#[test]
fn untagged_enum_help_includes_position_and_named_forms() {
  assert_eq!(
    ShowArgs::display_help(),
    vec!["<name>".to_string(), "--name: String".to_string()]
  );
}

#[test]
fn untagged_enum_field_help_can_be_overridden() {
  assert_eq!(
    QueryArgs::display_help(),
    vec![
      "<sql>".to_string(),
      "--sql: String".to_string(),
      "--store: knowledge|account".to_string(),
    ]
  );
}

#[test]
fn type_help_override_replaces_generated_help() {
  assert_eq!(
    PayloadArgs::display_help(),
    vec!["<file|json> or --payload: String".to_string()]
  );
}
