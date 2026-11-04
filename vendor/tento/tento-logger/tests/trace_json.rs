use tento_logger::stream::TraceOp;

fn agrees(source: &str) {
  let original = serde_json::from_str::<TraceOp>(source);
  let direct = TraceOp::from_json(source);
  match (original, direct) {
    (Ok(original), Ok(direct)) => assert_eq!(
      serde_json::to_value(original).unwrap(),
      serde_json::to_value(direct).unwrap(),
      "different decoded record: {source}"
    ),
    (Err(_), Err(_)) => (),
    (original, direct) => {
      panic!("acceptance differs: original={original:?}, direct={direct:?}, source={source}")
    }
  }
}

fn records() -> Vec<String> {
  [
    r#"{"op":"open","seq":1,"id":2,"parent":null,"ts":"2026-09-10T00:00:00Z","name":"work","level":"info","loc":{},"fields":{}}"#,
    r#"{"op":"field","seq":2,"id":2,"ts":"2026-09-10T00:00:01Z","fields":{}}"#,
    r#"{"op":"event","seq":3,"parent":2,"ts":"2026-09-10T00:00:02Z","level":"warn","loc":{"file":"source.rs","line":42},"fields":{}}"#,
    r#"{"op":"close","seq":4,"id":2,"ts":"2026-09-10T00:00:03Z","elapsedMs":-3}"#,
  ].into_iter().map(str::to_owned).collect()
}

#[test]
fn direct_json_matches_derived_parser_for_variants_and_edge_cases() {
  for record in records() {
    assert!(TraceOp::from_json(&record).is_ok());
    agrees(&record);
    agrees(&format!(" \n{record}\r\n"));
    agrees(&format!("{record} true"));
    agrees(&record.replace("\"op\"", "\"o\\u0070\""));
    agrees(&record.replace("\"seq\"", "\"s\\u0065q\""));
    let comma = record.find(',').unwrap();
    agrees(&format!(
      "{{{},{} }}",
      &record[comma + 1..record.len() - 1],
      &record[1..comma]
    ));
    for (extension, accepted) in [
      (r#""op":"event""#, false),
      (r#""o\u0070":"close""#, false),
      (r#""seq":5"#, false),
      (r#""seq":null"#, false),
      (r#""future":{"a":[1,true,null]}"#, true),
      (r#""future":1e999"#, false),
      (
        r#""sessionId":"01234567-89ab-cdef-0123-456789abcdef""#,
        true,
      ),
      (r#""sessionId":null"#, true),
      (r#""sessionId":"invalid""#, false),
    ] {
      let source = format!("{},{} }}", &record[..record.len() - 1], extension);
      assert_eq!(
        serde_json::from_str::<TraceOp>(&source).is_ok(),
        accepted,
        "fixture: {source}"
      );
      agrees(&source);
    }
    for number in [
      "0",
      "-0",
      "1.0",
      "-1",
      "1e3",
      "18446744073709551615",
      "18446744073709551616",
      "1e999",
      "null",
      "true",
      "[]",
      "\"1\"",
    ] {
      let mut json: serde_json::Value = serde_json::from_str(&record).unwrap();
      let seq = json.as_object_mut().unwrap().remove("seq").unwrap();
      let rest = serde_json::to_string(&json).unwrap();
      // Preserve tag-first so malformed numeric cases exercise the fast path.
      let without_seq = record.replacen(&format!("\"seq\":{seq},"), "", 1);
      agrees(&without_seq.replacen(",", &format!(",\"seq\":{number},"), 1));
      agrees(&format!("{{\"seq\":{number},{}", &rest[1..]));
    }
    for fields in [
      r#"{"nested":[{"a":1,"a":2},null,true,"界\\escape"],"op":"close"}"#,
      r#"{"n":-0.0,"max":18446744073709551615}"#,
      r#"{"n":1e999}"#,
      "null",
      "[]",
    ] {
      agrees(&record.replace("\"fields\":{}", &format!("\"fields\":{fields}")));
    }
    for loc in [
      r#"{"file":"a","file":"b"}"#,
      r#"{"line":1,"line":2}"#,
      r#"{"future":1e999}"#,
      r#"{"future":{"a":1}}"#,
      r#"["a",2]"#,
      "null",
      "[]",
    ] {
      agrees(&record.replace("\"loc\":{}", &format!("\"loc\":{loc}")));
    }
    for cut in 0..record.len() {
      agrees(&record[..cut]);
    }
  }
  for source in ["null", "[]", "{}", r#"{"op":"other"}"#, r#"{"op":null}"#] {
    agrees(source);
  }
}

#[test]
#[ignore = "requires TENTO_TRACE_BENCH_PATH pointing to a frozen trace"]
fn direct_json_matches_derived_parser_on_real_trace() {
  use std::io::BufRead;
  let path = std::env::var("TENTO_TRACE_BENCH_PATH").expect("frozen trace path");
  let file = std::fs::File::open(path).unwrap();
  let mut count = 0;
  for line in std::io::BufReader::new(file).lines() {
    let line = line.unwrap();
    if line.len() > 2 * 1024 * 1024 {
      continue;
    }
    // Do not include private trace contents in a failing assertion.
    let original =
      serde_json::from_str::<TraceOp>(&line).map(|op| serde_json::to_value(op).unwrap());
    let direct = TraceOp::from_json(&line).map(|op| serde_json::to_value(op).unwrap());
    assert!(
      match (original, direct) {
        (Ok(a), Ok(b)) => a == b,
        (Err(_), Err(_)) => true,
        _ => false,
      },
      "parser mismatch at record {count}"
    );
    count += 1;
  }
  assert!(count > 1000, "fixture must contain substantial history");
  eprintln!("matched {count} records");
}
