import { Toast } from "./components/toast/toast";
import { Cookies } from "./cookies";
import type { CompleteHook, HarnessGlobals } from "./harness-protocol";
import { DateTime } from "@tento-chrono";
import { LlmLoggerApi, LlmSession } from "./llm-logger-api";
import { initErrorForwarding } from "./llm-logger-errors";
import { ResponseError } from "@tento-core/typed-api";
import { Tracing } from "@tento-core/tracing";
import { tracingLogSink } from "./tracing-log-sink";
import { UxTestPopover } from "./ui/ux-test-popover";
import { uxSessionCookieDomain } from "./ux-session-cookie-domain";

/**
 * Rate limiter for LLM logging to prevent infinite loops and log spam.
 * Uses multiple safeguards:
 * - Recursion guard to prevent logging during log emission
 * - Fingerprint-based deduplication (strips line numbers, normalizes IDs)
 * - Per-type rate limit to cap logs per type per 5-second window
 * - Global cap on error/exception logs per session
 * - Memory-bounded fingerprint storage with periodic cleanup
 */
// `LogRateLimiter` moved to the dependency-free `@tento-trace` package (its
// static guard/dedup state must be a single shared instance). Re-exported here
// so existing `@tento-ui/llm-logger` importers keep working.
export { LogRateLimiter } from "@tento-trace";

export class LLMLogger {
  private static isEnabled = false;
  private static isBootstrapped = false;
  // For non-flaky sessions: single instance
  private static instance: Option<LLMLogger>;
  // For flaky sessions: multiple instances, keyed by session ID
  private static flakyInstances: Map<string, LLMLogger> = new Map();
  // For URL-param activated sessions
  private static urlParamSession: Option<LLMLogger>;
  // Pending flaky sessions (not yet shown)
  private static pendingFlakySessions: LlmSession[] = [];
  // Whether flaky toasts are currently visible
  private static flakyToastsVisible = false;
  // Pending non-flaky session (loaded but not shown)
  private static pendingNonFlakySession: Option<LlmSession>;
  // Whether non-flaky toast is currently visible
  private static nonFlakyToastVisible = false;
  // Whether we're currently loading non-flaky session data
  private static isLoadingNonFlaky = false;

  private static STORAGE_KEY = "ux-test-session";
  private static STEPS_KEY = "ux-test-steps";
  private static TRACING_ID_COOKIE = "ux-tracing-id";
  private static ORIGIN_COOKIE = "ux-test-origin";
  // Logs are not realtime: entries coalesce for this long before uploading, so
  // even heavy activity costs at most a couple of POSTs (plus CORS preflights)
  // per interval. Final/partial batches are still flushed on session-complete
  // and on page hide/unload.
  private static BATCH_INTERVAL_MS = 30_000;
  // A `?ux=` session coalesces for FAR less, because for it the buffer is
  // evidence, not telemetry. Two ways a 30s window destroys the boot + first-
  // interaction record it exists to capture:
  //   - MAX_BUFFER_ENTRIES evicts the OLDEST entries, and a calendar boot emits
  //     thousands in its first seconds. A run whose action fires 4-7s in has had
  //     that action's `app-command/*` span evicted long before the first upload,
  //     while the tail of the run survives — which is why runs have recorded
  //     "create MISSING, delete PRESENT" on a product that did both.
  //   - Nothing survives a cross-document navigation (a spec `navigate` step, a
  //     signin/onboarding redirect) except the page-hide upload, which is
  //     bounded by the keepalive budget (see `flushSync`).
  // A test session is short and observed and can pay a POST every few seconds;
  // the timer is only armed by an incoming entry, so an idle session still costs
  // nothing.
  private static SESSION_BATCH_INTERVAL_MS = 3_000;
  // Hard cap on buffered entries — beyond this the oldest are dropped, so a
  // failing/rate-limited endpoint can't grow the buffer (and the eventual
  // flush) without bound.
  private static MAX_BUFFER_ENTRIES = 2_000;
  // A `?ux=` session gets more headroom before it starts destroying evidence: a
  // calendar boot alone can exceed 2000 entries, and the entries it evicts are
  // exactly the ones a spec asserts on. Still bounded (a few MB for a session
  // that lasts a minute) so a dead endpoint can't grow it forever.
  private static SESSION_MAX_BUFFER_ENTRIES = 10_000;
  // Upload at most this many chunks per timed flush; the remainder stays
  // buffered for the next interval. Keeps a backlog from turning one flush
  // into a request flood. Session-complete drains fully regardless.
  private static MAX_CHUNKS_PER_FLUSH = 4;
  // A `?ux=` session lifts that cap: at 4 chunks / 3s the uploader cannot keep
  // pace with a boot torrent, and everything it fails to drain is what
  // MAX_BUFFER_ENTRIES evicts. Still bounded — one flush, one bounded burst.
  private static SESSION_MAX_CHUNKS_PER_FLUSH = 16;
  // Page-hide beacons at most this many (newest) chunks. An unbounded loop
  // here once fired ~2000 beacons in one page-hide, exhausting the server's
  // per-user rate limit and 429ing the whole app.
  private static MAX_SYNC_CHUNKS = 2;
  // Read at use, not at class load: importing the module must not need a page.
  private static get COOKIE_DOMAIN(): string {
    return uxSessionCookieDomain(globalThis.location?.hostname ?? "");
  }

