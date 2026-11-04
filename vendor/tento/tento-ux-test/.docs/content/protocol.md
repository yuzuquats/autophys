# UX-test harness protocol

The contract that lets a UX test run **headlessly** end-to-end. It binds three
parts that live in three places but must agree:

| Part | Where | Role |
| ---- | ----- | ---- |
| In-browser harness | `@tento-ui/llm-logger` (`tento-ui-js`) + the app shell | captures logs, exposes the driver globals, posts completion |
| Headless runner | `tento/tento-ux-runner` (Deno) | drives the page through the globals, runs the plan steps |
| Orchestrator | `tento-ux-test` (Rust: `headless.rs`, `orchestration.rs`) | emits the plan, waits for completion, **judges** the trace |

The TS source of truth for the wire shapes is
**`@tento-ui/harness-protocol`** (`tento/tento-ui-js/harness-protocol.ts`). It is
import-clean from both the tento bundle and a plain Deno context, so it uses the
serialized `string | null` rather than the tento-ambient `Option<T>`.

## Activation

A page enters harness mode when loaded with `?ux=<session-id>&tid=<tracing-uuid>`.
`LLMLogger.initFromUrlParam()` (called by every app entry point, e.g. the
calendar `index.root`) mints the harness cookie, starts capturing logs to
`/_/ux-test/logs`, and **registers the completion global** (see below). `tid`
survives auth redirects via the `ux-tracing-id` cookie.

## Driver globals (`HarnessGlobals`)

The app shell registers two `window` globals — **app code that cannot move**;
the protocol only owns their *shape*:

- **`__dispatchApp(command) => Promise<unknown>`** — run one in-app command
  (registered by the calendar app shell; calendar-only). It awaits
  `__sheetRenderSettled` before resolving, so a resolved dispatch means the
  render has caught up.
- **`__uxComplete(result, feedback) => Promise<void>`** — flush captured
  logs and POST `/_/ux-test/complete`, flipping the session to `Completed`.
  Registered in `llm-logger.ts` inside `initFromUrlParam` (NOT a route shim —
  app entry points call `initFromUrlParam` directly and never load the shim).
  The same function is also registered under its pre-rename name
  **`__lonaUxComplete`**, and the runner accepts either — deployed bundles older
  than the rename publish the old name alone. The alias is deprecated; it goes
  once no reachable bundle predates the rename.

`result: CompletionResult` (`"success" | "failure"`) is a **neutral
"steps-executed" signal**, not the verdict — the authoritative pass/fail is the
Rust trace verification (`verify_trace_results`).

The runner waits for *both* globals (`waitForHarnessReady`) before driving.

## The headless plan

`ux-test run --auto` emits `headless-plan.json` into the run dir (Rust
`headless.rs`). Its envelope is the crate-owned **`HeadlessPlanBase`**
(`sessionId`, `bootUrl` incl. `?ux=`/`tid=`, `baseUrl`, `devPort`, `settleMs`,
`timeoutMs`). The **step vocabulary** is a browser-automation concern owned by
the runner — `tento-ux-runner`'s `Step` union, which `lona-screenshot` imports
back — so the concrete `HeadlessPlan` composes the two in
`tento-ux-runner/lib/plan.ts`:

```ts
export type HeadlessPlan = HeadlessPlanBase & { steps: Step[] };
```

This split is deliberate: the plan *envelope* is the contract owned by this
crate; the *step set* is the driver's expressive surface, owned by the runner
package next door. The Rust
`HeadlessPlan` struct in `headless.rs` is the emitter and stays in sync with
`HeadlessPlanBase` by convention.

## Wire endpoints

`/_/ux-test/logs` (append captured LJSON) and `/_/ux-test/complete` (mark
done) are **intentionally unauthenticated** so a headless page with only a
short-lived API key (no operator) can still stream and complete. The harness
cookie is minted at `/_/ux-test/token`. Route gating + the cookie/secret model
live in `tento-web`'s admin router; this crate owns the *data* contract those
routes carry.

## End-to-end (auto) flow

1. Rust: setup → create session (`?ux=`/`tid=` URL) → write `headless-plan.json`
   → spawn the Deno runner.
2. Runner: launch browser as the test user → `goto bootUrl` (activates the
   harness) → `waitForHarnessReady` → run `steps` via `__dispatchApp` →
   `__uxComplete("success", …)`.
3. Harness: streams logs to `/_/ux-test/logs`; completion flushes + posts
   `/_/ux-test/complete`.
4. Rust: `await_session_completion` → materialize trace → `verify_trace_results`
   emits the verdict.
