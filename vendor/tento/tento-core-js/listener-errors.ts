/**
 * One reporter for every subscriber fan-out: a listener is a subscriber,
 * never part of the transaction that notified it (a fetch commit, a bulk
 * install, a write, a sync-state change, a store `set`).
 *
 * A fan-out runs every listener even when an earlier one throws, collects
 * what they threw (`ListenerErrors.fanOut`), lets the producer finish, and
 * then hands the errors to its host's sink (`ListenerErrors.report`): the
 * one value as thrown, several as one `AggregateError` in listener order.
 * The producer's own callers never see a subscriber's error as their
 * failure.
 *
 * The sink is the host's decision. `ListenerErrors.RETHROW` — the default
 * for a host that names none — raises the error as the host's uncaught
 * error on the next microtask, as an `EventTarget` listener's is: the
 * browser reports it and continues; a Deno process with no global `error`
 * listener exits. A host that must stay alive (a terminal UI) passes a sink
 * that records the error instead.
 *
 * @module
 */

/** Whatever a listener threw, kept as thrown (the type a rejection reason has). */
export type Thrown = Parameters<NonNullable<Parameters<Promise<void>["then"]>[1]>>[0];

/** Where a fan-out's listener errors go once every listener has run. */
export type ListenerErrorSink = (error: Thrown) => void;

/** The fan-out runner and reporter (`fanOut`, `report`) and the default sink (`RETHROW`). */
export namespace ListenerErrors {
  /**
   * The default sink: raise `error` as the host's uncaught error on the
   * next microtask (never into the caller).
   */
  export const RETHROW: ListenerErrorSink = (error) => {
    queueMicrotask(() => {
      throw error;
    });
  };

  /**
   * Call `notify` for each of `listeners` — a snapshot the caller took when
   * the fan-out started — skipping one `stillListening` says has left since.
   * A throwing listener does not stop the others: what each threw is
   * appended to `errors` (returned) in listener order.
   */
  export function fanOut<L>(
    listeners: Iterable<L>,
    stillListening: (listener: L) => boolean,
    notify: (listener: L) => void,
    errors: Thrown[] = [],
  ): Thrown[] {
    for (const listener of listeners) {
      if (!stillListening(listener)) continue;
      try {
        notify(listener);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  /**
   * Run one callback `run` as a subscriber: what it throws is appended to
   * `errors` instead of propagating.
   */
  export function isolate(errors: Thrown[], run: () => void): void {
    try {
      run();
    } catch (error) {
      errors.push(error);
    }
  }

  /**
   * Hand what a fan-out's listeners threw to `sink`, once: nothing when
   * nothing threw, the one value as thrown, several as one `AggregateError`
   * (message names `source`) in listener order. A sink that itself throws
   * is not the producer's failure either: its error is raised as `RETHROW`
   * would.
   */
  export function report(sink: ListenerErrorSink, errors: readonly Thrown[], source: string): void {
    if (errors.length === 0) return;
    const raised = errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `${source}: ${errors.length} listeners threw`);
    try {
      sink(raised);
    } catch (sinkError) {
      RETHROW(sinkError);
    }
  }
}
