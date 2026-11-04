//! A string a native hands over is not copied on the way through the shell's
//! own natives: the result still points at the native's buffer.

use std::cell::RefCell;
use tento_lisp_cmd::script::{LispHost, LispValue};

/// `(std.sh.sub VALUE)` drops trailing newlines. A uniquely held output is
/// truncated in place, with or without a newline to drop.
#[test]
fn command_substitution_trims_a_uniquely_held_output_in_place() {
  for newline in [false, true] {
    let mut host = LispHost::new();
    let mut output = "x".repeat(1 << 16);
    if newline {
      output.push('\n');
    }
    let buffer = output.as_ptr();
    let handed = RefCell::new(Some(LispValue::String(output.into())));
    host.register_native_special("fixture", move |_| Ok(handed.borrow_mut().take().unwrap()));
    let LispValue::String(text) = host.eval_value("(std.sh.sub (fixture))").unwrap() else {
      panic!("std.sh.sub returned a non-string");
    };
    assert_eq!(text.len(), 1 << 16);
    assert_eq!(
      text.as_ptr(),
      buffer,
      "newline={newline}: the output was copied"
    );
  }
}
