import { GESTURE_MANAGER } from "./gesture-manager";
import { Tracing } from "@tento-core/tracing";
import { FrameMarks } from "./frame-marks";
import { FRAME_BUDGET } from "./frame-budget";

export class Fastdom {
  private reads: EmptyFunction[] = [];
  private writes: EmptyFunction[] = [];
  private writesEnd: EmptyFunction[] = [];
  // Reads deferred to the NEXT flush. `runTasks` drains the live `reads` array
  // with `while(shift())`, so a `measure()` issued from inside the read phase
  // joins the CURRENT frame — correct for measure-after-mutate chaining, wrong
  // for work that is being deferred to *yield the frame* (the bind drain's
  // budget tail). These are moved into `reads` at the top of the next flush.
  private nextReads: EmptyFunction[] = [];
  private flushing: boolean = false;
  private scheduled: boolean = false;
  private flushCount = 0;
  private lastFlushEnd = -1;
  private flushType: Option<Fastdom.FlushType>;
  private instruments: Map<string, number> = new Map();

  // ── Interruptible rendering (mutation-context cancellation) ──────────
  // Each queued task MAY carry a "generation" (a render epoch). At flush a
  // task whose generation is older than `liveGen` is a superseded BUILD
  // mutation (e.g. the sheet you just navigated away from) and is dropped
  // instead of run. Untagged tasks (the default, app-wide) have no entry
  // here and are NEVER skipped — full backward-compat. Tagging is opt-in via
  // `runWithGeneration`; the bind-driving layer advances `liveGen` per render.
  // See projects/scroll-rendering-engine.project.docs → interruptible-rendering.
  private genOf = new WeakMap<EmptyFunction, number>();
  private currentGen: Option<number> = null;
  private liveGen = 0;
  private skippedGenCount = 0;

  constructor() {
    this.reads = [];
    this.writes = [];
    this.writesEnd = [];
    this.flushing = false;

    // Register frame context provider so Tracing entries get phase badges
    Tracing.setFrameContext(() => {
      if (!this.flushing) return null;
      return { count: this.flushCount, phase: this.flushType! };
    });
  }

  runTasks(tasks: EmptyFunction[]) {
    let task: Option<EmptyFunction>;
    while ((task = tasks.shift())) {
      try {
        if (!task) continue;
        // Drop superseded BUILD work: a task tagged with a generation older
        // than the live one belongs to a render that has since been replaced
        // (a faster sheet switch). Untagged tasks have no generation and
        // always run. Teardown must therefore never be enqueued under a
        // generation — see the design doc's teardown-safety table.
        const gen = this.genOf.get(task);
        if (gen != null && gen < this.liveGen) {
          this.skippedGenCount += 1;
          continue;
        }
        task();
      } catch (e) {
        setTimeout(() => {
          // err("ui")("fastdom/Error flushing task: ", task, e);
          console.log(task);
          console.error(e);
          throw e;
        });
      }
    }
  }

  measure(fn: EmptyFunction, ctx?: Option<any>) {
    const task = !ctx ? fn : fn.bind(ctx);
    this.tagGeneration(task);
    this.reads.push(task);
    this.scheduleFlush();
    return task;
  }

  /**
   * Like {@link measure}, but guaranteed to run in the NEXT flush's read phase
   * — never the current one. Outside a flush this is equivalent to `measure`
   * (both land in the upcoming frame). Inside a flush, `measure` joins the
   * frame that is already running (the live `reads` array is still being
   * drained), while `measureNext` yields: the task runs next frame, and any
   * `mutate` it issues lands in THAT frame's write phase, preserving the
   * read→write pairing. This is the primitive a frame-budgeted drain needs to
   * actually spread work across frames.
   */
  measureNext(fn: EmptyFunction, ctx?: Option<any>) {
    const task = !ctx ? fn : fn.bind(ctx);
    this.tagGeneration(task);
    this.nextReads.push(task);
    this.scheduleFlush();
    return task;
  }

  mutate(fn: EmptyFunction, ctx?: Option<any>) {
    const task = !ctx ? fn : fn.bind(ctx);
    this.tagGeneration(task);
    this.writes.push(task);
    this.scheduleFlush();
    return task;
  }

  mutateEnd(fn: EmptyFunction, ctx?: Option<any>) {
    const task = !ctx ? fn : fn.bind(ctx);
    this.tagGeneration(task);
    this.writesEnd.push(task);
    this.scheduleFlush();
    return task;
  }

  /** Stamp a task with the ambient generation (if any) at enqueue time. */
  private tagGeneration(task: EmptyFunction) {
    if (this.currentGen != null) this.genOf.set(task, this.currentGen);
  }

  /**
   * Run `fn` with `gen` as the ambient generation: every `mutate`/`measure`/
   * `mutateEnd` (and `@mutate`-style decorators) enqueued synchronously inside
   * `fn` is stamped with `gen`. Save/restore so calls nest. NOTE: the ambient
   * is only correct SYNCHRONOUSLY — it does NOT survive `await`s or
   * frame-deferred continuations (another render may move it). Wrap only
   * synchronous build scopes; cross-frame work (the bind drain) carries its
   * generation explicitly on the batch instruction instead.
   */
  runWithGeneration<T>(gen: number, fn: () => T): T {
    const prev = this.currentGen;
    this.currentGen = gen;
    try {
      return fn();
    } finally {
      this.currentGen = prev;
    }
  }

