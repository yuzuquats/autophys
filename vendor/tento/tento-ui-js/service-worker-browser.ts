import { Tracing } from "@tento-core/tracing";
import { DebouncedRequests } from "@tento-core/debounced-requests";
import { LonaServiceWorkerCommon } from "./service-worker-common";
import { ServiceWorkerVersion } from "./service-worker-version";
import { Session } from "./session";
import { FetchConfig, TypedApi } from "@tento-core/typed-api";

export namespace LonaServiceWorkerBrowser {
  const SEND_TIMEOUT_MS = 5_000;
  const CONTROLLER_TIMEOUT_MS = 5_000;
  const CONTROLLER_READY_GRACE_MS = 150;

  export function hasController(): boolean {
    return typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      navigator.serviceWorker.controller != null;
  }

  /**
   * `requestId`s whose execution's refusal a reply for another handoff of the
   * SAME execution already reported — each is consumed (deleted) when its own
   * reply arrives, so the set only holds replies still in transit. Bounded in
   * case a reply never arrives (its `send` timed out).
   */
  const reportedForRequest = new Set<string>();
  const MAX_REPORTED_REQUESTS = 1_024;

  /**
   * Forward a failed debounced request to the page-side dispatcher. The
   * reply's `result` falls back to the worker's global "last result" when the
   * key misses, so only a key-matched result is trusted here — an unrelated
   * older failure must not raise a prompt against this request.
   *
   * Invariant (iii) — a refusal reaches every write its execution carried
   * before any of them settles. When the worker correlates (`requestIds`),
   * each handoff the execution carried gets its own reply, and replies arrive
   * as separate tasks in any order. So the FIRST reply that carries the
   * failure reports it — naming every carried id, which fails every carried
   * waiter at once — before its own bridge promise resolves; the later
   * replies of that execution find their id in `reportedForRequest` and stay
   * silent. A reply whose result does not name its own handoff describes a
   * different execution (a later request on the same key) and is ignored.
   * Called synchronously before the bridge promise resolves.
   */
  function reportDebouncedFailure(
    config: FetchConfig.Debounce,
    result: Option<DebouncedResult>,
  ): void {
    if (result == null || result.ok) return;
    if (result.customKey !== config.customKey) return;
    const carried = result.requestIds ?? null;
    if (carried != null && config.requestId != null) {
      if (!carried.includes(config.requestId)) return;
      if (reportedForRequest.delete(config.requestId)) return;
      for (const id of carried) {
        if (id !== config.requestId) reportedForRequest.add(id);
      }
      while (reportedForRequest.size > MAX_REPORTED_REQUESTS) {
        const oldest = reportedForRequest.values().next();
        if (oldest.done) break;
        reportedForRequest.delete(oldest.value);
      }
    }
    DebouncedRequests.report({
      customKey: result.customKey,
      requestIds: carried,
      url: result.url,
      status: result.status,
      reason: result.reason,
      details: result.details,
    });
  }

  /**
   * Invariant (iv) — a handoff whose transport gives no verdict is never
   * reported as accepted. When the worker's reply does not arrive (the
   * `send` timeout, an `err` reply, no controller, a message that cannot be
   * posted) the bridge reports THIS handoff as unanswered — status `0`, the
   * executors' "no answer", naming only its own `requestId` — before the
   * handoff's promise resolves, exactly as the page's fallback executor
   * reports a failed fetch. The durable write then settles as unanswered
   * (`EventWriteError` with `status: null`), its change taken back, and the
   * SDK re-reads the row: no answer does not mean the worker did not
   * persist it.
   */
  function reportUnanswered(config: FetchConfig.Debounce, err: Error): void {
    const { resolvedRoute } = FetchConfig.resolve(config.route, config.config);
    DebouncedRequests.report({
      customKey: config.customKey,
      requestIds: config.requestId == null ? null : [config.requestId],
      url: resolvedRoute,
      status: 0,
      reason: null,
      details: null,
    });
    Tracing.log("cell-persist/5-bridge-unanswered", {
      customKey: config.customKey ?? null,
      requestId: config.requestId ?? null,
      error: err.message,
    });
  }