  private sessionId: Option<string>;
  private entryBuffer: Tracing.LjsonEntry[] = [];
  private batchTimer: Option<number>;
  // Per-instance so the harness-driven (`?ux=`) session can drain aggressively
  // without changing the cadence of the operator's pending/flaky toasts, which
  // ride along on an ordinary browsing page.
  private batchIntervalMs: number = LLMLogger.BATCH_INTERVAL_MS;
  private maxChunksPerFlush: number = LLMLogger.MAX_CHUNKS_PER_FLUSH;
  private maxBufferEntries: number = LLMLogger.MAX_BUFFER_ENTRIES;
  // A `?ux=` session's page-hide sends the OLDEST chunks, as many as fit
  // KEEPALIVE_MAX_BYTES together (so it stays bounded), instead of the
  // MAX_SYNC_CHUNKS newest. A document that navigates away before its first
  // timed upload holds its whole boot
  // record — page-load, the initial payload, the auth calls — and that record
  // is what a spec asserts on; keeping only the newest chunks dropped exactly
  // it (calendar doc1 carries ~150 KB and can live under 3 s).
  private unloadSendsOldest = false;
  // One warning per session the first time the cap evicts an entry: a dropped
  // log that verification then reports as a missing behavior is the most
  // expensive kind of silence here.
  private overflowWarned = false;
  private toastHandle: Option<{ dismiss: () => void }>;
  private onEntryCallback: Option<(entry: Tracing.LjsonEntry) => void>;
  private onSessionLost: Option<() => void>;

  /**
   * Check URL for ?ux= param and activate session.
   * Called early via llm-session.root.ts shim.
   */
  static async initFromUrlParam(options: { headless?: boolean } = {}): Promise<void> {
    // If URL has a new ?ux= param, replace any existing session
    const urlUx = new URLSearchParams(window.location.search).get("ux");
    if (LLMLogger.urlParamSession) {
      if (!urlUx || urlUx === LLMLogger.urlParamSession.sessionId) return;
      // New session from URL — tear down old session silently
      LLMLogger.urlParamSession.unregisterTracingHook();
      LLMLogger.urlParamSession.sessionId = null;
      LLMLogger.urlParamSession.entryBuffer = [];
      LLMLogger.urlParamSession = undefined;
      // Don't clear cookies — checkUrlParam will overwrite them
    }
    LLMLogger.bootstrap();

    const sessionId = LLMLogger.checkUrlParam();
    if (!sessionId) return;

    // Mint the harness cookie at this logged-in launch BEFORE the test can sign
    // out (e.g. onboarding flows). The `.lona.so` cookie then rides through the
    // anonymous parts of the flow so the now-guarded /_/ux-test routes still
    // accept the harness's logs/complete posts. Best-effort + memoized.
    if (!options.headless) void LlmLoggerApi.ensureToken();

    // Activate session IMMEDIATELY - don't wait for fetch
    LLMLogger.urlParamSession = new LLMLogger();
    LLMLogger.urlParamSession.sessionId = sessionId;
    LLMLogger.urlParamSession.batchIntervalMs = LLMLogger.SESSION_BATCH_INTERVAL_MS;
    LLMLogger.urlParamSession.maxChunksPerFlush =
      LLMLogger.SESSION_MAX_CHUNKS_PER_FLUSH;
    LLMLogger.urlParamSession.maxBufferEntries =
      LLMLogger.SESSION_MAX_BUFFER_ENTRIES;
    LLMLogger.urlParamSession.unloadSendsOldest = true;
    LLMLogger.urlParamSession.onSessionLost = () =>
      LLMLogger.urlParamSession?.cleanupUrlParamSession();
    LLMLogger.urlParamSession.registerTracingHook();

    // Expose the headless completion hook for the Deno `tento-ux-runner`
    // (`ux-test run --auto`). Registered HERE — wherever a `?ux=` session
    // activates — not in a route shim: app entry points (e.g. the calendar
    // `index.root`) call `initFromUrlParam` directly and never load the
    // `llm-session` shim, so a shim-only registration is missing on the calendar
    // page. Flushes logs + posts `/_/ux-test/complete`; see `completeExternally`.
    // The global's shape is the crate-owned harness contract (`HarnessGlobals`).
    //
    // Two names, one function: `__uxComplete` is the contract, and the
    // pre-rename `__lonaUxComplete` alias is kept so an agent, a bookmarklet, or
    // a runner older than this bundle still completes a session. Deprecated —
    // remove both this line and the protocol field together.
    const complete: CompleteHook = (result, feedback) =>
      LLMLogger.completeExternally(result, feedback);
    const globals = window as unknown as HarnessGlobals;
    globals.__uxComplete = complete;
    globals.__lonaUxComplete = complete;
    // The runner's drain before it replaces the document (a spec `navigate`)
    // and before completion; see `flushExternally`.
    globals.__uxFlush = () => LLMLogger.flushExternally();
    // A measurement control: detach (false) or attach (true) the console ->
    // tracing bridge below, so a perf run can price what the bridge costs the
    // page. Spans and `Tracing.log` records upload either way.
    globals.__uxLogSink = (attached) => {
      if (attached) LLMLogger.installLogSink();
      else LLMLogger.removeLogSink();
      return LLMLogger.logSinkInstalled;
    };

    // Bridge console output into Tracing so UX tests capture logs
    LLMLogger.installLogSink();

    // Capture unhandled exceptions and rejections during UX test sessions
    initErrorForwarding();

    // Track navigation events (pushState/replaceState/popstate)
    LLMLogger.startNavigationTracking();

    // Log page load via Tracing (captured by hook)
    Tracing.span("page-load", () => {
      Tracing.record("url", window.location.href);
      Tracing.record("path", window.location.pathname);
      Tracing.record("hostname", window.location.hostname);
      Tracing.record("userAgent", navigator.userAgent);
      Tracing.record("viewport", {
        width: window.innerWidth,
        height: window.innerHeight,
      });
      Tracing.record("screen", {
        width: screen.width,
        height: screen.height,
      });
      Tracing.record("online", navigator.onLine);
    });

    // A named headless runner owns logs/completion, without a token or UI API.
    if (options.headless) return;

    // Fetch session details asynchronously for the popover UI. Await the mint
    // kicked off above (memoized — same in-flight POST) so the harness cookie is
    // present before this now-guarded /_/ux-test/session/{id} call.
    await LlmLoggerApi.ensureToken();
    const session = await LLMLogger.fetchSession(sessionId);
    if (session) {
      LLMLogger.urlParamSession.showUrlParamSessionPopover(session);
    } else {
      // Fallback: show Works/Broken with no steps so the operator can still complete the test
      console.warn("[LLMLogger] fetchSession returned null — showing fallback popover");
      LLMLogger.urlParamSession.showUrlParamSessionPopover({
        id: sessionId,
        prefix: sessionId,
        instructions: [],
        status: "in_progress",
        createdAt: DateTime.utc.now(),
      });
    }
  }

