import { Constants } from "@tento-core/constants";
import { DebouncedRequests } from "@tento-core/debounced-requests";
import { Tracing } from "@tento-core/tracing";
import { FetchConfig, TypedApi } from "@tento-core/typed-api";

import { debounce } from "./debounce";
import { ServiceWorkerVersion } from "./service-worker-version";

/**
 * The page's no-service-worker debounce executor (`initCore` installs it as
 * `TypedApi.installStaticDebounce`), DOM-free so a headless test drives the
 * production executor rather than a copy of it.
 *
 * Which handoffs each execution carries, so a refusal names only those. The
 * handoff's promise is the debounce's per-execution completion: it resolves
 * when the execution that CARRIED this handoff finishes, and any refusal is
 * reported inside that execution first — so a durable write settles on its
 * own execution's verdict, and hears a refusal before it settles (the
 * service-worker bridge's order).
 *
 * - The answer is read by `DebouncedRequests.classify`, the rule the lona
 *   service worker shares: a non-2xx, a followed redirect to a page that is
 *   not JSON (a login page) and an HTML page answering a JSON request are
 *   refusals, reported through `DebouncedRequests.report`; only a JSON (or
 *   bodyless) 2xx is an acceptance.
 * - Invariant (iv): an execution that gets no answer — the fetch failed,
 *   anything threw before the request was answered, or no answer came within
 *   `deadlineMs` (the fetch is then aborted) — reports status `0` ("no
 *   answer"), so its handoffs settle as unanswered, never as accepted, and
 *   a hung fetch cannot hold its durable write open forever.
 */
export namespace DebounceFallbackExecutor {
  /** How long one execution waits for its answer (and a refusal's body)
   *  before it aborts the fetch and reports no answer. Twice the
   *  service-worker bridge's reply timeout (5 s), which also covers the
   *  debounce wait; the fetch alone gets more. */
  export const DEADLINE_MS = 10_000;

  /** The timer seam — the `Tracing.Witness.WatchdogClock` shape, so a test
   *  advances a fake clock instead of waiting out the deadline. */
  export type Clock = Tracing.Witness.WatchdogClock;

  export type Options = {
    /** Sends the request (the global `fetch` in the page). */
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
    readonly clock: Clock;
    readonly deadlineMs: number;
  };

  /** The executor `TypedApi.installStaticDebounce` takes. */
  export type Executor = Parameters<typeof TypedApi.installStaticDebounce>[0];

  /** The real timers behind the `Clock` seam. Numbered here, because the
   *  platform's timer handle is a number in a browser and an object under
   *  Node's typings, and the seam speaks numbers. */
  function systemClock(): Clock {
    const handles = new Map<number, ReturnType<typeof setTimeout>>();
    let next = 1;
    return {
      now: () => performance.now(),
      setTimeout: (fn, ms) => {
        const id = next++;
        handles.set(
          id,
          setTimeout(() => {
            handles.delete(id);
            fn();
          }, ms),
        );
        return id;
      },
      clearTimeout: (id) => {
        const handle = handles.get(id);
        if (handle == null) return;
        handles.delete(id);
        clearTimeout(handle);
      },
    };
  }

  /** The page's executor: the global `fetch` (looked up at send time), the
   *  system clock, `DEADLINE_MS`. */
  export function system(): Executor {
    return create({
      fetch: (url, init) => fetch(url, init),
      clock: systemClock(),
      deadlineMs: DEADLINE_MS,
    });
  }

  export function create(options: Options): Executor {
    const coalesced = new DebouncedRequests.Coalesced();
    return (config, onFinish) => {
      const finish = onFinish ?? Constants.EMPTY_FUNCTION;
      const { resolvedRoute, params, body } = FetchConfig.resolve(
        config.route,
        config.config,
      );
      const debounceKey = config.customKey
        ? config.customKey + resolvedRoute
        : resolvedRoute;
      coalesced.queue(debounceKey, config.requestId);
      return debounce(
        debounceKey,
        async () => {
          // Synchronously at the start of the execution — the same tick the
          // debounce hands it the queued handoffs' completion.
          const requestIds = coalesced.take(debounceKey);
          const fetchUrl = params.size > 0
            ? `${resolvedRoute}?${params.toString()}`
            : resolvedRoute;
          try {
            await execute(options, config, requestIds, fetchUrl, body);
          } finally {
            finish();
          }
        },
        config.durationMs,
      );
    };
  }

  async function execute(
    options: Options,
    config: FetchConfig.Debounce,
    requestIds: Option<readonly string[]>,
    fetchUrl: string,
    body: FetchConfig.Resolved["body"],
  ): Promise<void> {
    const category = ServiceWorkerVersion.isServiceWorker ? "sw" : "?";
    const abort = new AbortController();
    let expired = false;
    const timer = options.clock.setTimeout(() => {
      expired = true;
      abort.abort();
    }, options.deadlineMs);
    const report = (refusal: DebouncedRequests.Refusal) =>
      DebouncedRequests.report({
        customKey: config.customKey,
        requestIds,
        url: fetchUrl,
        ...refusal,
      });
    try {
      let refusal: Option<DebouncedRequests.Refusal>;
      try {
        Tracing.info(category)("debounce/fetch", config.route);
        performance.mark(`[network][${config.route}] send start`);
        const response = await raceDeadline(
          options.fetch(fetchUrl, {
            method: config.method,
            headers: { "Content-Type": "application/json" },
            body: config.config.isSerialized ? body : JSON.stringify(body),
            signal: abort.signal,
          }),
          abort.signal,
        );
        // No-service-worker fallback executor: this is the only place a
        // debounced request's status is observable, so a refused write — or
        // an answer that is not the route's — has to be reported here too
        // or it settles as accepted.
        refusal = await raceDeadline(
          DebouncedRequests.classify(response),
          abort.signal,
        );
      } catch (err) {
        // No answer at all (the fetch failed, or the deadline aborted it):
        // `0`, as the service worker reports it — the handoffs this
        // execution carried must not settle as landed.
        Tracing.err(category)("debounce/fetch-error", err);
        report({
          status: 0,
          reason: null,
          details: expired
            ? `no answer within ${options.deadlineMs} ms`
            : String(err),
        });
        return;
      }
      if (refusal != null) report(refusal);
      Tracing.info(category)("debounce/fetch-finished", config.route);
      performance.mark(`[network][${config.route}] send end`);
      performance.measure(
        `[network][${config.route}] send`,
        `[network][${config.route}] send start`,
        `[network][${config.route}] send end`,
      );
    } finally {
      options.clock.clearTimeout(timer);
    }
  }

  /** `work`, or a rejection the moment `signal` aborts — a `fetch` stub (or
   *  a body read) that ignores its signal still cannot outlive the
   *  deadline. */
  function raceDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error("deadline expired"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error("deadline expired"));
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }
}
