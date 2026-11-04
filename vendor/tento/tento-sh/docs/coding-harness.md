# Spec: driving a coding harness with `(lane.use "deepseek")`

> **Status:** **largely shipped.** The mode system this spec depended on is
> built (F9: `(defmode)`/`(bind-key)`/`(lane.use)`; F11:
> `(use-ui)`), the Rust `deepseek`/`plan` modes run in `tsh` today, and the
> approval flow exists (`(approve)`/`(deny)` + session decision files).
> Remaining from this page: `(scene NAME)` live scene-switching in the shell
> scene, and packaging the harness as an importable bundle (the opencode
> bundle — the F11 worked example).

## The target experience

```
$ tsh                          # global on PATH; bare session, lona-free
> (lane.use "deepseek")        # composer control form → activates deepseek mode
deepseek> add a --json flag to tento-weather and run the tests
  … harness streams: reads files, proposes an edit, runs the tests …
deepseek> (lane.use ctl)             # back to the control lane
>
```

Nothing about "deepseek" lives in the Rust core. The core gains a *generic mode
primitive*; the deepseek behavior is a `.tsh` mode definition plus a normal
command group. Three layers, one per concern.

---

## Layer A — the core mode primitive (product-agnostic; subgoal 1)

Lives in `tento-sh-tui` plus a thin registry the host owns. It is the direct
generalization of the `(debug.show-turns)` intercept in `composer_pane.rs`.

**`Mode` + `ModeRegistry`.** A mode is a per-composer **input context**:

```
Mode {
  name: String,
  prompt_label: String,           // "deepseek>"
  on_submit: LispClosure,         // what a typed line does
  on_enter:  Option<LispClosure>, // lifecycle
  on_exit:   Option<LispClosure>,
  keymap:    Option<Keymap>,      // optional, F9
}
```

The registry maps `name → Mode`. The built-in `shell` mode's `on_submit` **is**
today's behavior: tokenize the line → `run_loop::exec`. Modes hold `LispHost`
closures (defined in `.tsh`), so the registry is populated by evaluating
`(defmode …)` forms at startup/import — no product strings in Rust.

**Composer routing.** `ComposerPane` gains an `active_mode` and a host-provided
**router**. Generalize `parse_debug_form` → `parse_control_form`, recognizing a
small fixed set of in-process forms:

| Control form | Effect |
|---|---|
| `(debug.show-turns)` | (shipped) flip the turn-separator flag |
| `(scene NAME)` | (designed) swap the scene |
| `(lane.use "X")` / `(lane.use ctl)` | set the active lane (idempotent; ctl = control) |
| `(lane.list)` | emit the registered lanes as a trace event |

A control form is **intercepted, never submitted** — exactly the
`(debug.show-turns)` rule. A *non-control* line goes to the router, which looks up
`active_mode` and runs its `on_submit`:
- `shell` mode → tokenize → `exec` (unchanged path).
- a Lisp mode → `LispHost` evaluates `(on_submit line)`.

**Set semantics.** `(lane.use "X")` is idempotent (Shift-Tab cycles); leaving fires `X.on_exit` and
return to `shell`; else fire the current mode's `on_exit`, set `active = X`, fire
`X.on_enter`, update the prompt label, emit a trace event. Active mode is shared
state — a `Mutex<ModeName>` wired composer↔host exactly like the `show_turns`
`Arc<AtomicBool>` in `host.rs`.

**Why modes, not scenes.** A scene swap rebuilds the compositor (`host.rs`'s
`(scene NAME)` slot quits + re-enters). A mode is lighter: it only swaps input
routing + the prompt label *within* the composer — matching F9's "modes are
per-(composer-)pane input contexts." No rebuild.

---

## Layer B — the mode definition in `.tsh` (product logic; subgoal 2)

Shipped in a `deepseek.tsh.app` bundle's `ui/deepseek.tsh`, **registered inert at
`@import` and activated only by the user's `lane.use`** (F11 — no
auto-activation). Or a `~/.tshrc` snippet:

```lisp
(@import "tento-deepseek" :as "deepseek")      ; mounts deepseek.* (the harness)
(defmode deepseek
  :prompt    "deepseek>"
  :on-enter  (lambda () (deepseek.session-start))
  :on-submit (lambda (line) (deepseek.prompt {:text line}))
  :on-exit   (lambda () (deepseek.session-end)))
```

Adding a *different* harness (claude, opencode) is just another `(defmode …)` over
another group — no core change. That is subgoal 1 holding in practice.

---

## Layer C — the harness group `tento-deepseek` (a normal `*.tsh.app`)

An ordinary tento-sh command group (see [authoring-a-group.md](./authoring-a-group.md))
that reuses the in-tree agent loop rather than inventing one.

