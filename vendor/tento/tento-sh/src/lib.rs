//! `tento-sh` is a thin **facade** over the carved command engine. The real
//! implementation lives in [`tento_lisp_cmd`] (the `#[command]` calculus, the
//! Lisp host, the run loop, and the `.tsh.app` bundle layer) with derives from
//! `tento_lisp_macros`; this crate just re-exports them so existing consumers
//! (and the `#[command]` macro's `tento_sh::` fallback path) keep compiling
//! while the ecosystem migrates to `tento-lisp-cmd` directly.
pub use tento_app::*;
pub use tento_lisp_cmd::*;
