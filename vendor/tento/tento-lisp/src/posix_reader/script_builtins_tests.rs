use super::*;
use string_interner::{backend::StringBackend, symbol::SymbolU32};

fn read(source: &str) -> Result<serde_json::Value, PosixReadError> {
  let mut interner = StringInterner::<StringBackend>::new();
  let form = read_statement::<SymbolU32, _>(source, &mut interner)?;
  Ok(sexpr_to_json(&form, &interner))
}

#[test]
fn script_append_assignments_and_declaration_initializers_read() {
  for source in [
    "x+=b",
    "a+=(x y)",
    "declare x+=b",
    "local a+=(x y)",
    "readonly x='a b'",
    "readonly -p",
    "getopts ab: o -a",
  ] {
    assert!(read(source).is_ok(), "{source}: {:?}", read(source));
  }
  assert!(read("x+=b").unwrap().to_string().contains("std.sh.append"));
  assert!(
    read("local a+=(x y)")
      .unwrap()
      .to_string()
      .contains("std.sh.declare-initializer")
  );
}

#[test]
fn script_array_keys_prefix_names_and_default_operators_read() {
  for source in [
    "${!a[@]}",
    "${!a[*]}",
    "${!prefix@}",
    "${!prefix*}",
    "${a[@]+\"${a[@]}\"}",
    "${a[*]:-fallback}",
    "${a[@]=x}",
    "${a[*]:?missing}",
  ] {
    assert!(read(&format!("echo {source}")).is_ok(), "{source}");
  }
}

#[test]
fn script_arithmetic_shifts_never_open_heredocs() {
  for source in [
    "echo $((1<<3))",
    "echo $((32 >> 2))",
    "((x=1<<4))",
    "echo $(echo $((1<<3)))",
    "echo \"$((8>>1))\"",
    "for ((i=1; i<8; i<<=1)); do :; done",
  ] {
    assert!(read(source).is_ok(), "{source}: {:?}", read(source));
    assert!(!bash_heredoc_pending(source), "{source}");
  }
  assert!(bash_heredoc_pending("cat <<EOF\n"));
}

#[test]
fn script_session_event_background_before_fi_reads() {
  assert!(read("if true; then : &\nfi").is_ok());
}

#[test]
fn script_session_event_test_background_before_done_reads() {
  assert!(read("for x in a; do : &\ndone").is_ok());
}

#[test]
fn script_time_parser_deno_javascript_is_rejected_as_bash() {
  // This tracked .sh file has a Deno shebang; bash -n rejects this call too.
  assert!(matches!(
    read(r#"console.log("Running @tento-plugins/time-parser tests in UTC timezone...\n");"#),
    Err(PosixReadError::ShellOperatorUnsupported(_))
  ));
}
