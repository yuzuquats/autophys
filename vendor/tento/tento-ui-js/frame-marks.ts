import { $$ } from "./fastdom";
import { DomFlags } from "./dom-flags";
import { Tracing } from "@tento-core/tracing";

/**
 * Per-frame attribution marks for the calendar render path.
 *
 * Each mark is a `performance.measure` named `lona:<cause>` whose `detail`
 * says when and inside what it ran:
 *
 * - `frame`: the fastdom flush running it, or `null` between flushes;
 *   `phase`: that flush's phase, or `"between"`.
 * - `afterFlush` / `afterFlushEnd`: the last completed flush and when it
 *   ended. Work between flushes is NOT keyed to a flush number: a promise
 *   continuation queued during flush N runs right after `flush()` returns,
 *   still inside browser frame N's rAF task, while a continuation of a network
 *   response runs in its own task. Attribute "between" work to a browser frame
 *   by its own timestamps (the measure's `startTime`) against the frame
 *   windows (long-animation-frame entries); `afterFlush` / `afterFlushEnd`
 *   say which flush it followed and how long after.
 * - `depth` / `self`: marks nest (a strip's read inside its bind-sync, the
 *   binder's prepare inside its on-bind). `depth` is the number of enclosing
 *   open marks and `self` is the duration minus the enclosed marks'
 *   durations, so summing `self` per cause is exclusive; summing `duration`
 *   double-counts nested causes.
 * - `a`, `b`: two per-cause counts (see `Cause`).
 * - `col`: the scroll column (engine index = column offset) the mark worked
 *   for, where the caller knows it (`column.wait`, `binder.on-bind`,
 *   `day-column.*`, `strip.bind-sync` / `strip.unit` / `strip.reveal`), else
 *   `null`. Marks nested inside one of those belong to its column. Lets a
 *   trace follow one fresh column from its enqueue through its bind, cell
 *   content and strip units to its reveal.
 * - `fixed.unit` and `emit.rendered-pass` name the two
 *   consumers of a motion frame's content deadline that ran unmarked before:
 *   each fixed-children unit, and the rendered emit's per-row pass.
 * - `sheet.effect/<id>` names each sheet invalidation effect
 *   the app's effect executor runs, by its effect id.
 * - `rebind.column` / `rebind.timepoints` split a content
 *   effect into its rebind-handle calls (the `cell-content-column` arm runs
 *   one per column plus one per timed span), so a trace says which half of
 *   the effect costs.
 * - `StripWait` is not a measure: per fresh calendar column,
 *   its full bind's enqueue to its first strip unit, with the reason each
 *   frame in between ran no unit of it (see `StripWait`).
 * - `strip.paint.bind` / `.content` / `.gesture` split a
 *   layer's paint into its per-cell phases, each summed over the layer's
 *   cells (`Phases`); `strip.rough` is a strip's rough-box unit.
 *
 * Latency marks (`stamp` / `latency`, e.g. `day-column.wait`) span awaits:
 * they are wall time, not script time, carry `depth: -1` and `self: 0`, and
 * never enclose or are enclosed by other marks.
 *
 * Off by default. Turned on for a page load by `?flag:frame-marks=true`, or
 * persistently by localStorage `debug-flag:frame-marks=true` (the debug-flag
 * convention of `Flags.Debug` / `DomUtils.timingMarksEnabled`), or by
 * `FrameMarks.setEnabled` (tests, harnesses). Disabled, `begin` / `stamp` are
 * one boolean check returning `NaN` and `end` / `latency` one `NaN` check: no
 * allocation, no `performance` call. Enabled, at most `LIMIT` measures are
 * recorded per page.
 */
