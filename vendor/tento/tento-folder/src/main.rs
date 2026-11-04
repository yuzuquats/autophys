//! Standalone `tento-folder` binary — also the `bin/` of a tento-folder
//! tsh.app. The same `plugin::scripts()` factory serves both.

use tento_folder::plugin::{FolderPlugin, scripts};

#[tokio::main(flavor = "current_thread")]
async fn main() {
  scripts(FolderPlugin)
    .run_with_startup_argv(
      Vec::new(),
      std::rc::Rc::new(tento_lisp_cmd::script::NoApps),
      None,
      std::env::args().collect(),
      None,
    )
    .await;
}