  /**
   * Advance the live render epoch. Tasks tagged with a generation `< n` become
   * superseded build work and are dropped at flush. Monotonic — a lower value
   * is ignored so a stale caller can't resurrect cancelled work.
   */
  setLiveGeneration(n: number): void {
    if (n > this.liveGen) this.liveGen = n;
  }

  /** Diagnostics: how many superseded tasks have been dropped at flush. */
  get droppedGenerationTasks(): number {
    return this.skippedGenCount;
  }

  // One shared macrotask drains all deferred work instead of one setTimeout
  // per defer() call — recycle-heavy scroll frames installed over a hundred
  // timers a second, and the install/clear overhead itself showed in
  // profiles. FIFO order is preserved; a throwing task is re-thrown on its
  // own macrotask so it can't swallow the rest of the batch.
  private deferredTasks: EmptyFunction[] = [];
  private deferredTimer: Option<ReturnType<typeof setTimeout>> = null;

  private scheduleDeferred(fn: EmptyFunction) {
    this.deferredTasks.push(fn);
    if (this.deferredTimer != null) return;
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null;
      const tasks = this.deferredTasks;
      this.deferredTasks = [];
      for (const task of tasks) {
        try {
          task();
        } catch (e) {
          setTimeout(() => {
            throw e;
          });
        }
      }
    });
  }

  defer(fn: EmptyFunction) {
    this.mutateEnd(() => this.scheduleDeferred(fn));
  }

  deferMutate(fn: EmptyFunction) {
    const mut = this.mutate.bind(this);
    this.mutateEnd(() => this.scheduleDeferred(() => mut(fn)));
  }

  clear(task: EmptyFunction) {
    return (
      this.remove(this.reads, task) ||
      this.remove(this.nextReads, task) ||
      this.remove(this.writes, task) ||
      this.remove(this.writesEnd, task)
    );
  }

  isFlushing() {
    return this.flushing;
  }

  /**
   * The running flush's number, or between flushes the number the next flush
   * will carry. Between flushes this is NOT the browser frame the work lands
   * in: a microtask queued during flush N (a promise continuation) runs after
   * `flush()` returns but inside frame N's rAF task. Diagnostics key such work
   * by `lastFlushEndTime()` / timestamps instead.
   */
  frameNumber(): number {
    return this.flushCount;
  }

  /** When the last completed flush ended (`performance.now()`), or -1 before the first. */
  lastFlushEndTime(): number {
    return this.lastFlushEnd;
  }

  /** The running flush's phase; null between flushes. */
  currentPhase(): Option<Fastdom.FlushType> {
    return this.flushing ? (this.flushType ?? null) : null;
  }

  raf(fn: EmptyFunction) {
    return window.requestAnimationFrame(fn);
  }

  /**
   * Schedules a new read/write
   * batch if one isn't pending.
   *
   * @private
   */
  private scheduleFlush() {
    if (this.scheduled) return;
    this.scheduled = true;
    // A hidden document gets no rendering opportunities, so `requestAnimationFrame`
    // never fires and this queue never drains: a page built in a background tab or
    // in an iframe the shell has not shown stays half-constructed for as long as it
    // stays hidden. Observed on the ux-tests console — `flushCount: 0` with 31
    // writes queued, a std-table showing its column header over no rows at all.
    //
    // Nothing needs to be frame-aligned in that state, because there is no frame to
    // align to; a timer still runs (throttled to ~1/s, which costs nobody anything
    // when no one is looking) and drains the same queue in the same order. The
    // rAF path is untouched whenever a frame IS coming, which is every visible
    // document, so the batching this class exists for is unchanged.
    //
    // `document` is guarded rather than assumed: fastdom's own tests stub
    // `window.requestAnimationFrame` in Deno and define no document, and they must
    // keep driving the queue through their own rafQueue.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      setTimeout(this.flush.bind(this));
      return;
    }
    this.raf(this.flush.bind(this));
  }

  /**
   * Runs queued `read` and `write` tasks.
   *
   * Errors are caught and thrown by default.
   * If a `.catch` function has been defined
   * it is called instead.
   *
   * @private
   */
  private flush() {
    // One flush is one frame of the shared script budget (frame-budget.ts).
    FRAME_BUDGET.open(this.flushCount);
    // Promote next-frame reads into this flush's read phase (see measureNext).
    // Done before the phases run, so a task deferred during frame N's read
    // phase executes in frame N+1's read phase, ahead of that frame's writes.
    if (this.nextReads.length > 0) {
      this.reads.push(...this.nextReads);
      this.nextReads.length = 0;
    }
    let writes = this.writes;
    let writesEnd = this.writesEnd;
    let reads = this.reads;
    let error: Option<any>;

    this.flushing = true;

    if (this.flushCount > 0 && this.flushCount % 60 === 0) {
      GESTURE_MANAGER.cleanupStaleCallbacks();
    }

    Tracing.flushStart(this.flushCount);

    if (this.instruments.size > 0) {
      for (const [k, v] of this.instruments.entries()) {
        if (v <= 1) {
          this.instruments.delete(k);
        } else {
          this.instruments.set(k, v - 1);
        }
      }
    }

    // 1) Read
    const readId = this.flushCount;
    // Preserve phase measures without allocating temporary PerformanceMarks
    // on every frame. Numeric boundaries also avoid mark lookups and cleanup.
    const readStart = performance.now();
    // console.log(`[${readId}] read`);

    // Tracing.dev("FLUSHING", this.getState());
    // for (const fn of this.reads) {
    //   Tracing.dev(">> read    ", fn);
    // }
    // for (const fn of this.writes) {
    //   Tracing.dev(">> write   ", fn);
    // }
    // for (const fn of this.writesEnd) {
    //   Tracing.dev(">> writeEnd", fn);
    // }

    // 1a) Run
    this.flushType = "reads";
    const readsMark = FrameMarks.begin();
    const readTasks = reads.length;
    this.runTasks(reads);
    FrameMarks.end("fastdom.reads", readsMark, readTasks, 0);

    // 2) Write
    const writeId = this.flushCount;
    const writeStart = performance.now();
    performance.measure(
      `[${readId}] read`,
      { start: readStart, end: writeStart },
    );
    performance.clearMeasures(`[${readId}] read`);
    // console.log(`[${writeId}] write`);

    // 2a) Run
    this.flushType = "writes";
    const writesMark = FrameMarks.begin();
    const writeTasks = writes.length;
    this.runTasks(writes);
    FrameMarks.end("fastdom.writes", writesMark, writeTasks, 0);

    // 3) WriteEnd
    const writeEndId = this.flushCount;
    const writeEndStart = performance.now();
    performance.measure(
      `[${writeEndId}] write`,
      { start: writeStart, end: writeEndStart },
    );
    performance.clearMeasures(`[${writeEndId}] write`);
    // console.log(`[${writeEndId}] writeEnd`);

    // 3a) Run
    this.flushType = "writes-end";
    const writesEndMark = FrameMarks.begin();
    const writeEndTasks = writesEnd.length;
    this.runTasks(writesEnd);
    FrameMarks.end("fastdom.writes-end", writesEndMark, writeEndTasks, 0);

    performance.measure(
      `[${writeEndId}] write-end`,
      { start: writeEndStart, end: performance.now() },
    );
    performance.clearMeasures(`[${writeEndId}] write-end`);

    this.flushType = null;
    this.lastFlushEnd = performance.now();
    this.flushCount += 1;
    this.flushing = false;
    this.scheduled = false;

    // If the batch errored we may still have tasks queued
    if (reads.length || writes.length || writesEnd.length || this.nextReads.length) {
      this.scheduleFlush();
    }

    Tracing.flushEnd();
    if (error) {
      console.error("error running batches", error);
      throw error;
    }
  }

  /**
   * Remove an item from an Array.
   *
   * @param  {Array} array
   * @param  {*} item
   * @return {Boolean}
   */
  remove<T>(array: T[], item: T): boolean {
    const index = array.indexOf(item);
    return !!~index && !!array.splice(index, 1);
  }

  getId(): string {
    return `${this.flushType}/${this.flushCount}`;
  }

  getState(): {
    // flushing: boolean;
    flushCount: number;
    // flushType: Option<string>;
  } {
    return {
      // flushing: this.flushing,
      flushCount: this.flushCount,
      // flushType: this.flushType,
    };
  }

  assertFlushType(type: Option<Fastdom.FlushType>) {
    if (this.flushType === type) return;
    Tracing.warn("ui")(
      `raf/flush-type mismatch, expected=${type}, got=${this.flushType}`,
    );
    console.trace();
  }

  startInstrumentation(id: string, cycles: number = 5) {
    this.instruments.set(id, cycles);
  }
}

export namespace Fastdom {
  export type FlushType = "reads" | "writes" | "writes-end";
}

export const $$ = new Fastdom();

export function mutate(
  _target: Object,
  _propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<any>,
): TypedPropertyDescriptor<any> {
  const method = descriptor.value!;
  descriptor.value = function (...args: any[]) {
    $$.mutate(() => {
      method.apply(this, args);
    });
  };
  return descriptor;
}

export function mutateEnd(
  _target: Object,
  _propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<any>,
): TypedPropertyDescriptor<any> {
  const method = descriptor.value!;
  descriptor.value = function (...args: any[]) {
    $$.mutateEnd(() => {
      method.apply(this, args);
    });
  };
  return descriptor;
}

export function measure(
  _target: Object,
  _propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<any>,
): TypedPropertyDescriptor<any> {
  const method = descriptor.value!;
  descriptor.value = function (...args: any[]) {
    $$.measure(() => {
      method.apply(this, args);
    });
  };
  return descriptor;
}