export namespace FrameMarks {
  /** What a measure attributes its time to. */
  export type Cause =
    /**
     * Latency: a column's full bind enqueued (it entered the rendered range,
     * or its content was invalidated) to the start of that bind in a drain;
     * counts: column index, 0.
     */
    | "column.wait"
    /** The whole `DefaultBinder.onBind` (encloses prepare and apply-cells); counts: column offset, 0. */
    | "binder.on-bind"
    /** `prepareColumnCommit` in `DefaultBinder.onBind`; counts: rows, 0. */
    | "binder.prepare"
    /** `applyCells` in `DefaultBinder.onBind`; counts: rows, 0. */
    | "binder.apply-cells"
    /** Latency: `DayColumnRenderer` bind start to `$column.bind` (awaits included); counts: subcolumns, 0. */
    | "day-column.wait"
    /** The synchronous `$column.bind` call; counts: subcolumns, 0. */
    | "day-column.bind"
    /**
     * `CalendarDaysStrip` synchronous bind: all days (encloses read, spans,
     * occlusion, paint) on the unqueued path; only the structure (day elements,
     * listener) when days run as queued units; counts: days, subcolumns.
     */
    | "strip.bind-sync"
    /** One queued strip unit: one day's read, spans, occlusion and paint (encloses them); counts: day index, subcolumns. */
    | "strip.unit"
    /** One provider's calendar read for a day fragment; counts: events read (0 when served by the bind's earlier read), events kept. */
    | "strip.read"
    /** Span construction for those events; counts: spans, 0. */
    | "strip.spans"
    /** The occlusion read for a day fragment; counts: events read (0 when served by the span read), events kept. */
    | "strip.occlusion"
    /** One span layer's paint (encloses its layout-group.apply when synchronous); counts: cells created, cells reused. */
    | "strip.paint"
    /**
     * Inside one `strip.paint`, summed over its cells
     * (`FrameMarks.Phases`): `bind` takes, places and styles each cell,
     * `content` binds its chip (title, colour, time label), `gesture`
     * registers its pointer callbacks; counts: cells, 0.
     */
    | "strip.paint.bind"
    | "strip.paint.content"
    | "strip.paint.gesture"
    /** A strip's rough-box unit (`calendar-rough-layer`): read ahead, lanes, one layer write; counts: boxes, days. */
    | "strip.rough"
    /** The strip's reveal write (after all its layers settled); counts: 0, 0. */
    | "strip.reveal"
    /** `CalendarColumnLayoutGroup`'s lane-apply mutate; counts: cells written, cells checked. */
    | "layout-group.apply"
    /**
     * One budgeted per-row unit of `FixedChildrenQueue` (a row's
     * visible-columns hook, fixed-children re-cull or completion); counts:
     * the row's distance from the row viewport (px, 0 = in it), units still
     * queued.
     */
    | "fixed.unit"
    /**
     * The rendered emit's per-row plugin pass (`renderedPass`: each row's
     * rendered-columns hook and fixed-children kickoff, synchronous part);
     * counts: rows handed to the pass, rows it ran for.
     */
    | "emit.rendered-pass"
    /**
     * One row's part of that pass, inside `emit.rendered-pass`:
     * its rendered-columns hook, or one of its fixed-children kickoffs;
     * counts: the row's place in the pass, the part (0 the hook, 1 a
     * kickoff).
     */
    | "emit.rendered-row"
    /**
     * One fixed-children kickoff: the rendered pass's synchronous call into a
     * plugin's `fixedChildrenForRow` for the whole rendered range; counts: -1
     * and 1 (kept from the removed per-part kickoff, so the perf tools still
     * read it as whole); col: the columns asked.
     */
    | "fixed.kickoff"
    /**
     * A whole fastdom phase (the outermost marks of a frame's script: every
     * mark above runs inside one); counts: tasks queued when the phase
     * started, 0. Their `self` is script in the phase that no finer mark
     * covers.
     */
    | "fastdom.reads"
    | "fastdom.writes"
    | "fastdom.writes-end"
    /** The scroll engine's bind drain (inside `fastdom.reads`); counts: 0, 0. */
    | "scroll.drain"
    /** The scroller's `scroll` event handler (runs outside fastdom, before the frame's rAF); counts: 0, 0. */
    | "scroll.event"
    /** A programmatic scroll position write (`adjustContentOffset` / reach clamp): forces layout when styles are dirty; counts: 0, 0. */
    | "scroll.adjust"
    /**
     * One sheet invalidation effect dispatched by the app's effect executor
     * (lona `wireSheetInvalidation`), named by its effect id; counts: the
     * sources the frame folded into it, the rows its scope names (-1 when the
     * effect is not row-scoped).
     */
    | `sheet.effect/${string}`
    /** The rebind handle's `rebindInvalidatedColumn` (encloses the scroll engine's column rebind); counts: 1, 0. */
    | "rebind.column"
    /**
     * The rebind handle's `rebindInvalidatedTimepoints`: the rendered columns'
     * range search and their rebinds; counts: rendered columns searched,
     * columns rebound.
     */
    | "rebind.timepoints";