**Reused pieces (`mono/tento/tento-ai/`):**
- The OpenAI-compatible client `openai::OpenAiModel` — its `ChatMessage` /
  `ToolCall` request/response types, `generate(messages, tool_decls)`, and
  `extract_tool_calls` / `extract_text`. **One change is required:** `generate`
  today **hardcodes** `https://api.openai.com/v1/chat/completions` — the harness
  needs a configurable base URL to target DeepSeek's OpenAI-compatible endpoint
  (`https://api.deepseek.com/v1`) with a `deepseek/deepseek-v4-*` model id (ids
  already used elsewhere in the repo). Add a `base_url` field to `OpenAiModel`
  (small, backward-compatible) rather than cloning the client.
- The agent tool-loop shape from `memory.chat` (`tento-ai/src/lib.rs`): a
  `loop { model call → tool calls → tool results → loop until done }` over a
  `ToolRegistry` (`tento-ai/src/tools.rs`: `ToolHandler`, `ToolContext`,
  `ToolResult`, `ToolEnum`/`ToolParams` derives).

**Coding tools** registered in the `ToolRegistry` — this is what makes it *drive a
coding CLI*: `read-file`, `write-file`/`edit`, `run-command` (bounded), `list-dir`.

**Commands:**
- `deepseek.session-start` — open a session dir + conversation file.
- `deepseek.prompt --text … --session …` — run **one agent turn** (model call →
  tool-step loop → append results).
- `deepseek.session-end` — close the session.

---

## Statefulness + streaming over file-backed state (subgoal 4)

The chat is **stateful**, but the transport stays **oneshot** — no new daemon.

- Each `(deepseek.prompt …)` is a oneshot
  `tento-deepseek prompt --session <id> --tsh --text "…"` that **loads the
  conversation from the session dir, runs one turn, appends, and exits.** All
  state lives in files — "a functional transformation of file-backed state" by
  construction, with nothing held in a long-lived process.
- **Streaming:** the harness *appends* incremental events (model text, each tool
  call + result) to the session's file-backed conversation log **as it runs**.
  The TUI's existing file-watch → repaint runtime ([tui-host.md](./tui-host.md))
  renders them live, independent of the oneshot's terminal return (which is just
  final status). No streaming transport is invented — it reuses the retained-mode
  reactivity.
- **External LLM can drive it:** because prompts are lines and state is the
  session files, a headless agent runs the same `tento-deepseek prompt … --tsh`
  (or writes the session input file) and reads the rendered state — same harness,
  no TUI. The mode `on_submit` is the *only* TUI-specific glue.

```
session/<id>/
  conversation.jsonl   # append-only turn + tool log (the model; the TUI renders it)
  input                # optional: a driver writes a prompt here instead of typing
  status               # current turn state
```

## Headless parity (subgoal 3)

`tento-deepseek prompt … --tsh` returns the turn as JSON — identical harness, no
TUI. CI or another agent drives it with zero divergence from the interactive path
(see [protocol-and-headless.md](./protocol-and-headless.md)).

---

## How the five subgoals map onto the layers

| Subgoal | Where it's satisfied |
|---|---|
| 1 — core product-agnostic | Layer A: `Mode`/`ModeRegistry`/router; "deepseek" never in Rust |
| 2 — product logic in `.tsh` | Layer B: `(defmode deepseek …)` |
| 3 — modal structured/human I/O | Layer C: harness speaks `--tsh` |
| 4 — file-backed, LLM-drivable | session files + file-watch repaint |
| 5 — TUI drives a coding CLI | Layer C coding tools, reached via Layer A/B |

## Implementation slices (build order — not built in this pass)

1. **Mode primitive in `tento-sh-tui`:** `Mode` + `ModeRegistry` + composer
   routing + `parse_control_form` (add `lane.use`/`lane.list`). Default `shell`
   mode preserves today's behavior. Unit-test the toggle the way
   `composer_pane.rs` tests `(debug.show-turns)` (flip state, assert
   not-submitted).
2. **Lisp wiring:** `(defmode …)` and `(lane.list)` through `LispHost`
   (`script/interp.rs`); active-mode `Mutex` shared composer↔host (mirror the
   `show_turns` wiring in `host.rs`).
3. **`tento-deepseek` group:** add `base_url` to `OpenAiModel`; coding
   `ToolRegistry`; file-backed session with append-on-step; `--tsh` output.
4. **`deepseek.tsh.app` bundle:** `ui/deepseek.tsh` with the `defmode` (F11 inert
   registration); a `~/.tshrc` `@import` to make it available in a bare `tsh`.

## Cross-references

- Control-form intercept precedent: `tento-sh-tui/src/composer_pane.rs`,
  `host.rs`.
- Mode/keymap design (F9) + import-time activation (F11):
  [`hackable-tui`](../../../../tento-shell.project.docs/content/hackable-tui.md),
  [`open-decisions`](../../../../tento-shell.project.docs/content/open-decisions.md).
- Agent-loop + client precedent: `tento-ai/src/{lib.rs,openai/mod.rs,tools.rs}`.
- Process model (why oneshot is enough; daemon is future work):
  [`process-lifecycle`](../../../../tento-shell.project.docs/content/process-lifecycle.md).
