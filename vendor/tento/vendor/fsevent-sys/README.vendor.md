# fsevent-sys 4.1.0, vendored (tsh, 2026-09-12)

Identical API to crates.io `fsevent-sys` 4.1.0 except that NOTHING is linked
against CoreServices or CoreFoundation at build time: every function resolves
its symbol with `dlopen`/`dlsym` on first call (`src/dl.rs`), and the two data
symbols the crate exported as statics (`kCFTypeArrayCallBacks`,
`kCFRunLoopDefaultMode`) are functions returning the resolved pointer/value.

Why: an executable that links CoreFoundation (transitively, via CoreServices)
runs ~400 dyld initializers — CoreFoundation, libc++, the Swift runtime —
before `main`, which measured 0.9 ms and ~290 page faults on every `tsh`
invocation, including one-shot verbs that never arm a watcher. With this
shim the frameworks load when the first FSEvents stream is created, in the
processes that watch (viewers, engines), and never in the rest.

`[patch.crates-io]` in the workspace `Cargo.toml` points `fsevent-sys` here;
the vendored `notify` beside it carries the two call-site adjustments.
