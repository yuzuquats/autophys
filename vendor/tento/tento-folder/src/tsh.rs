//! The `folder.*` tsh DSL: write a [`Spec`] as a tsh script.
//!
//! [`TSH_PRELUDE`](crate::TSH_PRELUDE) binds `folder.file`, `folder.any`, `folder.none`, `folder.dir`,
//! `folder.closed`, `folder.opt` and `folder.some`; a spec file is any
//! tsh source whose last form evaluates to a folder node built from
//! them. Evaluation runs in-process on the tsh engine
//! (`tento-lisp-cmd`'s `LispHost`) — no `tsh` binary is involved.

use crate::spec::{Spec, SpecError};

/// Failure to turn tsh source into a [`Spec`].
#[derive(Debug, thiserror::Error)]
pub enum TshSpecError {
  #[error("tsh evaluation failed: {0}")]
  Eval(String),
  #[error(transparent)]
  Spec(#[from] SpecError),
}

/// Evaluate `src` after [`TSH_PRELUDE`](crate::TSH_PRELUDE) and return the last form as JSON.
pub fn eval_with_prelude(src: &str) -> Result<serde_json::Value, TshSpecError> {
  let mut host = tento_lisp_cmd::script::LispHost::new();
  host
    .eval_to_json(crate::TSH_PRELUDE)
    .map_err(|e| TshSpecError::Eval(format!("{e}")))?;
  host
    .eval_to_json(src)
    .map_err(|e| TshSpecError::Eval(format!("{e}")))
}

/// Parse a tsh spec file (prelude forms, last form a folder node).
pub fn spec_from_tsh(src: &str) -> Result<Spec, TshSpecError> {
  Ok(Spec::from_json(&eval_with_prelude(src)?)?)
}
