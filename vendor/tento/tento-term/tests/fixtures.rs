//! Runs the JSON render fixtures in `tests/fixtures/*.json`.
//!
//! Each case describes a `Table`, a `Tree`, or a primitive op plus a
//! `term_width`, and the `expected` rendered output (an array of lines for
//! table/tree, a single string for primitives). With `BLESS=1` (or
//! `UPDATE_FIXTURES=1`) the produced output is written back into the fixtures
//! so it can be reviewed with `git diff`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tento_term::{
  Table, Tree, force_color, pad_center, pad_left, pad_right, truncate_ellipsis, truncate_middle,
  unforce_color, visual_width,
};

#[derive(Deserialize, Serialize)]
struct FixtureFile {
  #[serde(rename = "type")]
  ty: String,
  name: String,
  description: String,
  cases: Vec<CaseRaw>,
}

#[derive(Deserialize, Serialize)]
struct CaseRaw {
  name: String,
  input: Value,
  expected: Value,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CaseInput {
  Table {
    term_width: usize,
    #[serde(default)]
    color: bool,
    table: Table,
  },
  Tree {
    term_width: usize,
    #[serde(default)]
    color: bool,
    tree: Tree,
  },
  Primitive {
    op: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    width: usize,
    #[serde(default)]
    ellipsis: Option<String>,
  },
}

/// Render a case. Returns `(produced_json, color_was_on, term_width_or_none)`.
fn render_case(input: &CaseInput) -> (Value, bool, Option<usize>) {
  match input {
    CaseInput::Table {
      term_width,
      color,
      table,
    } => {
      force_color(*color);
      let lines = table.render_lines(*term_width);
      unforce_color();
      (json!(lines), *color, Some(*term_width))
    }
    CaseInput::Tree {
      term_width,
      color,
      tree,
    } => {
      force_color(*color);
      let lines = tree.render_lines(*term_width);
      unforce_color();
      (json!(lines), *color, Some(*term_width))
    }
    CaseInput::Primitive {
      op,
      text,
      width,
      ellipsis,
    } => {
      let ell = ellipsis.clone().unwrap_or_else(|| "…".to_string());
      let s = match op.as_str() {
        "pad_right" => pad_right(text, *width),
        "pad_left" => pad_left(text, *width),
        "pad_center" => pad_center(text, *width),
        "truncate_ellipsis" => truncate_ellipsis(text, *width, &ell),
        "truncate_middle" => truncate_middle(text, *width, &ell),
        other => panic!("unknown primitive op {other:?}"),
      };
      (json!(s), false, None)
    }
  }
}

fn show(v: &Value) -> String {
  match v {
    Value::Array(lines) => lines
      .iter()
      .enumerate()
      .map(|(i, l)| format!("{i:>3} | {}", l.as_str().unwrap_or("<not a string>")))
      .collect::<Vec<_>>()
      .join("\n"),
    Value::String(s) => format!("{s:?}"),
    other => other.to_string(),
  }
}

#[test]
fn fixtures() {
  let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
  let bless = std::env::var_os("BLESS").is_some() || std::env::var_os("UPDATE_FIXTURES").is_some();

  let mut paths: Vec<_> = std::fs::read_dir(dir)
    .unwrap_or_else(|e| panic!("read_dir {dir}: {e}"))
    .map(|e| e.unwrap().path())
    .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
    .collect();
  paths.sort();
  assert!(!paths.is_empty(), "no fixtures found in {dir}");

  let mut failures: Vec<String> = Vec::new();

  for path in &paths {
    let text = std::fs::read_to_string(path).unwrap();
    let mut file: FixtureFile = serde_json::from_str(&text)
      .unwrap_or_else(|e| panic!("{}: parse error: {e}", path.display()));
    let mut changed = false;

    for case in &mut file.cases {
      let input: CaseInput = serde_json::from_value(case.input.clone())
        .unwrap_or_else(|e| panic!("{}::{}: bad input: {e}", file.name, case.name));
      let (produced, color_on, term_width) = render_case(&input);

      // Invariant: with colour off, no rendered line exceeds the terminal.
      if !color_on {
        if let (Value::Array(lines), Some(tw)) = (&produced, term_width) {
          for l in lines {
            let l = l.as_str().unwrap();
            let w = visual_width(l);
            assert!(
              w <= tw,
              "{}::{}: line wider than {tw}: {l:?} ({w})",
              file.name,
              case.name
            );
          }
        }
      }

      if bless {
        if case.expected != produced {
          case.expected = produced;
          changed = true;
        }
      } else if case.expected != produced {
        failures.push(format!(
          "{}::{}\n--- expected ---\n{}\n--- produced ---\n{}",
          file.name,
          case.name,
          show(&case.expected),
          show(&produced)
        ));
      }
    }

    if bless && changed {
      let out = serde_json::to_string_pretty(&file).unwrap() + "\n";
      std::fs::write(path, out).unwrap();
      eprintln!("blessed {}", path.display());
    }
  }

  if !failures.is_empty() {
    panic!(
      "{} fixture case(s) failed:\n\n{}",
      failures.len(),
      failures.join("\n\n")
    );
  }
}