  /**
   * A worker reply that arrives after its handoff already settled as
   * unanswered (`ReplyTimeout.late`). Handled deterministically, never as a
   * second verdict for the write:
   * - a refusal is reported as any reply's is (`reportDebouncedFailure`).
   *   Its write has settled, so no write claims it; it reaches the client's
   *   `onUnclaimedDurableFailure`, whose listener re-reads the row.
   * - an acceptance is ignored with a trace: the write already settled
   *   unanswered and the SDK re-read its row then; the persisted write shows
   *   from the server on that or the row's next read.
   */
  function onLateReply(config: FetchConfig.Debounce, late: Promise<Reply>): void {
    late.then(
      (msg) => {
        const result = msg.result ?? null;
        Tracing.log("cell-persist/5-bridge-late-reply", {
          customKey: config.customKey ?? null,
          requestId: config.requestId ?? null,
          status: result?.status ?? null,
          ok: result?.ok ?? null,
        });
        reportDebouncedFailure(config, result);
      },
      (err: Error) => {
        Tracing.log("cell-persist/5-bridge-late-error", {
          customKey: config.customKey ?? null,
          requestId: config.requestId ?? null,
          error: String(err),
        });
      },
    );
  }

  function installDebounceBridge(): void {
    TypedApi.installDebounce((config) => {
      // Debug instrumentation only: the `cell-persist/*` timeline is the
      // ux-test capture path for event edits, so the bridge tags those posts.
      // It gates NO routing — every failed debounced request is reported.
      const isCell = (config.customKey != null &&
        config.customKey.includes("cell:")) ||
        config.route.includes("/cells");
      if (isCell) {
        Tracing.log("cell-persist/4-bridge-post", {
          customKey: config.customKey ?? null,
          route: config.route,
          method: config.method,
          hasController: navigator.serviceWorker.controller != null,
        });
      }
      if (!navigator.serviceWorker.controller) {
        if (isCell) {
          Tracing.log("cell-persist/4-bridge-local-fallback", {
            customKey: config.customKey ?? null,
            route: config.route,
            method: config.method,
          });
        }
        return TypedApi.debounce(config);
      }
      return LonaServiceWorkerBrowser.send({
        type: "debounce.queue",
        content: config,
      }).then((msg) => {
        if (isCell) {
          Tracing.log("cell-persist/5-bridge-reply", {
            customKey: config.customKey ?? null,
            status: msg.status,
            message: msg.message,
            result: msg.result ?? null,
          });
        } else {
          Tracing.info("sw")(msg);
        }
        reportDebouncedFailure(config, msg.result ?? null);
      }).catch((err) => {
        if (isCell) {
          Tracing.log("cell-persist/5-bridge-error", {
            customKey: config.customKey ?? null,
            error: String(err),
          });
        } else {
          Tracing.err("sw")("debounce.queue failed", err);
        }
        // No verdict for this handoff — never resolve it as accepted (iv).
        reportUnanswered(
          config,
          err instanceof Error ? err : new Error(JSON.stringify(err)),
        );
        if (err instanceof ReplyTimeout) onLateReply(config, err.late);
      });
    });
  }

  /** The HTTP outcome of a debounced fetch the worker performed, mirrored
   *  back so the page can observe a status it otherwise never sees. Carries
   *  the server's typed `{reason, details}` on failure. */
  export type DebouncedResult = {
    customKey: Option<string>;
    /** The handoffs the worker's execution carried (`DebouncedRequests.Coalesced`);
     *  absent from a worker that predates correlation. */
    requestIds: Option<readonly string[]>;
    url: string;
    status: number;
    ok: boolean;
    reason: Option<string>;
    details: Option<string>;
  };

  export type Reply = {
    status: string;
    message: any;
    result?: Option<DebouncedResult>;
  };

  /**
   * `send`'s rejection when the worker's reply did not arrive within the
   * timeout. The message may still be answered: `late` settles with that
   * reply (or its `err`) whenever it comes, so a caller that already acted
   * on "no answer" can handle it deterministically (the debounce bridge's
   * `onLateReply`).
   */
  export class ReplyTimeout extends Error {
    constructor(
      readonly messageType: string,
      readonly timeoutMs: number,
      readonly late: Promise<Reply>,
    ) {
      super(
        `Service worker message timed out after ${timeoutMs}ms: ${messageType}`,
      );
      this.name = "ReplyTimeout";
    }
  }

