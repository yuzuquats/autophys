use serde_json::Value;
use tento_term::sections::{Section, SectionsBody};
use tento_term::{Cell, Column, Style, Table};

use crate::__dev::ExceptionWithTrace;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
  #[error("arg parse error: {0}")]
  ArgParseError(String),
  #[error("Please provide a subcommand. Available subcommands: {0}")]
  MissingSubcommand(String),
  #[error("No such subcommand. ie. ./[bin] [command] [subcommand]")]
  NoSuchSubcommand,
  #[error("{}", command_not_found_message(.name, .suggestion, .available))]
  CommandNotFound {
    name: String,
    suggestion: Option<String>,
    available: Vec<String>,
  },
  /// A child process ran and failed. Keep the numeric status/signal typed all
  /// the way to an embedding shell's process boundary; reducing this to an
  /// anyhow string makes exact exit propagation impossible.
  #[error("{detail}")]
  ProcessExit {
    status: Option<i32>,
    signal: Option<i32>,
    detail: String,
  },
  /// A program could not start (126 not executable, 127 missing at spawn).
  /// Unlike a child's nonzero exit, this requires a shell diagnostic.
  #[error("{detail}")]
  ProcessStart { status: i32, detail: String },
  #[error(transparent)]
  Other(#[from] anyhow::Error),
}

/// Plain one-line form of `CommandNotFound`, shared by `Display` and any
/// non-terminal consumer; the colored multi-line layout lives at the CLI
/// print site in `run_loop`.
pub(crate) fn command_not_found_message(
  name: &str,
  suggestion: &Option<String>,
  available: &[String],
) -> String {
  let mut msg = format!("no command `{name}`");
  if let Some(s) = suggestion {
    msg.push_str(&format!(" — did you mean `{s}`?"));
  }
  if !available.is_empty() {
    msg.push_str(&format!("\navailable: {}", available.join(", ")));
  }
  msg
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
  /// Conventional shell-compatible status for a child failure. A normal exit
  /// preserves its code; a signal maps to `128 + signal` when representable.
  pub fn process_status(&self) -> Option<i32> {
    match self {
      Self::ProcessExit { status, signal, .. } => {
        status.or_else(|| signal.and_then(|sig| 128i32.checked_add(sig)))
      }
      Self::ProcessStart { status, .. } => Some(*status),
      _ => None,
    }
  }

  /// Render-shape form of this error (`sections/v1`), for hosts that speak
  /// the shape registry: the CLI renders it via `cli_shape_text`, the TUI
  /// host emits it as `exec.body` so the trace pane renders the same block.
  /// `None` when the error has no structure beyond its `Display` — hosts
  /// keep their plain one-line render.
  pub fn to_shape(&self) -> Option<Value> {
    let Error::CommandNotFound {
      name,
      suggestion,
      available,
    } = self
    else {
      return None;
    };
    // One header rhythm: the red title line carries the error and the
    // nearest-match suggestion (same text as `Display`'s first line); the
    // dim-headed command list nests under it (header +2, rows +4) and stays
    // collapsible in the TUI via its inner sec path.
    let suggestion_part = suggestion
      .as_ref()
      .map(|s| format!(" — did you mean `{s}`?"))
      .unwrap_or_default();
    let title = Cell::new(
      format!("error: no command `{name}`{suggestion_part}"),
      Style::Red,
    );
    let body = if available.is_empty() {
      Value::String(String::new())
    } else {
      let mut table = Table::new(vec![Column::new("")]).header_rule(false);
      for command in available {
        table.push_row(vec![Cell::plain(command.clone())]);
      }
      let inner = vec![Section::table(
        Cell::new("available commands", Style::Dimmed),
        table,
      )];
      serde_json::to_value(SectionsBody::new(inner)).expect("sections/v1 serializes")
    };
    let sections = vec![Section {
      title: Some(title),
      value: body,
    }];
    Some(serde_json::to_value(SectionsBody::new(sections)).expect("sections/v1 serializes"))
  }
}

pub trait ToTrace {
  fn to_trace(&self) -> ExceptionWithTrace;
}

impl ToTrace for Error {
  fn to_trace(&self) -> ExceptionWithTrace {
    let message = Some(format!("{}", self));
    let mut backtrace = None;

    let sources = match self {
      Error::Other(error) => {
        backtrace = Some(error.backtrace());

        let mut sources = Vec::new();
        let mut current_source = error.source();
        while let Some(source) = current_source {
          sources.push(format!("{}", source));
          current_source = source.source();
        }

        sources
      }
      Error::ArgParseError(_) => vec![],
      Error::MissingSubcommand(_) => vec![],
      Error::NoSuchSubcommand => vec![],
      Error::CommandNotFound { .. } => vec![],
      Error::ProcessExit { .. } | Error::ProcessStart { .. } => vec![],
    };

    let mut exception = ExceptionWithTrace::with_sources(message, sources, backtrace);
    // A command failure is not a process panic — the terminal renderer's box
    // heading should say so.
    exception.label = "Error".to_string();

    exception.filtered_range.0 = Some("anyhow::__private::format_err".to_string());
    exception.filtered_range.1 = Some("tento_sh::run_loop::run_once_or_loop".to_string());

    exception
  }
}

#[cfg(test)]
mod test {
  use super::{Error, ToTrace};
  use anyhow::{Context, anyhow};
  use std::backtrace::{Backtrace, BacktraceStatus};
  use std::io;

