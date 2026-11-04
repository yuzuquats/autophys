# tento-folder

Folder layouts as types and as data. `folder!` declares a layout at compile
time; a runtime `Spec` (built from a `folder.*` tsh file or JSON) checks a
directory against one without generating code. See
[`.docs/content/runtime-spec.md`](.docs/content/runtime-spec.md).

```text
tento-folder check <spec> [dir]            validate dir (default .); fails on any violation
tento-folder check <spec> [dir] --report   the same, returned as data instead of failing
tento-folder show <spec>                   the spec as a tree
```

Build it with `cargo build -p tento-folder --features cli`. The binary is
also the `folder.*` tsh plugin:

```tsh
(@import "tento-folder" :as "folder")
(folder.check "layout.folder" "some/dir")               ;; fails the script on a violation
(let r (folder.check "layout.folder" "some/dir" :report)) ;; folder.check/v1, as a value
```

`tsh.toml` is the plugin contract; `tsh-package` builds the
`tento-folder.tsh.app` bundle from the tsh checkout (the commands are in
`tsh.toml`'s `[build]`). For a local bundle, put `manifest.json` and the
built binary side by side as
`<dir>/tento-folder.tsh.app/{manifest.json,bin/tento-folder}` and point
`TSH_APP_PATH` at `<dir>`. When the commands change, regenerate
`manifest.json`'s `commands` from `tento-folder --help --json`.
`tests/plugin.rs` holds the two in agreement, and runs the bundle through a
real tsh when one is found (`TENTO_FOLDER_TEST_TSH`, else
`~/.local/bin/tsh`; `TENTO_FOLDER_REQUIRE_TSH=1` makes a missing one fail).
