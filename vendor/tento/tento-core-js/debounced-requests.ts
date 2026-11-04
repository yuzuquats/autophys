import { Tracing } from "./tracing";
import { ResponseError, TypedApi } from "./typed-api";

/**
 * Page-side error channel for DEBOUNCED requests.
 *
 * `TypedApi.debounce.post` is a durable handoff, not a request: the fetch
 * runs inside the service worker (or, with no controller, in the local
 * debounce executor), so a rejected write never surfaces on the caller's
 * promise. Both executors funnel their non-2xx outcomes here, and every
 * subscriber (`subscribe`) hears each one — the seam that lets a typed
 * server rejection (`reason` on the error body) reach the write that made
 * it.
 *
 * Transport-level and domain-free: this module knows about debounced
 * requests and the host's error envelope, nothing about what any particular
 * route means. Subscribers own route classification and any UI.
 *
 * SDK 2.0 alignment: this channel is the designated nack path for the
 * SW-durable `CloudMutationBackend.submit` — a submit that hands off to the
 * service worker still has to reject its overlay entry, and this is the pipe
 * that reply rides (`lona-sdk-2.0.project.docs/content/backends.md`, "The
 * write-failure return path"). Keep it request-shaped, not route-shaped.
 */
export namespace DebouncedRequests {
  /** A failed debounced request, as observed by whichever executor ran the
   *  fetch. */
  export type Failure = {
    /** The debounce key the request was queued under, null when unkeyed. */
    customKey: Option<string>;
    /**
     * The `requestId`s of the handoffs coalesced into the ONE execution that
     * failed (`Coalesced.take`), in queue order — null when the executor does
     * not correlate, or none of them carried an id. A shared key is not a
     * shared execution: a handoff queued while an earlier execution for the
     * key was already in flight runs separately and is not named here.
     */
    requestIds: Option<readonly string[]>;
    /** Resolved request URL, path params interpolated. */
    url: string;
    /**
     * HTTP status, or 0 when no answer arrived (the fetch failed, or the
     * executor's deadline aborted it). A 2xx status is an answer that is not
     * the route's — a followed redirect to a page, an HTML page — and `reason`
     * says which (`REDIRECTED_TO_PAGE`, `PAGE_ANSWER`): the server answered,
     * so the write is "malformed", never accepted (`unreadableAnswer`).
     */
    status: number;
    /** `reason` from the server's typed error body, when it parsed — or the
     *  executor's own reason for an answer that was not the route's
     *  (`classify`). */
    reason: Option<string>;
    /** `details` from the server's typed error body, when it parsed. */
    details: Option<string>;
  };

  export type Handler = (failure: Failure) => void;

  /** What `classify` makes of an answer that is not an acceptance: the
   *  `status`, `reason` and `details` a `Failure` carries. */
  export type Refusal = {
    readonly status: number;
    readonly reason: Option<string>;
    readonly details: Option<string>;
  };

  /** `Failure.reason` of a 2xx answer that is a followed redirect to a page
   *  that is not JSON — the login page a session that expired mid-edit is
   *  sent to (`303 Location: /login`). Nothing was stored. */
  export const REDIRECTED_TO_PAGE = "redirected-to-page";

  /** `Failure.reason` of a 2xx answer, not redirected, whose body is an HTML
   *  page — a proxy's or an app shell's page, not the route's JSON. */
  export const PAGE_ANSWER = "page-answer";

  /**
   * The one reading every debounced executor gives an answer (the page's
   * no-service-worker fallback, the lona service worker, the in-process
   * executor): `null` when the request was accepted, else the `Refusal` to
   * report. The same rule `TypedApi`'s ordinary verbs apply to a checked
   * write (`ResponseDecodeError`, "redirected to <url>, which is not JSON"):
   *
   * - a non-2xx status is a refusal with the server's typed error body
   *   (`parseErrorBody`);
   * - a 2xx that is a followed redirect (`response.redirected`) to a page
   *   whose `content-type` is not JSON is a refusal with reason
   *   `REDIRECTED_TO_PAGE` and the landing status — `fetch` follows the
   *   `303` to the login page, which answers `200`, and reading that as an
   *   acceptance settled a durable write the server never stored;
   * - a 2xx whose `content-type` is `text/html` answers a JSON request with a
   *   page, reason `PAGE_ANSWER`;
   * - any other 2xx is accepted. Its body is left unread: an accepted body is
   *   the caller's payload, not the executor's.
   *
   * A page answer's body is drained (nothing reads it; an unread body holds
   * its connection open). A 2xx refusal is "malformed" to the durable write
   * it settles (`unreadableAnswer`), exactly as the checked verbs' is.
   */
  export async function classify(response: Response): Promise<Option<Refusal>> {
    if (!response.ok) {
      const error = await parseErrorBody(response);
      return { status: response.status, ...error };
    }
    const contentType = response.headers.get("content-type");
    if (response.redirected && !TypedApi.isJsonContentType(contentType)) {
      await response.text().catch(() => "");
      return {
        status: response.status,
        reason: REDIRECTED_TO_PAGE,
        details: `redirected to ${response.url}, which is not JSON`,
      };
    }
    if (contentType != null && /^\s*text\/html\b/i.test(contentType)) {
      await response.text().catch(() => "");
      return {
        status: response.status,
        reason: PAGE_ANSWER,
        details: `answered with a page (${contentType}), not JSON`,
      };
    }
    return null;
  }