  private static checkUrlParam(): Option<string> {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("ux");

    if (sessionId) {
      // New session from URL — clear stale steps from any previous test
      LLMLogger.clearCompletedSteps();

      Cookies.set(LLMLogger.STORAGE_KEY, {
        value: sessionId,
        domain: LLMLogger.COOKIE_DOMAIN,
        days: 1,
        sameSite: "Lax",
      });

      // Save origin so log POSTs survive cross-domain redirects (e.g. Stripe portal)
      Cookies.set(LLMLogger.ORIGIN_COOKIE, {
        value: window.location.origin,
        domain: LLMLogger.COOKIE_DOMAIN,
        days: 1,
        sameSite: "Lax",
      });

      // Persist tracing session ID for auth redirect survival
      const tid = params.get("tid");
      if (tid) {
        Cookies.set(LLMLogger.TRACING_ID_COOKIE, {
          value: tid,
          domain: LLMLogger.COOKIE_DOMAIN,
          days: 1,
          sameSite: "Lax",
        });
      }

      const url = new URL(window.location.href);
      url.searchParams.delete("ux");
      url.searchParams.delete("tid");
      window.history.replaceState({}, "", url.toString());
      return sessionId;
    }
    return Cookies.get(LLMLogger.STORAGE_KEY);
  }

  private static async fetchSession(
    sessionId: string,
  ): Promise<Option<LlmSession>> {
    try {
      const api = LlmLoggerApi.getApi();
      if (!api) {
        console.warn("[LLMLogger] fetchSession: no API instance");
        return undefined;
      }
      const session = await api.get("/_/ux-test/session/{session_id}", {
        path: { session_id: sessionId },
      });
      return session;
    } catch (err) {
      console.warn("[LLMLogger] fetchSession failed:", err);
      return undefined;
    }
  }

  /**
   * Get completed step indices from cookie (for cross-subdomain persistence).
   */
  private static getCompletedSteps(): number[] {
    const raw = Cookies.get(LLMLogger.STEPS_KEY);
    if (!raw) return [];
    try {
      const decoded = decodeURIComponent(raw);
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Ignore parse errors
    }
    return [];
  }

  private static updateCompletedStep(
    stepIndex: number,
    checked: boolean,
  ): void {
    let steps = LLMLogger.getCompletedSteps();

    if (checked) {
      if (!steps.includes(stepIndex)) {
        steps.push(stepIndex);
      }
    } else {
      steps = steps.filter((s) => s !== stepIndex);
    }

    Cookies.set(LLMLogger.STEPS_KEY, {
      value: encodeURIComponent(JSON.stringify(steps)),
      domain: LLMLogger.COOKIE_DOMAIN,
      days: 1,
      sameSite: "Lax",
    });
  }

  private static clearCompletedSteps(): void {
    Cookies.remove(LLMLogger.STEPS_KEY, LLMLogger.COOKIE_DOMAIN);
  }

  private static clearSessionCookies(): void {
    Cookies.remove(LLMLogger.STORAGE_KEY, LLMLogger.COOKIE_DOMAIN);
    Cookies.remove(LLMLogger.TRACING_ID_COOKIE, LLMLogger.COOKIE_DOMAIN);
    Cookies.remove(LLMLogger.ORIGIN_COOKIE, LLMLogger.COOKIE_DOMAIN);
    LLMLogger.clearCompletedSteps();
  }

  static getUrlParamSessionId(): Option<string> {
    return LLMLogger.urlParamSession?.sessionId;
  }

  static getPendingFlakyCount(): number {
    return LLMLogger.pendingFlakySessions.length;
  }

  static toggleFlakyToasts(): void {
    if (LLMLogger.flakyToastsVisible) {
      LLMLogger.hideFlakyToasts();
    } else {
      LLMLogger.showFlakyToasts();
    }
  }

  private static showFlakyToasts(): void {
    for (const session of LLMLogger.pendingFlakySessions) {
      if (LLMLogger.flakyInstances.has(session.id)) continue;

      const instance = new LLMLogger();
      instance.onSessionLost = () => instance.cleanupFlaky();
      LLMLogger.flakyInstances.set(session.id, instance);
      instance.showFlakySessionPopover(session);
    }
    LLMLogger.flakyToastsVisible = true;
  }

  private static hideFlakyToasts(): void {
    for (const instance of LLMLogger.flakyInstances.values()) {
      instance.toastHandle?.dismiss();
      instance.unregisterTracingHook();
    }
    LLMLogger.flakyInstances.clear();
    LLMLogger.flakyToastsVisible = false;
  }