  function sendToWorker<T>(
    worker: ServiceWorker,
    message: LonaServiceWorkerCommon.Message<T>,
  ): Promise<Reply> {
    let timer: Option<ReturnType<typeof setTimeout>> = null;
    const messagePromise = new Promise<Reply>(
      (resolve, reject) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (event) => {
          if (timer != null) clearTimeout(timer);
          if (event.data?.status === "err") {
            reject(event.data);
          } else {
            resolve(event.data);
          }
        };
        worker.postMessage(message, [ch.port2]);
      },
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ReplyTimeout(message.type, SEND_TIMEOUT_MS, messagePromise),
          ),
        SEND_TIMEOUT_MS,
      );
    });

    return Promise.race([messagePromise, timeoutPromise]);
  }

  export async function send<T>(
    message: LonaServiceWorkerCommon.Message<T>,
  ): Promise<Reply> {
    const controller = navigator.serviceWorker.controller;
    if (controller == null) {
      throw new Error("No active service worker controlling this page.");
    }
    return await sendToWorker(controller, message);
  }

  async function waitForController(
    timeoutMs: number,
    ms: () => number,
  ): Promise<Option<ServiceWorker>> {
    const current = navigator.serviceWorker.controller;
    if (current != null) return current;
    return await new Promise<Option<ServiceWorker>>((resolve) => {
      let settled = false;
      const finish = (
        controller: Option<ServiceWorker>,
        reason:
          | "controllerchange"
          | "ready"
          | "ready-no-controller"
          | "timeout",
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          onControllerChange,
        );
        Tracing.log("sw-start/wait-controller-done", {
          ms: ms(),
          reason,
          hasController: controller != null,
        });
        resolve(controller);
      };
      const onControllerChange = () => {
        finish(navigator.serviceWorker.controller ?? null, "controllerchange");
      };
      const timeout = setTimeout(
        () => finish(navigator.serviceWorker.controller ?? null, "timeout"),
        timeoutMs,
      );
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        onControllerChange,
      );
      void navigator.serviceWorker.ready.then(() => {
        const controller = navigator.serviceWorker.controller;
        if (controller != null) finish(controller, "ready");
        else {
          setTimeout(() => {
            finish(
              navigator.serviceWorker.controller ?? null,
              navigator.serviceWorker.controller != null
                ? "controllerchange"
                : "ready-no-controller",
            );
          }, CONTROLLER_READY_GRACE_MS);
        }
      });
    });
  }

  async function flushCellsWithActiveWorker(
    registration: ServiceWorkerRegistration,
    ms: () => number,
  ): Promise<void> {
    const activeWorker = await activeWorkerFromRegistration(
      registration,
      CONTROLLER_READY_GRACE_MS,
    );
    if (activeWorker == null) {
      Tracing.log("sw-start/no-controller-active-flush-skip", {
        ms: ms(),
        reason: "no-active-worker",
      });
      return;
    }
    try {
      Tracing.log("sw-start/no-controller-active-flush-begin", { ms: ms() });
      const flushReply = await sendToWorker(activeWorker, {
        type: "debounce.flush-cells",
        content: Session.browserId,
      });
      Tracing.log("sw-start/no-controller-active-flush-done", {
        ms: ms(),
        status: flushReply.status,
        message: flushReply.message,
        result: flushReply.result ?? null,
      });
    } catch (error) {
      Tracing.log("sw-start/no-controller-active-flush-error", {
        ms: ms(),
        error: String(error),
      });
    }
  }

  async function activeWorkerFromRegistration(
    registration: ServiceWorkerRegistration,
    timeoutMs: number,
  ): Promise<Option<ServiceWorker>> {
    if (registration.active != null) return registration.active;
    return await new Promise<Option<ServiceWorker>>((resolve) => {
      let settled = false;
      const finish = (worker: Option<ServiceWorker>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(worker);
      };
      const timeout = setTimeout(
        () => finish(registration.active ?? null),
        timeoutMs,
      );
      void navigator.serviceWorker.ready.then((readyRegistration) => {
        finish(readyRegistration.active ?? registration.active ?? null);
      });
    });
  }

  async function register(ms: () => number): Promise<Option<ServiceWorker>> {
    Tracing.info("?")("sw/register/start");
    Tracing.log("sw-start/register-begin", { ms: ms() });
    try {
      // @ts-ignore
      const registration = await navigator.serviceWorker.register(
        "/sw.root.js",
        {
          scope: "/",
        },
      );
      if (registration.installing) {
        Tracing.info("?")("sw/register/installing");
      } else if (registration.waiting) {
        Tracing.info("?")("sw/register/waiting");
      } else if (registration.active) {
        Tracing.info("?")("sw/register/active");
      }
      Tracing.info("?")("sw/register/finish");
      Tracing.log("sw-start/register-done", {
        ms: ms(),
        hasController: navigator.serviceWorker.controller != null,
      });
      const controller = await waitForController(CONTROLLER_TIMEOUT_MS, ms);
      if (controller == null) {
        await flushCellsWithActiveWorker(registration, ms);
      }
      return controller;
    } catch (error) {
      Tracing.err("?")(`sw/register/finish/error, reason=${error}`);
      return null;
    }
  }

  /**
   * Flush the cell writes a CURRENT worker (its version matched) still
   * holds, before the first sheet renders. A flush that fails — its reply
   * outlasted the send timeout, or the worker answered `err` — is traced as
   * what it is, a slow or failing flush on a current worker, and the boot
   * proceeds on that worker: it is not a version mismatch, so it neither
   * re-registers the worker nor sends the global flush an outdated one gets.
   * A durable write the flush carried already settles through its own
   * bridge reply (or that reply's timeout, as unanswered).
   */
  async function flushCellsOnCurrentWorker(ms: () => number): Promise<void> {
    try {
      const flushReply = await LonaServiceWorkerBrowser.send({
        type: "debounce.flush-cells",
        content: Session.browserId,
      });
      Tracing.log("cell-persist/6-reconnect-flush-cells", {
        ms: ms(),
        status: flushReply.status,
        message: flushReply.message,
        result: flushReply.result ?? null,
      });
      Tracing.info("sw")(
        "cell-persist/reconnect-flush-cells",
        flushReply.message,
        flushReply.result ?? null,
      );
    } catch (error) {
      Tracing.log("sw-start/current-worker-flush-error", {
        ms: ms(),
        timedOut: error instanceof ReplyTimeout,
        error: error instanceof Error ? error.message : String(error),
        version: ServiceWorkerVersion.version,
      });
      Tracing.warn("sw")(
        error instanceof ReplyTimeout
          ? "sw-start/current-worker-flush-timeout"
          : "sw-start/current-worker-flush-error",
        { ms: ms(), version: ServiceWorkerVersion.version },
      );
    }
  }

  export async function start(): Promise<Option<ServiceWorker>> {
    Tracing.info("?")("sw/init");
    if (!("serviceWorker" in navigator)) return;
    installDebounceBridge();
    // `start()` gates the sheet bootstrap in index.root.ts so that read requests
    // observe any pending SW-backed cell writes before the first sheet renders.
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    Tracing.log("sw-start/begin", {
      hasController: navigator.serviceWorker.controller != null,
    });

    if (navigator.serviceWorker.controller) {
      try {
        const { status, message: version } =
          await LonaServiceWorkerBrowser.send({
            type: "version",
            content: null,
          });
        Tracing.log("sw-start/version-reply", {
          ms: ms(),
          status,
          version,
          required: ServiceWorkerVersion.version,
        });
        if (status === "ok" && version === ServiceWorkerVersion.version) {
          Tracing.dev("sw/version", version);
          await flushCellsOnCurrentWorker(ms);
          return navigator.serviceWorker.controller;
        } else if (status !== "ok") {
          Tracing.dev("sw/version/register, reason=error");
        } else {
          Tracing.dev(
            `sw/version/register, reason=outdated, curr=${version}, required=${ServiceWorkerVersion.version}`,
          );
        }
      } catch (_e) {
        Tracing.log("sw-start/version-catch", { ms: ms() });
      }
      Tracing.log("sw-start/global-flush-begin", { ms: ms() });
      // The old worker's flush must not gate the boot: a reply that outlasts
      // the send timeout rejects, and an unguarded await here rejected
      // `start()` itself, stranding a returning user on the loading shell
      // (review C, S2). A failed flush is logged; registration proceeds.
      try {
        const flushReply = await LonaServiceWorkerBrowser.send({
          type: "debounce.flush",
          content: Session.browserId,
        });
        Tracing.log("sw-start/global-flush-done", {
          ms: ms(),
          status: flushReply.status,
          message: flushReply.message,
          result: flushReply.result ?? null,
        });
        Tracing.info("sw")(
          "sw-start/global-flush-done",
          flushReply.message,
          flushReply.result ?? null,
        );
      } catch (error) {
        Tracing.warn("sw")("sw-start/global-flush-error", {
          ms: ms(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return await register(ms);
  }
}