  /** What a recorded measure's `detail` holds. */
  export type Detail = {
    readonly frame: Option<number>;
    readonly phase: "reads" | "writes" | "writes-end" | "between";
    readonly afterFlush: number;
    readonly afterFlushEnd: number;
    readonly depth: number;
    readonly self: number;
    readonly a: number;
    readonly b: number;
    readonly col: Option<number>;
  };

  /** The prefix of every measure name. */
  export const PREFIX = "lona:";
  /** The most measures one page records; later marks are dropped. */
  export const LIMIT = 100_000;

  const FLAG = "frame-marks";
  let on: boolean = DomFlags.read(FLAG, false);
  let recorded = 0;
  // The open (begun, not yet ended) marks, innermost last: their starts and
  // the time their already-ended children took. Reused, never reallocated.
  const openStarts: number[] = [];
  const openChildren: number[] = [];


  /** Whether marks are recorded. */
  export function enabled(): boolean {
    return on;
  }

  /** Turn recording on or off for this page (tests and harnesses). */
  export function setEnabled(value: boolean): void {
    on = value;
    openStarts.length = 0;
    openChildren.length = 0;
    StripWait.reset();
  }

  /** How many measures this page recorded (at most `LIMIT`). */
  export function recordedCount(): number {
    return recorded;
  }

  /** The start of a measured (script) span: a timestamp, or `NaN` while disabled. */
  export function begin(): number {
    if (!on) return NaN;
    const start = performance.now();
    openStarts.push(start);
    openChildren.push(0);
    return start;
  }

  /**
   * Record `cause` from `start` (a `begin()` value) to now. A `NaN` start
   * (disabled at `begin`) records nothing. A mark left open by a throw is
   * closed here by the first enclosing mark that ends.
   */
  export function end(cause: Cause, start: number, a: number, b: number, col: number = NaN): void {
    if (Number.isNaN(start)) return;
    const now = performance.now();
    const duration = now - start;
    let index = openStarts.length - 1;
    while (index >= 0 && openStarts[index] !== start) index--;
    const children = index >= 0 ? openChildren[index] : 0;
    if (index >= 0) {
      openStarts.length = index;
      openChildren.length = index;
      if (index > 0) openChildren[index - 1] += duration;
    }
    record(cause, start, now, Math.max(index, 0), duration - children, a, b, col);
  }

  /** The start of a latency span (one that spans awaits): a timestamp, or `NaN` while disabled. */
  export function stamp(): number {
    return on ? performance.now() : NaN;
  }

  /** Record the latency `cause` from `start` (a `stamp()` value) to now. */
  export function latency(cause: Cause, start: number, a: number, b: number, col: number = NaN): void {
    if (Number.isNaN(start)) return;
    record(cause, start, performance.now(), -1, 0, a, b, col);
  }

  /**
   * Record `cause` as `ms` of script time that ended now, spent in many short
   * spans inside the innermost open mark (a summed phase of a loop): it nests
   * there, and that mark's `self` excludes it. Nothing while disabled.
   */
  export function spent(cause: Cause, ms: number, a: number, b: number, col: number = NaN): void {
    if (!on) return;
    const now = performance.now();
    const depth = openStarts.length;
    if (depth > 0) openChildren[depth - 1] += ms;
    record(cause, now - ms, now, depth, ms, a, b, col);
  }

  /**
   * Summed phases of a loop (a layer paint's per-cell bind, content and
   * gesture work): `begin` before an item, `split(i)` after each
   * phase of it adds the time since the last split to phase `i`, and `flush`
   * records each phase that ran once as one `spent` mark (counts: items,
   * `b`) and starts over. Disabled, every call is one boolean check.
   */
  export class Phases {
    readonly #ms: number[];
    readonly #items: number[];
    #last = NaN;

    constructor(readonly causes: readonly Cause[]) {
      this.#ms = causes.map(() => 0);
      this.#items = causes.map(() => 0);
    }

    /** Start timing one item. */
    begin(): void {
      if (on) this.#last = performance.now();
    }

