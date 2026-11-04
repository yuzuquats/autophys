// The UX-test harness protocol — the single TS source of truth for the contract
// between the in-browser harness (activated by `?ux=<id>`), the headless Deno
// runner (`tento/tento-ux-runner`), and the Rust `ux-test run --auto` path
// (`tento/tento-ux-test/src/headless.rs`). Owned crate-side; the un-movable
// `window` registrations stay in app code (`llm-logger.ts` registers
// `__uxComplete`; the calendar app shell registers `__dispatchApp`).
//
// Types here are the JSON/runtime *wire* shapes and must stay importable from a
// plain Deno context (the runner) as well as the tento-ui bundle. So this file
// has NO imports and uses `string | null` (the serialized representation of an
// absent value) rather than the tento-ambient `Option<T>`.

/** Outcome a harness run reports on completion. A NEUTRAL "steps executed"
 *  signal — the authoritative pass/fail verdict is the Rust trace verification,
 *  not this value. */
export type CompletionResult = "success" | "failure";

/** One in-page completion hook: flush captured logs + post
 *  `/_/ux-test/complete`, flipping the session to `Completed`. */
export type CompleteHook = (
  result: CompletionResult,
  feedback: string | null,
) => Promise<void>;

/** In-page drain: upload every log the page's harness still holds, WITHOUT
 *  completing the session. Resolves once those uploads have landed. */
export type FlushHook = () => Promise<void>;

/** The driver globals the app shell registers on a `?ux=` page:
 *  - `__dispatchApp` runs one in-app command (calendar-only; it awaits
 *    `__sheetRenderSettled` before resolving).
 *  - `__uxComplete` flushes captured logs + posts `/_/ux-test/complete`,
 *    flipping the session to `Completed` so verification runs.
 *  Optional because a page is only mid-activation until both are present
 *  (`waitForHarnessReady` polls for them). */
export interface HarnessGlobals {
  __dispatchApp?: (command: unknown) => Promise<unknown>;
  __uxComplete?: CompleteHook;
  /** Registered beside `__uxComplete` by the same logger. The runner awaits it
   *  before a spec navigation and before completion: the logger uploads on a
   *  timer, and what it still holds when the document goes away rides only the
   *  page-hide upload, which the browser caps at 64 KiB. Optional, and never
   *  part of readiness: bundles built before it are still driven. */
  __uxFlush?: FlushHook;
  /** Registered beside `__uxFlush` by the same logger: detach (`false`) or
   *  attach (`true`) the console -> tracing bridge, answering whether it is
   *  attached. A measurement control for perf runs: spans and `Tracing.log`
   *  records upload either way; only `Logger` output stops reaching the
   *  session log. Optional, and never part of readiness. */
  __uxLogSink?: (attached: boolean) => boolean;
  /** @deprecated Pre-rename alias of `__uxComplete`, registered alongside it
   *  and still accepted by the runner. It exists only for the skew window: the
   *  runner drives DEPLOYED bundles, and a bundle built before the rename
   *  publishes this name alone, which no same-repo change can reach. Remove it
   *  — here, in `llm-logger.ts`, and in the runner's `harness.ts` — once every
   *  reachable bundle postdates the rename (ux-test-extraction, phase ④). */
  __lonaUxComplete?: CompleteHook;
}

/** The headless run envelope emitted by Rust into the session dir as
 *  `headless-plan.json`, minus the step list. The step vocabulary is a
 *  browser-automation concern owned by the runner (`tento-ux-runner`'s `Step`
 *  union), so the concrete `HeadlessPlan` composes this base with `steps` in
 *  `tento-ux-runner/lib/plan.ts`. */
export interface HeadlessPlanBase {
  sessionId: string;
  /** Port-qualified launch URL incl. `?ux=<id>&tid=<uuid>` — the top-level goto. */
  bootUrl: string;
  /** Origin incl. `:devPort`, used to resolve in-app `navigate` steps. */
  baseUrl: string;
  devPort: string;
  /** How the runner's browser resolves the product's hostnames. `loopback`
   *  installs `MAP *.lona.so 127.0.0.1` (and `devPort` rewrites sub-resources);
   *  `public` uses real DNS, so the run measures a genuinely remote server.
   *  Absent in plans emitted before env profiles existed ⇒ `"loopback"`. */
  resolver?: HarnessResolver;
  /** Whether certificate errors fail the run. Absent ⇒ `false`, i.e. the
   *  runner ignores them (a dev server's self-signed cert). */
  strictTls?: boolean;
  /** Hostname patterns the `loopback` resolver maps to `127.0.0.1`, stated by
   *  the corpus manifest (`<corpus-root>/app.yaml`). Absent or empty ⇒ the
   *  runner maps only the run's own target hostname — the correct behaviour for
   *  a corpus that has declared no domains, and a smaller claim than guessing
   *  one. */
  resolveDomains?: string[];
  /** The hostnames that ARE the app under test. The port rewrite below applies
   *  to these and nothing else, so a third-party origin the page references is
   *  never redirected. Absent or empty ⇒ nothing is rewritten. */
  appDomains?: string[];
  /** The credential cookie to install before navigating. Absent ⇒ none is set.
   *  It is a cookie rather than a header because the WebSocket handshake cannot
   *  carry `Authorization` but cookies ride it automatically. `bearerHeader`
   *  false ⇒ the credential is a session cookie and is not also stamped as
   *  `Authorization: Bearer`; absent ⇒ stamped (a minted API key). */
  authCookie?: { name: string; domain?: string | null; bearerHeader?: boolean } | null;
  settleMs: number;
  timeoutMs: number;
}

/** Browser DNS strategy for a headless run, chosen by the harness's env
 *  profile (`<.ux-tests>/.envs/<name>.yaml`). */
export type HarnessResolver = "loopback" | "public";