  static async checkPending(): Promise<void> {
    if (!LLMLogger.isEnabled) return;

    // Skip if URL-param session is active
    const urlParamSessionId = Cookies.get(LLMLogger.STORAGE_KEY);
    if (urlParamSessionId) {
      return;
    }

    // Mint the harness cookie before hitting the now-guarded poll routes. On a
    // logged-in surface (where polling happens) this Set-Cookies the token; on
    // anon pages it 401s harmlessly and the earlier-minted cookie is used.
    await LlmLoggerApi.ensureToken();

    await LLMLogger.loadPendingNonFlaky();

    if (LLMLogger.hasOngoingSession()) {
      await LLMLogger.showNonFlakyToast();
    }

    await LLMLogger.loadPendingFlaky();
  }

  static hasOngoingSession(): boolean {
    const steps = LLMLogger.getCompletedSteps();
    return steps.length > 0;
  }

  private static async loadPendingNonFlaky(): Promise<void> {
    const api = LlmLoggerApi.getApi();
    if (!api) return;
    const session = await api.get("/_/ux-test/pending");
    if (session != null && session.flaky == null) {
      LLMLogger.pendingNonFlakySession = session;
    }
  }

  static getPendingNonFlakyCount(): number {
    return LLMLogger.pendingNonFlakySession ? 1 : 0;
  }

  static async toggleNonFlakyToast(): Promise<void> {
    if (LLMLogger.nonFlakyToastVisible) {
      LLMLogger.hideNonFlakyToast();
    } else {
      await LLMLogger.showNonFlakyToast();
    }
  }

  private static async showNonFlakyToast(): Promise<void> {
    if (LLMLogger.isLoadingNonFlaky) return;
    if (!LLMLogger.pendingNonFlakySession) {
      LLMLogger.isLoadingNonFlaky = true;
      try {
        await LLMLogger.loadPendingNonFlaky();
      } finally {
        LLMLogger.isLoadingNonFlaky = false;
      }
    }
    const session = LLMLogger.pendingNonFlakySession;
    if (!session) return;
    if (LLMLogger.instance) return;

    LLMLogger.instance = new LLMLogger();
    LLMLogger.instance.onSessionLost = () => LLMLogger.instance?.cleanup();
    LLMLogger.instance.showSessionPopover(session);
    LLMLogger.nonFlakyToastVisible = true;
  }

  private static hideNonFlakyToast(): void {
    if (LLMLogger.instance) {
      LLMLogger.instance.toastHandle?.dismiss();
      LLMLogger.instance.unregisterTracingHook();
      LLMLogger.instance = undefined;
    }
    LLMLogger.nonFlakyToastVisible = false;
  }

  private static async loadPendingFlaky(): Promise<void> {
    const api = LlmLoggerApi.getApi();
    if (!api) return;
    const sessions = await api.get("/_/ux-test/pending-flaky");
    if (sessions == null || sessions.length === 0) return;
    LLMLogger.pendingFlakySessions = sessions;
  }

  // ---------------------------------------------------------------------------
  // Navigation tracking
  // ---------------------------------------------------------------------------

  private static navigationTrackingActive = false;
  private static originalPushState: Option<typeof history.pushState>;
  private static originalReplaceState: Option<typeof history.replaceState>;

  private static startNavigationTracking(): void {
    if (LLMLogger.navigationTrackingActive) return;
    LLMLogger.navigationTrackingActive = true;

    LLMLogger.originalPushState = history.pushState.bind(history);
    LLMLogger.originalReplaceState = history.replaceState.bind(history);

    const emitNavigation = (from: string, to: string) => {
      if (from === to) return;
      Tracing.span("navigation", () => {
        Tracing.record("from", from);
        Tracing.record("to", to);
      });
    };

    history.pushState = function (...args: Parameters<typeof history.pushState>) {
      const from = location.pathname;
      LLMLogger.originalPushState!(...args);
      emitNavigation(from, location.pathname);
    };

    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
      const from = location.pathname;
      LLMLogger.originalReplaceState!(...args);
      emitNavigation(from, location.pathname);
    };