    /** Add the time since the last `begin` or `split` to phase `index`. */
    split(index: number): void {
      if (!on || Number.isNaN(this.#last)) return;
      const now = performance.now();
      this.#ms[index] = (this.#ms[index] ?? 0) + now - this.#last;
      this.#items[index] = (this.#items[index] ?? 0) + 1;
      this.#last = now;
    }

    /** Record each phase that ran as one mark nested in the open mark, and start over. */
    flush(b: number): void {
      if (on) {
        this.causes.forEach((cause, index) => {
          const items = this.#items[index] ?? 0;
          if (items > 0) spent(cause, this.#ms[index] ?? 0, items, b);
        });
      }
      this.#ms.fill(0);
      this.#items.fill(0);
      this.#last = NaN;
    }
  }

  function record(
    cause: Cause,
    start: number,
    end: number,
    depth: number,
    self: number,
    a: number,
    b: number,
    col: number,
  ): void {
    if (!on) return;
    if (StripWait.watches(cause)) StripWait.observe(cause, start, end, col);
    if (recorded >= LIMIT) return;
    recorded++;
    const phase = $$.currentPhase();
    const frame = $$.frameNumber();
    const detail: Detail = {
      frame: phase == null ? null : frame,
      phase: phase ?? "between",
      afterFlush: frame - 1,
      afterFlushEnd: $$.lastFlushEndTime(),
      depth,
      self,
      a,
      b,
      col: Number.isNaN(col) ? null : col,
    };
    performance.measure(PREFIX + cause, { start, end, detail });
  }

  /**
   * Why a fresh calendar column's events start late: per fresh
   * column, its full bind's enqueue to its first strip unit, with the reason
   * each frame in between ran no unit of its strip. Only while marks are on.
   *
   * Fed by the scroll engine that runs a content deadline (the calendar's
   * horizontal engine: `enqueued` when a column's full bind is first queued,
   * `drained` once per drain with what it deferred and whether it took the
   * frame's unconditional unit) and by the marks above: `column.wait` (the
   * bind ran), `strip.bind-sync` (its strip's units are queued), `strip.unit`
   * (a unit ran) and `fixed.unit` (the fixed-children queue ran a unit). A
   * column counts once per page, from its first full bind; a frame in which
   * neither the engine drained nor any unit ran is not listed.
   *
   * A finished column is one `frame-marks/strip-wait` trace log (and kept for
   * `records()`); a column still waiting 600 frames after its enqueue is
   * logged with `firstUnitAt: null`.
   */
  export namespace StripWait {
    /**
     * Why a waiting column's strip ran no unit in a frame (the first that
     * holds): its full bind was deferred by the engine (`deferredBy`), or not
     * yet reached; it was bound but its strip's units are not yet queued (the
     * day column still awaits its content); strip units ran, for other
     * columns (nearer or started strips
     * rank first); or no strip unit ran at all: the frame's unconditional
     * unit went to `firstUnitBy` and the deadline left no room.
     */
    export type Reason = "bind-deferred" | "bind-queued" | "content-wait" | "outranked" | "deadline";
    /** Why the engine kept a full bind queued: the deadline. */
    export type Deferral = "deadline";
    /** Who ran the frame's unconditional first unit: the engine's bind drain, the fixed-children queue, or a strip. */
    export type FirstUnit = "bind" | "fixed" | "strip";
    /** One frame a column waited through. `inMotion` is null when the engine did not drain that frame. */
    export type Frame = {
      readonly frame: number;
      readonly inMotion: Option<boolean>;
      readonly reason: Reason;
      readonly deferredBy: Option<Deferral>;
      readonly firstUnitBy: Option<FirstUnit>;
      /** Strip units that ran this frame (for other columns). */
      readonly stripUnits: number;
    };
    /** One fresh column: times are `performance.now()` ms; null when it never got there. */
    export type Record = {
      readonly col: number;
      readonly enqueuedAt: number;
      readonly boundAt: Option<number>;
      readonly stripAt: Option<number>;
      readonly firstUnitAt: Option<number>;
      readonly frames: readonly Frame[];
    };

    /** How many frames a column may wait before it is logged unfinished. */
    export const ABANDON_FRAMES = 600;
    /** The most records kept for `records()`. */
    export const RECORDS = 1000;

    type Waiting = { col: number; firstFrame: number; enqueuedAt: number; boundAt: Option<number>; stripAt: Option<number>; frames: Frame[] };
    const waiting = new Map<number, Waiting>();
    const seen = new Set<number>();
    const done: Record[] = [];
    let frame = -1;
    let inMotion: Option<boolean> = null;
    let firstUnitBy: Option<FirstUnit> = null;
    let stripUnits = 0;
    const deferred = new Map<number, Deferral>();

    /** The finished (and abandoned) columns, oldest first. */
    export function records(): readonly Record[] {
      return done;
    }

    /** The columns still waiting for their first strip unit (`firstUnitAt` null), frames closed so far. */
    export function pending(): readonly Record[] {
      return [...waiting.values()].map((column) => ({
        col: column.col,
        enqueuedAt: column.enqueuedAt,
        boundAt: column.boundAt,
        stripAt: column.stripAt,
        firstUnitAt: null,
        frames: [...column.frames],
      }));
    }

    /** Forget every column and frame (with `setEnabled`). */
    export function reset(): void {
      waiting.clear();
      seen.clear();
      done.length = 0;
      frame = -1;
      inMotion = null;
      firstUnitBy = null;
      stripUnits = 0;
      deferred.clear();
    }

    /** The engine queued column `col`'s full bind at `at`; only its first counts. */
    export function enqueued(col: number, at: number): void {
      if (!on) return;
      roll($$.frameNumber());
      if (seen.has(col)) return;
      seen.add(col);
      waiting.set(col, { col, firstFrame: frame, enqueuedAt: at, boundAt: null, stripAt: null, frames: [] });
    }

    /**
     * The engine drained in frame `at`: whether the page moves, whether it ran
     * the frame's unconditional unit, and the full binds it kept queued and
     * why.
     */
    export function drained(
      at: number,
      moving: boolean,
      tookFirstUnit: boolean,
      kept: Iterable<readonly [col: number, why: Deferral]>,
    ): void {
      if (!on) return;
      roll(at);
      inMotion = moving;
      if (tookFirstUnit && firstUnitBy == null) firstUnitBy = "bind";
      for (const [col, why] of kept) if (waiting.has(col)) deferred.set(col, why);
    }

    /** Whether `cause` is a mark this trace reads. */
    export function watches(cause: Cause): boolean {
      return waiting.size > 0 && (cause === "column.wait" || cause === "strip.bind-sync" || cause === "strip.unit" || cause === "fixed.unit");
    }

    /** A watched mark was recorded for column `col` from `start` to `end`. */
    export function observe(cause: Cause, start: number, end: number, col: number): void {
      if (cause === "fixed.unit") {
        roll($$.frameNumber());
        if (firstUnitBy == null) firstUnitBy = "fixed";
        return;
      }
      const column = waiting.get(col);
      if (cause === "column.wait") {
        if (column != null && column.boundAt == null) column.boundAt = end;
        return;
      }
      if (cause === "strip.bind-sync") {
        if (column != null && column.stripAt == null) column.stripAt = end;
        return;
      }
      roll($$.frameNumber());
      if (firstUnitBy == null) firstUnitBy = "strip";
      stripUnits++;
      if (column != null) finish(column, start);
    }

    function finish(column: Waiting, firstUnitAt: Option<number>): void {
      waiting.delete(column.col);
      const record: Record = {
        col: column.col,
        enqueuedAt: column.enqueuedAt,
        boundAt: column.boundAt,
        stripAt: column.stripAt,
        firstUnitAt,
        frames: column.frames,
      };
      if (done.length < RECORDS) done.push(record);
      Tracing.log("frame-marks/strip-wait", record);
    }

    /** Close the current frame when `next` is a later one: each waiting column gets that frame's reason. */
    function roll(next: number): void {
      if (next === frame) return;
      if (frame >= 0) {
        for (const column of [...waiting.values()]) {
          const why = deferred.get(column.col) ?? null;
          const reason: Reason = why != null
            ? "bind-deferred"
            : column.boundAt == null
            ? "bind-queued"
            : column.stripAt == null
            ? "content-wait"
            : stripUnits > 0
            ? "outranked"
            : "deadline";
          column.frames.push({ frame, inMotion, reason, deferredBy: why, firstUnitBy, stripUnits });
          if (frame - column.firstFrame >= ABANDON_FRAMES) finish(column, null);
        }
      }
      frame = next;
      inMotion = null;
      firstUnitBy = null;
      stripUnits = 0;
      deferred.clear();
    }
  }
}
