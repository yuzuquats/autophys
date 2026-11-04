mod command_arg;
mod command_list;
mod command_metadata;
pub mod complete;
pub mod dispatch;
mod error;
mod exception;
pub mod reflect;
pub mod run_loop;
pub mod schema;
pub mod script;
pub mod shape;
pub mod shell;
pub mod status;
pub mod structural;
pub mod tokenizer;

/// Shared process-wide authority gate for owned-I/O extensions.
pub use tento_lisp::owned_io_gate;
pub use tento_lisp_macros::*;

pub use command_arg::{
  ArgSchema, ArgToken, CommandArg, IntoArgDefault, NamedField, arg_default, bind_doc_to,
  bind_tokens, parse_arguments,
};
pub use command_metadata::{CommandMetadata, CommandMetadataSync, SyncCommand};
pub use error::{Error, Result};
pub use futures;
pub use reflect::{
  AppSelfDoc, CommandAlias, CommandDoc, CommandEntry, CommandIndex, DaemonDoc, OptionDoc,
  OptionKind, ProvideEntry, SERVICE_KIND_HTTP, SYNTAX_PROVIDER_V1, ServiceDecl,
  TERMINAL_LAUNCH_REPORT_V1, TERMINAL_LAUNCH_REQUEST_V1, TERMINAL_LAUNCH_V1, TSH_APP_SCHEMA,
  TSH_APP_TYPE,
};
pub use run_loop::command_index_value;
pub use script::{
  LispValue, OnError, RunOptions, Sym, TshScriptError, TshScriptErrorKind, lisp_args_to_argv,
  lisp_args_to_bind_doc, lisp_args_to_typed, run_file, run_str,
};
pub use shell::{DaemonScope, DaemonSpec, GateOutcome, Scripts, SeedLine, Transport, UnavailableGroup};
pub use shell::{PromptText, StdinLineReader};
pub use status::{StatusBoard, StatusSink};

pub mod json {
  pub use serde_json::Value;
  pub use serde_json::to_value;
}

#[doc(hidden)]
pub use serde as __serde;

#[macro_export]
macro_rules! shell {
  ($cmd:expr, [$($arg:expr),* $(,)?]) => {{
    use anyhow::Context;
    std::process::Command::new($cmd)
      .args(&[$($arg),*])
      .status()
      .context("cmd failed")?
  }};
}

pub mod __dev {
  pub use crate::error::ToTrace;
  pub use crate::exception::{
    ExceptionWithTrace, FrameSymbol, extract_anyhow_sources, extract_error_sources,
  };
}

/// Prompts the user with a confirmation message and returns true if they confirm.
/// The message is displayed with colored formatting.
///
/// Non-interactive callers (ssh, node ops, cron) get a hard error instead of a
/// silent decline: with stdin not a tty, an EOF or non-affirmative answer used
/// to read as "no" and the gated command exited 0 having done nothing (see
/// learning 2026-06-09-confirm-prompt-nontty-silent-skip). A piped `y`/`yes`
/// still confirms; anything else bails so a supervising workflow sees the skip.
pub fn confirm_action(message: &str) -> anyhow::Result<bool> {
  use colored::Colorize;
  use std::io::{BufRead, IsTerminal, Write};

  print!(
    "{} {} {} ",
    "⚠️ ".yellow().bold(),
    message.red().bold(),
    "Are you sure? [y/N]:".yellow()
  );
  std::io::stdout()
    .flush()
    .context("failed to flush stdout")?;

  let mut input = String::new();
  let bytes_read = std::io::stdin()
    .lock()
    .read_line(&mut input)
    .context("failed to read confirmation")?;

  let input = input.trim().to_lowercase();
  let confirmed = input == "y" || input == "yes";
  if !confirmed && !std::io::stdin().is_terminal() {
    anyhow::bail!(
      "confirmation required ({message}) but stdin is not a tty{}; \
       pass --yes or run interactively",
      if bytes_read == 0 {
        " and provided no input"
      } else {
        ""
      }
    );
  }
  Ok(confirmed)
}

use anyhow::Context;