  fn not_found(suggestion: Option<&str>, available: &[&str]) -> Error {
    Error::CommandNotFound {
      name: "frobnicate".to_string(),
      suggestion: suggestion.map(str::to_string),
      available: available.iter().map(|s| s.to_string()).collect(),
    }
  }

  /// One red title line carrying error + suggestion, with the dim-headed
  /// command list nested as an inner section.
  #[test]
  fn to_shape_is_one_block_with_nested_list() {
    let shape = not_found(Some("tail"), &["cat", "tail"])
      .to_shape()
      .unwrap();
    assert_eq!(shape["shape"], "sections/v1");
    let sections = shape["sections"].as_array().unwrap();
    assert_eq!(sections.len(), 1);
    assert_eq!(sections[0]["title"]["style"], "red");
    assert_eq!(
      sections[0]["title"]["text"],
      "error: no command `frobnicate` — did you mean `tail`?"
    );
    let inner = &sections[0]["value"];
    assert_eq!(inner["shape"], "sections/v1");
    assert_eq!(inner["sections"][0]["title"]["style"], "dimmed");
    assert_eq!(inner["sections"][0]["value"]["shape"], "table/v1");
    assert_eq!(inner["sections"][0]["value"]["rows"][1][0], "tail");
  }

  /// Without a suggestion the title is just the error line.
  #[test]
  fn to_shape_without_suggestion_plain_title() {
    let shape = not_found(None, &["cat"]).to_shape().unwrap();
    let sections = shape["sections"].as_array().unwrap();
    assert_eq!(
      sections[0]["title"]["text"],
      "error: no command `frobnicate`"
    );
    assert_eq!(sections[0]["value"]["shape"], "sections/v1");
  }

  /// Shapeless errors return None — hosts keep their plain render.
  #[test]
  fn to_shape_none_for_unstructured_errors() {
    assert!(Error::Other(anyhow!("boom")).to_shape().is_none());
    assert!(Error::ArgParseError("x".into()).to_shape().is_none());
  }

  #[test]
  fn process_exit_preserves_status_and_maps_signals() {
    let exited = Error::ProcessExit {
      status: Some(7),
      signal: None,
      detail: "false exited 7".into(),
    };
    assert_eq!(exited.process_status(), Some(7));
    let signaled = Error::ProcessExit {
      status: None,
      signal: Some(15),
      detail: "child killed by signal 15".into(),
    };
    assert_eq!(signaled.process_status(), Some(143));
    assert_eq!(signaled.to_string(), "child killed by signal 15");
  }

  #[test]
  pub fn test_error_to_trace_anyhow() {
    // Create an error chain
    let err = match test_error_parent() {
      Ok(_) => panic!("should not OK"),
      Err(e) => Error::Other(e),
    };

    let exception = err.to_trace();

    // Verify the primary message
    assert!(exception.message.is_some(), "Should have a message");

    // For anyhow errors, we expect source chain to be populated
    assert!(!exception.sources.is_empty(), "Should have sources");

    // Combine message and sources for checking
    let all_text = format!(
      "{} {}",
      exception.message.as_ref().unwrap(),
      exception.sources.join(" ")
    );

    // Should contain some of our error context
    assert!(
      all_text.contains("parent") || all_text.contains("context 1") || all_text.contains("oh no"),
      "Error chain should contain expected context"
    );

    assert_frames_when_backtrace_enabled(&exception.frames);

    // Verify filtered_range is set to the custom values
    assert_eq!(
      exception.filtered_range.0,
      Some("anyhow::__private::format_err".to_string())
    );
    assert_eq!(
      exception.filtered_range.1,
      Some("tento_sh::run_loop::run_once_or_loop".to_string())
    );
  }

  #[test]
  pub fn test_error_to_trace_io() {
    // Create an IO error and wrap it
    let io_error = io::Error::new(io::ErrorKind::NotFound, "file not found");
    let err = Error::Other(anyhow::Error::new(io_error));

    let exception = err.to_trace();

    // Verify the primary message
    assert!(exception.message.is_some(), "Should have a message");
    assert!(
      exception
        .message
        .as_ref()
        .unwrap()
        .contains("file not found"),
      "Message should contain error text"
    );

    assert_frames_when_backtrace_enabled(&exception.frames);

    // Verify filtered_range is set to the custom values
    assert_eq!(
      exception.filtered_range.0,
      Some("anyhow::__private::format_err".to_string())
    );
    assert_eq!(
      exception.filtered_range.1,
      Some("tento_sh::run_loop::run_once_or_loop".to_string())
    );
  }

  // Helper functions to create nested errors
  fn test_error_parent() -> anyhow::Result<()> {
    test_error_child_1().context("parent")?;
    Ok(())
  }

  fn test_error_child_1() -> anyhow::Result<()> {
    test_error_child_2().context("context 1")?;
    Ok(())
  }

  fn test_error_child_2() -> anyhow::Result<()> {
    Err(anyhow!("oh no"))?;
    Ok(())
  }

  fn assert_frames_when_backtrace_enabled(frames: &[crate::__dev::FrameSymbol]) {
    if Backtrace::capture().status() == BacktraceStatus::Captured {
      assert!(!frames.is_empty(), "Should have stack frames");
    }
  }
}