    window.addEventListener("popstate", LLMLogger.onPopState);
  }

  private static onPopState = (() => {
    let lastPath = typeof location !== "undefined" ? location.pathname : "";
    return () => {
      const from = lastPath;
      const to = location.pathname;
      lastPath = to;
      if (from === to) return;
      Tracing.span("navigation", () => {
        Tracing.record("from", from);
        Tracing.record("to", to);
      });
    };
  })();

  private static stopNavigationTracking(): void {
    if (!LLMLogger.navigationTrackingActive) return;
    LLMLogger.navigationTrackingActive = false;

    if (LLMLogger.originalPushState) {
      history.pushState = LLMLogger.originalPushState;
      LLMLogger.originalPushState = undefined;
    }
    if (LLMLogger.originalReplaceState) {
      history.replaceState = LLMLogger.originalReplaceState;
      LLMLogger.originalReplaceState = undefined;
    }
    window.removeEventListener("popstate", LLMLogger.onPopState);
  }

  // ---------------------------------------------------------------------------
  // Tracing hook
  // ---------------------------------------------------------------------------

  private registerTracingHook(): void {
    this.onEntryCallback = (entry: Tracing.LjsonEntry) => {
      // Filter out our own upload endpoint to prevent loops
      const path = entry.rootSpan.attributes["http.path"];
      if (
        entry.rootSpan.name === "api-call" &&
        typeof path === "string" &&
        path.startsWith("/_/ux-test/")
      ) {
        return;
      }
      this.entryBuffer.push(entry);
      if (this.entryBuffer.length > this.maxBufferEntries) {
        const dropped = this.entryBuffer.length - this.maxBufferEntries;
        this.entryBuffer.splice(0, dropped);
        // Oldest-out eviction is a data loss the harness cannot see: the missing
        // spans read downstream as behavior the product never performed. Say it
        // once, on the console, so a run that loses its early window says so
        // instead of failing verification for a fictional reason. (Raw
        // `console.warn`, not `Tracing.warn` — a Tracing call here would re-enter
        // this very callback.)
        if (!this.overflowWarned) {
          this.overflowWarned = true;
          console.warn(
            `[LLMLogger] entry buffer hit ${this.maxBufferEntries} — oldest ` +
              "entries are being dropped before upload; captured logs are " +
              "incomplete for this session",
          );
        }
      }
      this.scheduleBatch();
    };
    Tracing.onEntry(this.onEntryCallback);
  }

  private unregisterTracingHook(): void {
    if (this.onEntryCallback) {
      Tracing.removeOnEntry(this.onEntryCallback);
      this.onEntryCallback = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Session popovers
  // ---------------------------------------------------------------------------

  private showSessionPopover(session: LlmSession): void {
    // Server session state is authoritative when present; the
    // cross-subdomain cookie remains the fallback for sessions predating
    // `completedSteps`.
    const completedSteps = session.completedSteps?.length
      ? session.completedSteps
      : LLMLogger.getCompletedSteps();

    const $popover = UxTestPopover.make();
    $popover.bind({
      prefix: session.prefix,
      instructions: session.instructions,
      completedSteps,
      displayParams: session.displayParams ?? undefined,
    });

    $popover.delegate = {
      onStart: () => this.start(session),
      onDone: (result, feedback) => this.complete(result, feedback),
      onSkip: () => this.skip(),
      onStepChanged: (stepIndex, stepText, checked) => {
        LLMLogger.updateCompletedStep(stepIndex, checked);
        // Server-owned, idempotent set-state: the server appends the
        // authoritative step-marker to the trace itself (single writer, no-op
        // when the state already matches), so repeated or stale-UI clicks
        // cannot oscillate the recorded state the way client-emitted markers
        // did. The cookie above stays as an offline/back-compat cache.
        void LlmLoggerApi.getApi()?.postResult("/_/ux-test/step", {
          body: { sessionId: session.id, stepIndex, stepText, checked },
        });
      },
    };

    // 0/1-instruction tests have no "Start" step — the popover shows Works/Broken
    // immediately (see UxTestPopover.bind), so begin recording now rather than
    // waiting for a Start click that no longer exists.
    if (session.instructions.length <= 1) {
      this.start(session);
    }

    this.toastHandle = LLMLogger.showMiniWindow(session.prefix, $popover);
  }

  private showFlakySessionPopover(session: LlmSession): void {
    this.sessionId = session.id;
    this.registerTracingHook();

    const $popover = UxTestPopover.make();
    $popover.bind({
      prefix: session.prefix,
      instructions: session.instructions,
      flaky: true,
      flakyContext: session.flaky ?? undefined,
      displayParams: session.displayParams ?? undefined,
    });

    $popover.delegate = {
      onStart: () => {},
      onDone: (result, feedback) => this.completeFlakySession(result, feedback),
      onSkip: () => {},
      onStepChanged: () => {},
    };

    this.toastHandle = LLMLogger.showMiniWindow(session.prefix, $popover);
  }

  private showUrlParamSessionPopover(session: LlmSession): void {
    // Server session state is authoritative when present; the
    // cross-subdomain cookie remains the fallback for sessions predating
    // `completedSteps`.
    const completedSteps = session.completedSteps?.length
      ? session.completedSteps
      : LLMLogger.getCompletedSteps();

    const $popover = UxTestPopover.make();
    $popover.bind({
      prefix: session.prefix,
      instructions: session.instructions,
      completedSteps,
      autoStart: true,
      displayParams: session.displayParams ?? undefined,
    });

    $popover.delegate = {
      onStart: () => {},
      onDone: (result, feedback) =>
        this.completeUrlParamSession(result, feedback),
      onSkip: () => void this.abandonSession(() => this.cleanupUrlParamSession()),
      onStepChanged: (stepIndex, stepText, checked) => {
        LLMLogger.updateCompletedStep(stepIndex, checked);
        // Server-owned, idempotent set-state: the server appends the
        // authoritative step-marker to the trace itself (single writer, no-op
        // when the state already matches), so repeated or stale-UI clicks
        // cannot oscillate the recorded state the way client-emitted markers
        // did. The cookie above stays as an offline/back-compat cache.
        void LlmLoggerApi.getApi()?.postResult("/_/ux-test/step", {
          body: { sessionId: session.id, stepIndex, stepText, checked },
        });
      },
    };

    this.toastHandle = LLMLogger.showMiniWindow(session.prefix, $popover);
  }

  private static showMiniWindowFn: Option<
    (prefix: string, $content: HTMLElement) => { dismiss: () => void }
  >;

  static registerShowMiniWindow(
    fn: (prefix: string, $content: HTMLElement) => { dismiss: () => void },
  ): void {
    LLMLogger.showMiniWindowFn = fn;
  }

  private static showMiniWindow(
    prefix: string,
    $content: HTMLElement,
  ): { dismiss: () => void } {
    if (!LLMLogger.showMiniWindowFn) {
      console.warn("[LLMLogger] showMiniWindow called before UI registered");
      return { dismiss: () => {} };
    }
    return LLMLogger.showMiniWindowFn(prefix, $content);
  }

  private start(session: LlmSession): void {
    this.sessionId = session.id;
    this.registerTracingHook();
    LLMLogger.installLogSink();
    LLMLogger.startNavigationTracking();
  }

  // ---------------------------------------------------------------------------
  // Flush entries
  // ---------------------------------------------------------------------------

  private scheduleBatch(): void {
    if (this.batchTimer != null) return;

    this.batchTimer = window.setTimeout(() => {
      this.batchTimer = undefined;
      void this.flushEntries();
    }, this.batchIntervalMs);
  }

  /** Max payload size per POST — stay under actix's default 32KB JSON limit. */
  private static MAX_CHUNK_BYTES = 24_000;

  /**
   * Largest body sent with `keepalive`. Browsers cap the TOTAL of in-flight
   * keepalive bodies (fetch keepalive + `sendBeacon`) at 64KiB per document.
   * A chunk is ≤ MAX_CHUNK_BYTES (24_000 string units — only a single entry
   * larger than that gets a chunk of its own that exceeds it) and uploads are
   * serialized through `flushChain`, so one upload is in flight at a time.
   */
  private static KEEPALIVE_MAX_BYTES = 60_000;

  /**
   * POST one chunk. `keepalive` lets an upload already in flight survive the
   * page navigating away — `location.href = <billing portal>` right after an
   * action used to cancel it, and the entries it had taken from the buffer
   * (never beaconed: page-hide only sees what is still buffered) were lost.
   * A body over the budget, or a budget already used by another keepalive
   * request (tracing's own flush, page-hide beacons), makes a keepalive fetch
   * reject at once; retry it as a plain fetch rather than stall the queue.
   */
  private static async postChunk(url: string, json: string): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
    };
    if (new TextEncoder().encode(json).length <= LLMLogger.KEEPALIVE_MAX_BYTES) {
      try {
        return await fetch(url, { ...init, keepalive: true });
      } catch {
        // Keepalive quota refused (or a network error) — one plain attempt.
      }
    }
    return await fetch(url, init);
  }

  // All uploads are serialized through this chain: at most one /_/ux-test/logs
  // request is in flight per session, no matter how flushes overlap.
  private flushChain: Promise<void> = Promise.resolve();

  /**
   * Upload buffered entries. Timed flushes upload at most this instance's
   * `maxChunksPerFlush` chunks and leave the remainder for the next interval;
   * `drain` (used on session-complete) uploads everything.
   */
  private flushEntries(drain = false): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.flushEntriesInner(drain));
    return this.flushChain;
  }

  /** A body that is not JSON — a gateway page, an aborted read — is `null`,
   * which is exactly what `ResponseError.of` is defined over. */
  private static async jsonOrNull(response: Response): Promise<Option<UntypedJson>> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private async flushEntriesInner(drain: boolean): Promise<void> {
    if (this.entryBuffer.length === 0 || this.sessionId == null) return;

    const entries = this.entryBuffer;
    this.entryBuffer = [];

    // Count of entries confirmed uploaded; on any failure only the unsent tail
    // is restored, so a mid-flush failure can't re-send (duplicate) chunks that
    // already landed.
    let sent = 0;
    let chunksSent = 0;

    for (const chunk of LLMLogger.chunkEntries(this.sessionId, entries)) {
      if (!drain && chunksSent >= this.maxChunksPerFlush) break;
      try {
        const response = await LLMLogger.postChunk(
          `${LlmLoggerApi.getBaseUrl() ?? ""}/_/ux-test/logs`,
          chunk.json,
        );

        if (!response.ok) {
          // This is a raw `fetch`, not a `TypedApi` route, so the envelope has
          // to be read explicitly — but through `ResponseError.of`, which is
          // the one place that knows the shapes on this wire. Reading
          // `body.reason` by hand here was a second reader of the same field,
          // and it matched only the surfaces that answer `{ reason, details }`.
          const error = ResponseError.of(
            response.status,
            await LLMLogger.jsonOrNull(response),
          );
          if (error.reason === "session_not_found") {
            console.warn(
              `[LLMLogger] Session not found: ${this.sessionId}. Cleaning up.`,
            );
            this.onSessionLost?.();
            return;
          }
          break;
        }

        sent += chunk.count;
        chunksSent += 1;
      } catch {
        // Network error — stop and retry the unsent tail next interval
        break;
      }
    }

    const remaining = entries.slice(sent);
    if (remaining.length > 0) {
      this.entryBuffer = [...remaining, ...this.entryBuffer];
      this.scheduleBatch();
    }
  }

  /**
   * Send one chunk while the page is going away. A keepalive `fetch` with a
   * STRING body, not `sendBeacon(Blob)`: a Blob beacon sent at
   * `beforeunload` reaches the network with a body that DevTools request
   * interception cannot read (`postData()` and `fetchPostData()` both come
   * back empty, HeadlessChrome 152), so a ux-test runner that sinks harness
   * posts for a remote target lost every entry logged since the last timed
   * upload — the POST and the api-call that trigger a navigation to Stripe
   * among them (subscription/settings-plan-management on rc). A keepalive
   * fetch has the same 64KiB budget and survives the unload the same way. If
   * it is refused (budget spent), fall back to the beacon.
   */
  private static sendOnUnload(url: string, json: string): boolean {
    const beacon = () => navigator.sendBeacon(url, new Blob([json], { type: "application/json" }));
    try {
      void fetch(url, {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: json,
      }).catch(() => {
        beacon();
      });
      return true;
    } catch {
      return beacon();
    }
  }

  private flushSync(): void {
    if (this.entryBuffer.length === 0 || this.sessionId == null) return;

    const entries = this.entryBuffer;
    this.entryBuffer = [];

    const url = `${LlmLoggerApi.getBaseUrl() ?? ""}/_/ux-test/logs`;
    const chunks = [...LLMLogger.chunkEntries(this.sessionId, entries)];
    const sent = this.unloadSendsOldest
      ? LLMLogger.oldestWithinKeepalive(chunks)
      : (i: number) => i >= chunks.length - LLMLogger.MAX_SYNC_CHUNKS;

    // Entries that didn't fit the unload cap — or whose send the browser
    // refused at once (see `sendOnUnload`) — stay
    // buffered: on a tab switch (visibilitychange) they upload on the next
    // timed batch; on a real unload they're dropped — the acceptable cost of
    // keeping page-hide bounded.
    const unsent: Tracing.LjsonEntry[] = [];
    let offset = 0;
    chunks.forEach((chunk, i) => {
      const covered = entries.slice(offset, offset + chunk.count);
      offset += chunk.count;
      const queued = sent(i) && LLMLogger.sendOnUnload(url, chunk.json);
      if (!queued) unsent.push(...covered);
    });
    if (unsent.length > 0) {
      this.entryBuffer = [...unsent, ...this.entryBuffer];
    }
  }

  /**
   * The leading chunks whose bodies fit KEEPALIVE_MAX_BYTES together: a
   * contiguous run from the oldest, so what a page-hide could not carry is the
   * newest tail, never a hole in the middle of the record. The first chunk is
   * always tried (a single oversized entry falls back as `sendOnUnload` says).
   */
  private static oldestWithinKeepalive(
    chunks: { json: string }[],
  ): (i: number) => boolean {
    const encoder = new TextEncoder();
    let bytes = 0;
    let fits = 0;
    for (const chunk of chunks) {
      bytes += encoder.encode(chunk.json).length;
      if (fits > 0 && bytes > LLMLogger.KEEPALIVE_MAX_BYTES) break;
      fits += 1;
    }
    return (i) => i < fits;
  }

  /**
   * Split entries into JSON-serialized chunks that fit under MAX_CHUNK_BYTES.
   * Each chunk carries its ready-to-send JSON string
   * (`{"sessionId":"...","entries":[...]}`) plus the number of entries in it,
   * so callers can track exactly which entries a chunk covers.
   */
  private static *chunkEntries(
    sessionId: string,
    entries: Tracing.LjsonEntry[],
  ): Generator<{ json: string; count: number }> {
    if (entries.length === 0) return;

    // Envelope overhead: {"sessionId":"...","entries":[]}
    const envelope = JSON.stringify({ sessionId, entries: [] }).length;
    let chunk: Tracing.LjsonEntry[] = [];
    let chunkSize = envelope;

    for (const entry of entries) {
      const entrySize = JSON.stringify(entry).length + 1; // +1 for comma
      if (chunk.length > 0 && chunkSize + entrySize > LLMLogger.MAX_CHUNK_BYTES) {
        yield { json: JSON.stringify({ sessionId, entries: chunk }), count: chunk.length };
        chunk = [];
        chunkSize = envelope;
      }
      chunk.push(entry);
      chunkSize += entrySize;
    }

    if (chunk.length > 0) {
      yield { json: JSON.stringify({ sessionId, entries: chunk }), count: chunk.length };
    }
  }

  // ---------------------------------------------------------------------------
  // Session completion and cleanup
  // ---------------------------------------------------------------------------

  private async completeSession(
    result: "success" | "failure",
    feedback: Option<string>,
    cleanup: () => void,
    successMessage: string = "UX test completed - works now",
    failureMessage: string = "UX test completed - still broken",
  ): Promise<void> {
    // A root still waiting on an in-flight async child is in no buffer yet;
    // queue it now (marked `trace.flush`) so this session's drain carries it.
    Tracing.releaseHeld();
    await this.flushEntries(true);
    // Flush tracing entries so server has all client spans before completion
    Tracing.flushBeacon();
    if (this.sessionId != null) {
      const r = await LlmLoggerApi.getApi()
        ?.postResult("/_/ux-test/complete", {
          body: { sessionId: this.sessionId, result, feedback },
        });
      if (r?.err()?.reason === "session_not_found") {
        console.warn(`[LLMLogger] Session gone during complete: ${this.sessionId}`);
      }
    }
    cleanup();
    Toast.info(result === "success" ? successMessage : failureMessage);
  }

  private async complete(
    result: "success" | "failure",
    feedback?: Option<string>,
  ): Promise<void> {
    await this.completeSession(result, feedback, () => this.cleanup());
  }

  private async completeFlakySession(
    result: "success" | "failure",
    feedback?: Option<string>,
  ): Promise<void> {
    await this.completeSession(result, feedback, () => this.cleanupFlaky());
  }

  /**
   * Skip is a TERMINAL outcome, not just an overlay dismissal. Without the post
   * the server never learns the operator walked away: the session stays
   * `pending` forever, keeps inflating the badge count, and any `ux-test await`
   * on it burns its whole timeout before failing for the wrong reason.
   *
   * Teardown is unconditional — a failed post must still dismiss the overlay,
   * because the alternative is an operator trapped in a session they already
   * declined. The post is sequenced BEFORE `cleanup()` so it still carries the
   * session cookies the route sees.
   */
  private async abandonSession(cleanup: () => void): Promise<void> {
    if (this.sessionId != null) {
      const r = await LlmLoggerApi.getApi()
        ?.postResult("/_/ux-test/abandon", { body: { sessionId: this.sessionId } });
      if (r?.err() != null) {
        console.warn(`[LLMLogger] Abandon post failed for ${this.sessionId}`);
      }
    }
    cleanup();
  }

  private skip(): void {
    void this.abandonSession(() => this.cleanup());
  }

  private cleanup(): void {
    this.toastHandle?.dismiss();
    this.unregisterTracingHook();
    LLMLogger.removeLogSink();
    LLMLogger.clearSessionCookies();
    this.sessionId = null;
    LLMLogger.instance = undefined;
    LLMLogger.pendingNonFlakySession = undefined;
    LLMLogger.nonFlakyToastVisible = false;
    LLMLogger.stopNavigationTracking();
  }

  private cleanupFlaky(): void {
    this.toastHandle?.dismiss();
    this.unregisterTracingHook();
    if (this.sessionId != null) {
      LLMLogger.flakyInstances.delete(this.sessionId);
      LLMLogger.pendingFlakySessions = LLMLogger.pendingFlakySessions.filter(
        (s) => s.id !== this.sessionId,
      );
    }
    this.sessionId = null;
    this.entryBuffer = [];
  }

  /**
   * Headless driver entry: complete the active `?ux=` session externally (no
   * operator click). The Deno `tento-ux-runner` calls this via the
   * `window.__uxComplete` global after it finishes the steps; it flushes
   * logs + posts `/_/ux-test/complete` exactly as a Works/Broken click would.
   *
   * `result` is a neutral "steps executed" signal — the authoritative pass/fail
   * is the server-side trace verification, not this value.
   */
  static async completeExternally(
    result: "success" | "failure",
    feedback: Option<string>,
  ): Promise<void> {
    const session = LLMLogger.urlParamSession;
    if (!session) {
      console.warn("[LLMLogger] completeExternally: no active url-param session");
      return;
    }
    await session.completeUrlParamSession(result, feedback);
  }

  /**
   * Headless driver entry: upload everything the active `?ux=` session still
   * holds and resolve once it has landed, without completing the session. The
   * runner awaits it (`window.__uxFlush`) before each spec navigation, so no
   * log depends on the document outliving the batch window or fitting the
   * page-hide budget.
   */
  static async flushExternally(): Promise<void> {
    await LLMLogger.urlParamSession?.flushEntries(true);
  }

  private async completeUrlParamSession(
    result: "success" | "failure",
    feedback?: Option<string>,
  ): Promise<void> {
    await this.completeSession(
      result,
      feedback,
      () => this.cleanupUrlParamSession(),
      "UX test completed - works",
      "UX test completed - broken",
    );
  }

  private cleanupUrlParamSession(): void {
    this.toastHandle?.dismiss();
    this.unregisterTracingHook();
    LLMLogger.removeLogSink();
    LLMLogger.clearSessionCookies();
    this.sessionId = null;
    this.entryBuffer = [];
    LLMLogger.urlParamSession = undefined;
    LLMLogger.stopNavigationTracking();
  }

  // ---------------------------------------------------------------------------
  // Unload handlers
  // ---------------------------------------------------------------------------

  private static initUnloadHandlers(): void {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        LLMLogger.flushAllSync();
      }
    });

    // On a real unload, first queue roots still held open by in-flight async
    // children (they would otherwise die with the document). Not on a mere
    // tab switch (visibilitychange): those children may still settle.
    window.addEventListener("beforeunload", () => {
      Tracing.releaseHeld();
      LLMLogger.flushAllSync();
    });

    window.addEventListener("pagehide", () => {
      Tracing.releaseHeld();
      LLMLogger.flushAllSync();
    });
  }

  private static flushAllSync(): void {
    if (LLMLogger.urlParamSession?.sessionId) {
      LLMLogger.urlParamSession.flushSync();
    }

    if (LLMLogger.instance?.sessionId) {
      LLMLogger.instance.flushSync();
    }

    for (const instance of LLMLogger.flakyInstances.values()) {
      instance.flushSync();
    }
  }

  // ---------------------------------------------------------------------------
  // Console → Tracing bridge
  // ---------------------------------------------------------------------------

  private static logSinkInstalled = false;

  private static installLogSink(): void {
    if (LLMLogger.logSinkInstalled) return;
    LLMLogger.logSinkInstalled = true;
    // The bridge is live only while the console logger is installed:
    // `Logger.addSink` rebinds `Tracing.info/warn/err/dbg` into sink-forwarding
    // mode ONLY when logging is already enabled, and the boot-time enable
    // (`initCore` → `Tracing.install(false, cookie === "beta")`) reads the
    // `dev-mode` COOKIE alone — which a harness run never sets. Without this
    // call the sink sits behind no-op bindings: every `Tracing.info("ui")(…)` /
    // `Tracing.info("net")("api-call", …)` is discarded at the source until the
    // calendar's initial payload re-installs from the HOST-inferred mode
    // (seconds into boot, and never at all off `dev`), so the first-seconds
    // window a UX test is usually there to observe carries no console logs.
    // Scoped to an activated session, so an opted-out visitor's critical path
    // is untouched.
    Tracing.installToConsole();
    Tracing.addSink(tracingLogSink);
  }

  private static removeLogSink(): void {
    if (!LLMLogger.logSinkInstalled) return;
    LLMLogger.logSinkInstalled = false;
    Tracing.removeSink(tracingLogSink);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  static bootstrap(): void {
    if (LLMLogger.isBootstrapped) return;

    LLMLogger.isEnabled = true;
    LLMLogger.isBootstrapped = true;
    LLMLogger.initUnloadHandlers();
  }

  static init(): void {
    LLMLogger.bootstrap();
  }
}
