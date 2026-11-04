//! Validation utilities for ensuring inputs meet requirements and constraints.
//!
//! This module provides various validation tools for ensuring user inputs and other
//! data conform to expected constraints and are safe to use in their intended contexts.

/// Provides a safe wrapper for user-provided strings that may be used in filesystem operations.
pub mod scary_user_string;

use validator::{ValidateLength, ValidationError};

pub use scary_user_string::ScaryUserString;

// const METADATA_MAX_LEN: usize = 1024;

// fn validate_metadata(v: &Value) -> Result<(), ValidationError> {
//   if !v.is_object() {
//     return Err(ValidationError::new("metadata_object"));
//   }
//   let s = serde_json::to_string(v).unwrap();
//   if s.len() <= METADATA_MAX_LEN {
//     Ok(())
//   } else {
//     Err(ValidationError::new("metadata_size"))
//   }
// }

pub fn validate_untyped_json(j: &serde_json::Value) -> Result<(), ValidationError> {
  match j {
    serde_json::Value::Null => todo!(),
    serde_json::Value::Bool(_) => todo!(),
    serde_json::Value::Number(_) => todo!(),
    serde_json::Value::String(s) => {
      if !s.validate_length(None, Some(u16::MAX.into()), None) {
        let mut e = ValidationError::new("length");
        e.add_param(std::borrow::Cow::Borrowed("value"), s);
        e.add_param(std::borrow::Cow::Borrowed("max"), &u16::MAX);
        return Err(e);
      }
    }
    serde_json::Value::Array(varr) => {
      for v in varr {
        validate_untyped_json(v)?;
      }
    }
    serde_json::Value::Object(vobj) => {
      for (_k, v) in vobj {
        validate_untyped_json(v)?;
      }
    }
  }

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;

  #[test]
  fn test_scary_user_string_sanitize_filename() {
    let tests = vec![
      ("normal.txt", "normal.txt"),
      ("file/with/slashes.txt", "filewithslashes.txt"),
      ("file\\with\\backslashes.txt", "filewithbackslashes.txt"),
      ("file\0with\0nulls.txt", "filewithnulls.txt"),
      ("normal file.txt", "normal file.txt"),
    ];

    for (input, expected) in tests {
      let sus = ScaryUserString::new(input);
      assert_eq!(sus.as_sanitized_filename(), expected);
    }
  }

  #[test]
  fn test_scary_user_string_sanitize_path_component() {
    let tests = vec![
      ("normal.txt", "normal.txt"),
      ("file/with/slashes.txt", "filewithslashes.txt"),
      ("file\\with\\backslashes.txt", "filewithbackslashes.txt"),
      ("file\0with\0nulls.txt", "filewithnulls.txt"),
      ("file:with:colons.txt", "filewithcolons.txt"),
      ("file*with*stars.txt", "filewithstars.txt"),
      ("file?with?questions.txt", "filewithquestions.txt"),
      ("file\"with\"quotes.txt", "filewithquotes.txt"),
      ("file<with>angles.txt", "filewithangles.txt"),
      ("file|with|pipes.txt", "filewithpipes.txt"),
      ("normal file.txt", "normal file.txt"),
      ("../traversal.txt", "traversal.txt"),
      ("./current/dir.txt", "currentdir.txt"),
      (".\\windows\\path.txt", "windowspath.txt"),
    ];

    for (input, expected) in tests {
      let sus = ScaryUserString::new(input);
      assert_eq!(sus.as_sanitized_path_component(), expected);
    }
  }

  #[test]
  fn test_scary_user_string_join_to_path() {
    let base_path = Path::new("/tmp");
    let tests = vec![
      ("normal.txt", "normal.txt"),
      ("file/with/slashes.txt", "filewithslashes.txt"),
      ("file\\with\\backslashes.txt", "filewithbackslashes.txt"),
      ("file\0with\0nulls.txt", "filewithnulls.txt"),
      ("file:with:colons.txt", "filewithcolons.txt"),
      ("file*with*stars.txt", "filewithstars.txt"),
      ("file?with?questions.txt", "filewithquestions.txt"),
      ("file\"with\"quotes.txt", "filewithquotes.txt"),
      ("file<with>angles.txt", "filewithangles.txt"),
      ("file|with|pipes.txt", "filewithpipes.txt"),
      ("../attempt/to/escape.txt", "attempttoescape.txt"),
      ("attempt/to/../../escape.txt", "attempttoescape.txt"),
      ("./current/directory.txt", "currentdirectory.txt"),
      (".\\windows\\style\\path.txt", "windowsstylepath.txt"),
      ("multiple../../../dots.txt", "multipledots.txt"),
    ];

    for (input, expected_filename) in tests {
      let sus = ScaryUserString::new(input);
      let path = sus.join_to_path(base_path);
      let expected_path = base_path.join(expected_filename);
      assert_eq!(path, expected_path);
    }
  }

  #[test]
  fn test_scary_user_string_serde() {
    use serde_json;

    let original = "test string";
    let sus = ScaryUserString::new(original);

    // Test serialization
    let serialized = serde_json::to_string(&sus).unwrap();
    assert_eq!(serialized, "\"test string\"");

    // Test deserialization
    let deserialized: ScaryUserString = serde_json::from_str(&serialized).unwrap();
    assert_eq!(deserialized.as_ref(), original);
  }
}
