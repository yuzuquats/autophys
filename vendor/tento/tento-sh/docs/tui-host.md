# The TUI host — a functional transformation of file-backed state

> **Status:** REPL + compositor TUI shipped (`tento-sh-tui`); the scriptable
> layer is **shipped too** (F8/F9/F11): `(defmode)`/`(bind-key)` with the
> compositor-level key chain (`:pane`/`:mode`/global layers over the reserved
> Ctrl-C floor), live scene reload with keyed view-state reconcile, the purity
> gate + eval budget rails, and gated import-time UI via `(use-ui)` — see
> [`hackable-tui`](../../../../tento-shell.project.docs/content/hackable-tui.md)
> for per-piece status.

Subgoal 4: the TUI is not a stateful widget tree you mutate — it is a **pure
render of files on disk**, repainted whenever those files change. That single
property is why an external actor (an LLM) can drive a `tsh` terminal: it only has
to read and write the same files the TUI reads.

## The shape of it (`mono/tento/tento-sh-tui/src/`)

- `host.rs::run_shell_in_tui` peels `(Scripts, subcommands)` out of a `Shell`,
  installs a stdout→tracing redirect (so a command's stray `println!` flows into
  the trace stream instead of corrupting the alt screen), runs the startup `.tsh`,
  then enters `run_compositor_loop`.
- `run_compositor_loop` drains submitted lines off an mpsc channel on a `LocalSet`
  (the `Callable` futures are `!Send`) and calls `run_loop::exec`. Each input
  bumps a monotonic `turn_seq` stamped onto every event the turn produces, so the
  renderer can group `user.input → shell.exec → stdout/exec.body` as one unit.
- `runtime.rs` / `scenes.rs` build the fixed Inline scene (trace + composer +
  status) and run it **retained-mode with push-based file-watch → repaint**.
- `composer_pane.rs` is the line editor: it owns text/cursor/history and hands a
  submitted line to a host-supplied `submit` callback. It does *not* know how to
  run a command — keeping the pane portable.

State (the trace log, status, selection) lives in session files; panes are a
function of those files; the watcher re-runs the function on change. Render is
pure; effects live only in event handlers.

## In-composer control forms (the extension point)

Some prompt input is *not* a command — it reconfigures the surface in-process.
The shipped precedent is `(debug.show-turns)`: `composer_pane.rs::parse_debug_form`
recognises it, flips a shared `Arc<AtomicBool>` (`DebugFlags`), logs a confirmation
event, and **does not submit the line** to exec. `host.rs` wires that flag to both
the composer (writer) and the trace pane (reader, which draws turn separators when
on). `host.rs`'s module docstring describes a sibling `(scene NAME)` runtime
switch on the same intercept-don't-submit principle.

```rust
// composer_pane.rs — the pattern every control form follows
if let Some(form) = Self::parse_debug_form(&line) {
  /* flip in-memory state, emit a trace event — never (self.submit)(line) */
} else {
  (self.submit)(line);   // ordinary command → exec
}
```

This is the seam the coding harness extends: `(lane.use "deepseek")` is a new
control form that switches the composer's **active input mode** rather than
dispatching a command. See [coding-harness.md](./coding-harness.md).

## Why an LLM can drive the terminal

Because the panes are a pure function of files and the watcher repaints on change,
"driving the terminal" reduces to file I/O: write a line to the input/session
file, read the rendered state from the trace/selection files. No private widget
state, no screen-scraping. The TUI is a *view*; the model is on disk. The hackable
UI roadmap (Lisp scenes, scriptable keymaps, composer modes, multi-frontend via
`tento-lisp-js`) builds entirely on this.