  /**
   * Whether `failure` reports an answer that was not the route's (a 2xx
   * `classify` refused: `REDIRECTED_TO_PAGE`, `PAGE_ANSWER`) — the durable
   * write it settles is "malformed", as a checked verb's
   * `ResponseDecodeError` is: the server answered, and the SDK cannot tell
   * what it did. A non-2xx status is a refusal, `0` no answer.
   */
  export function unreadableAnswer(failure: Failure): boolean {
    return failure.status >= 200 && failure.status < 300;
  }

  /**
   * An executor's record of which handoffs each execution carries. `queue`
   * when a handoff is debounced under `key`; `take` when an execution for
   * `key` starts. The debounce runs only the LAST function queued for a key
   * before it fires, so the ids queued since the previous execution started
   * are exactly the handoffs this execution stands for; a handoff queued
   * after it started lands in the next one.
   *
   * Call `take` synchronously at the start of the executed function: that
   * is the tick `@tento-ui/debounce` hands the execution the completion of
   * the handoffs queued so far, so the ids a refusal names and the handoffs
   * whose promise that execution resolves are the same set. Report a refusal
   * inside the execution, before it returns — every handoff it carried then
   * hears the refusal before its own promise settles.
   */
  export class Coalesced {
    readonly #queued = new Map<string, string[]>();

    queue(key: string, requestId: Option<string>): void {
      if (requestId == null) return;
      const ids = this.#queued.get(key);
      if (ids == null) this.#queued.set(key, [requestId]);
      else ids.push(requestId);
    }

    /** The ids the execution starting now for `key` carries (null: none). */
    take(key: string): Option<readonly string[]> {
      const ids = this.#queued.get(key);
      this.#queued.delete(key);
      return ids ?? null;
    }
  }

  const subscribers = new Set<Handler>();

  /**
   * Hear every reported failure from now on, until the returned unsubscribe
   * runs. Subscribers are independent: adding one never replaces another,
   * and each claims only the failures it recognises.
   */
  export function subscribe(handler: Handler): () => void {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  }

  /** The one subscription `onFailure` manages (see there). */
  let replaceable: Option<() => void> = null;

  /**
   * @deprecated Use `subscribe`, which never replaces another subscriber.
   * Kept for hosts written against the single-dispatcher channel: installs
   * `next` as the ONE subscription this function manages, replacing the
   * previous one it installed — never a `subscribe`r (a client's executor
   * binding keeps hearing every failure). Removed in 0.2.0.
   */
  export function onFailure(next: Handler): void {
    replaceable?.();
    replaceable = subscribe(next);
  }

  /**
   * Report a refused (`classify`), or unanswered (status `0`) debounced
   * request to every
   * subscriber, in subscription order. Traces when nobody subscribes — the
   * service-worker context and non-app pages run the executors without one.
   */
  export function report(failure: Failure): void {
    if (subscribers.size === 0) {
      Tracing.info("net")(
        `debounced-request-failed ${failure.status} ${failure.url}`,
      );
      return;
    }
    for (const handler of [...subscribers]) handler(failure);
  }

  /**
   * Read a non-2xx response's error body.
   *
   * The envelope is not this module's to know. `ResponseError.of` is the one
   * place that reads the shapes on this fleet's wire, and this executor is a
   * second CALLER of it rather than a second COPY of it — the sniffing that
   * used to live here answered `{reason, details}` alone, so a debounced write
   * rejected by a node-registry surface reported no reason at all.
   *
   * The `Option<string>` return is deliberate and is NOT what `ResponseError`
   * carries. `Failure.reason` is documented as the reason "when it parsed",
   * and the lona service worker unions this result with a literal
   * `{reason: null}` on its success path (`sw.root.ts`, `CellWriteResult`), so
   * an absent field has to stay `null` here. `""` would be a third state
   * neither consumer asked for, and this seam has callers outside this repo.
   *
   * A proxy/gateway error or an aborted body is not JSON; those degrade to
   * nulls rather than throwing inside the executor.
   */
  export async function parseErrorBody(
    response: Response,
  ): Promise<{ reason: Option<string>; details: Option<string> }> {
    let body: Option<UntypedJson> = null;
    try {
      body = await response.json();
    } catch (err) {
      Tracing.warn("net")(
        `debounced-request-failed: unparseable error body (${response.status})`,
        String(err),
      );
    }
    const error = ResponseError.of(response.status, body);
    return {
      reason: error.reason.length > 0 ? error.reason : null,
      details: error.details.length > 0 ? error.details : null,
    };
  }
}
