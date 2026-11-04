import { DateTime, DateUnit, Utc } from "@tento-chrono";
import { Tracing } from "./tracing";

export class RangeBasedFetcher<Tz extends string = Utc> {
  /**
   * The coverage claim consumers read: what has been fetched plus what is in
   * flight (optimistic, so a scroll that extends an in-flight window is not
   * requested twice). Two records back it — `_committed`, the union of
   * fetches that actually delivered (and of explicit assignments), and the
   * in-flight entries — so that when a fetch rejects the claim is recomputed
   * from those rather than restored from a snapshot that may itself have
   * contained another request's optimism. Assigning the field (`= null` to
   * invalidate, `= range` after an install elsewhere) sets both records.
   */
  get fetchedRange(): Option<DateTime.Range<Tz>> {
    return this._claim;
  }

  /** Delivered coverage only; use when recording settled data in another owner. */
  get installedRange(): Option<DateTime.Range<Tz>> {
    return this._committed;
  }

  set fetchedRange(value: Option<DateTime.Range<Tz>>) {
    this._committed = value;
    this._claim = value;
    // An explicit assignment is authoritative: every fetch that started before
    // it belongs to an older epoch and may neither commit nor re-claim on
    // completion. New demands cannot coalesce onto these obsolete entries.
    this._epoch++;
  }

  /**
   * Record data actually installed by a caller. Only delivered coverage joins
   * this range: reading the optimistic getter and assigning its union would
   * accidentally turn every pending request into committed data. Installs do
   * not invalidate other requests. Returns whether committed coverage changed.
   */
  noteInstalled(range: DateTime.Range<Tz>): boolean {
    const before = this._committed;
    const next = before == null ? range : RangeBasedFetcher._join(before, range);
    if (before != null && before.start.mse === next.start.mse && before.end.mse === next.end.mse) return false;
    this._committed = next;
    this._claim = this._recomputeClaim();
    return true;
  }
  private _claim: Option<DateTime.Range<Tz>> = null;
  private _committed: Option<DateTime.Range<Tz>> = null;
  private _epoch = 0;
  private ongoingFetches: Set<{
    range: DateTime.Range<Tz>;
    fetch: Promise<void>;
    coverage: RangeBasedFetcher.Coverage;
    epoch: number;
  }> = new Set();

  /**
   * True while at least one fetch is in flight. `fetchedRange` is
   * extended optimistically at fetch START (`createFetchEntry`), so it
   * cannot answer "has the server actually responded?" — callers that
   * need settled-vs-pending coverage (e.g. loading shimmers) pair a
   * coverage check with this (see `RowHandle.isFetchPending`).
   */
  get hasOngoingFetches(): boolean {
    return this.ongoingFetches.size > 0;
  }

  constructor(
    readonly fetcher: (range: DateTime.Range<Tz>) => Promise<void>,
    readonly shouldLog = false,
  ) {}

  /** The current claim already joins committed and current-epoch in-flight data. */
  private _effectiveRange(): Option<DateTime.Range<Tz>> {
    return this._claim;
  }

  /**
   * How far past the cached window a request may sit and still count as a
   * CONTINUATION of it, measured in multiples of the fetch that request would
   * cost on its own (`range` plus `padding` at both ends).
   *
   * The gap-fill in `fetchRange` (Case 1 / Case 2) exists for SCROLLING. A
   * scroll that steps off the edge of the padded cache leaves a gap no wider
   * than a viewport, and filling it buys one honest contiguous `fetchedRange`
   * for the price of the tail the scroll uncovered. A JUMP is a different
   * gesture with the same shape: a scrollbar jammed to the end of the strip, a
   * `goToDate` into another decade, a view switch that re-anchors. Filling a
   * jump's gap fetches every day between here and there — the strip-edge jam
   * asks for three weeks of 1826 and gap-fills `1825-10-04 -> 2026-05-25`, two
   * centuries in one request, which the server answers inside the 5s
   * `row-events/load` watchdog only when its cache happens to be warm. That is
   * the whole of the `sheets/strip-edge-stays-on-axis` flake: cold red, warm
   * green, same code.
   *
   * Stated in WINDOWS, not days, because the honest cost of a request is set by
   * the granularity asking: three weeks in week view and twelve years in year
   * view are the same gesture, and any fixed day count calls one of them a jump.
   * Two windows of slop is deliberately generous — a fling that overshoots by a
   * whole extra viewport still fills — and it bounds the worst gap-fill at three
   * window widths instead of at the width of the calendar.
   */
  static readonly GAP_FILL_WINDOW_BUDGET = 2;

  /** Only for rendering the breadcrumb below in days; the decision itself
   *  is a millisecond comparison and never divides. */
  private static readonly MS_PER_DAY = 86_400_000;

  async fetchRange(
    range: DateTime.Range<Tz>,
    padding: DateUnit = DateUnit.days(28),
  ): Promise<Option<DateTime.Range<Tz>>> {
    // Only a current-epoch fetch can satisfy a new demand after invalidation.
    for (const ongoing of this.ongoingFetches.values()) {
      if (
        ongoing.epoch === this._epoch &&
        ongoing.range.start.mse <= range.start.mse &&
        ongoing.range.end.mse >= range.end.mse
      ) {
        await ongoing.fetch;
        return null;
      }
    }

    // The published claim contains only the current epoch's work.
    const effective = this._effectiveRange();

    if (!effective) {
      return await this._fetchForRequest(range, this._paddedWindow(range, padding), "extend");
    }

    if (
      effective.start.mse <= range.start.mse &&
      effective.end.mse >= range.end.mse
    ) {
      this.shouldLog &&
        Tracing.dev(
          "fetch/contains/cached",
          range.toString(),
          effective.toString(),
        );
      if (this.ongoingFetches.size > 0) await Promise.all(this._pendingFor(range));
      return null;
    }

    // Below here the request is not covered, so it will cost a fetch either way
    // and the two allocations are not on the hot path. (`fetchRange` runs on
    // every visible-column refresh; the cached short-circuit above must stay
    // allocation-free.)
    const freshWindow = this._paddedWindow(range, padding);
    const gapFillBudgetMs =
      (freshWindow.end.mse - freshWindow.start.mse) *
      RangeBasedFetcher.GAP_FILL_WINDOW_BUDGET;

    // Case 1: Effective range starts before requested range — extend right.
    // effective:  [********]
    // toFetch:       [********]
    // r:                   [**]
    if (effective.start.isBefore(range.start)) {
      const gapMs = range.start.mse - effective.end.mse;
      if (gapMs > gapFillBudgetMs) {
        return await this._jumpFetch(range, effective, freshWindow, gapMs);
      }
      const r = new DateTime.Range(effective.end, range.end.add(padding));
      this.shouldLog &&
        Tracing.dev(
          "fetch/contains/before",
          range.toString(),
          effective.toString(),
          r.toString(),
        );
      return await this._fetchForRequest(range, r, "extend");
    }

    // Case 2: Effective range ends after requested range — extend left.
    // effective:     [********]
    // toFetch:    [********]
    // r:          [**]
    if (!effective.end.isBefore(range.end)) {
      const gapMs = effective.start.mse - range.end.mse;
      if (gapMs > gapFillBudgetMs) {
        return await this._jumpFetch(range, effective, freshWindow, gapMs);
      }
      const r = new DateTime.Range(
        range.start.add(padding.mult(-1)),
        effective.start,
      );
      this.shouldLog &&
        Tracing.dev(
          "fetch/contains/after",
          range.toString(),
          effective.toString(),
          r.toString(),
        );
      return await this._fetchForRequest(range, r, "extend");
    }

    // Case 3: Need wider range than currently covered. The requested range
    // straddles the cache, so there is no gap to fill and nothing to budget.
    // effective:     [****]
    // toFetch:    [**********]
    // r:          [**********]
    const r = freshWindow;
    this.shouldLog &&
      Tracing.dev(
        "fetch/contains/after",
        range.toString(),
        effective.toString(),
        r.toString(),
      );
    return await this._fetchForRequest(range, r, "extend");
  }

  async fetch(
    date: DateTime<Tz>,
    paddingDays: number = 28,
  ): Promise<Option<DateTime.Range<Tz>>> {
    const effective = this._effectiveRange();

    if (effective?.containsExclusiveEnd(date)) {
      for (const fetch of this.ongoingFetches.values()) {
        if (fetch.epoch === this._epoch && fetch.range.containsExclusiveEnd(date)) {
          await fetch.fetch;
          return fetch.epoch === this._epoch ? fetch.range : null;
        }
      }
      return null;
    }

    if (!effective) {
      const range = new DateTime.Range(
        date.add({ days: -paddingDays }),
        date.add({ days: paddingDays }),
      );
      return await this._runEntry(range, "extend");
    }

    let rangeToFetch: DateTime.Range<Tz>;
    if (date.mse < effective.start.mse) {
      rangeToFetch = new DateTime.Range(
        date.add({ days: -paddingDays }),
        effective.start,
      );
    } else {
      rangeToFetch = new DateTime.Range(
        effective.end,
        date.add({ days: paddingDays }),
      );
    }

    return await this._actuallyFetch(rangeToFetch);
  }

  /** The ask plus `padding` at both ends: what a request with no cache behind
   *  it fetches, and the unit the gap-fill budget is counted in. */
  private _paddedWindow(
    range: DateTime.Range<Tz>,
    padding: DateUnit,
  ): DateTime.Range<Tz> {
    return new DateTime.Range(
      range.start.add(padding.mult(-1)),
      range.end.add(padding),
    );
  }

  /**
   * A request too far from the cache to be a scroll: fetch the window that was
   * actually asked for and let the old coverage go.
   *
   * Dropping rather than keeping BOTH ranges is forced by the shape of this
   * class: `fetchedRange` is one interval, and it is read as one interval by
   * every consumer (`RowHandle.isCoveredAt`, `hasCoverage`, `SyncState`,
   * `SheetCellAccessor._markInsertedRowKnownEmpty`). Unioning across the gap
   * would claim coverage of every day between the two windows without having
   * asked the server for any of them — the false "we know about this date" that
   * settles a subscriber to `dataFull(null)` on data that exists. Filling the
   * gap is what makes today's union honest, and filling it is the defect. So
   * the new window REPLACES the claim. Cells already in the store are untouched,
   * so nothing blanks; the cost is that coming back re-fetches the old window.
   *
   * That trade is not new — `EventsClient.ensureCalendarLoaded` already makes it by
   * hand, going through `RowHandle.refresh` (which nulls `fetchedRange` first)
   * precisely "so the request is the asked-for window +/-28d" rather than every
   * month between here and a year out. This generalises that workaround to
   * every caller instead of leaving it to the ones that know to ask.
   */
  private async _jumpFetch(
    range: DateTime.Range<Tz>,
    effective: DateTime.Range<Tz>,
    freshWindow: DateTime.Range<Tz>,
    gapMs: number,
  ): Promise<Option<DateTime.Range<Tz>>> {
    // Dates spelled out per end rather than `range.toString()`: `DateTime.Range`
    // has no `toString` override, so a range logs as `[object Object]` (the
    // `Tracing.dev` lines above have that bug; this one is read by UX runs).
    Tracing.log("fetch/jump-not-scroll", {
      requestedStart: range.start.date.toString(),
      requestedEnd: range.end.date.toString(),
      cachedStart: effective.start.date.toString(),
      cachedEnd: effective.end.date.toString(),
      fetchingStart: freshWindow.start.date.toString(),
      fetchingEnd: freshWindow.end.date.toString(),
      gapDays: Math.round(gapMs / RangeBasedFetcher.MS_PER_DAY),
      budgetDays: Math.round(
        ((freshWindow.end.mse - freshWindow.start.mse) *
          RangeBasedFetcher.GAP_FILL_WINDOW_BUDGET) /
          RangeBasedFetcher.MS_PER_DAY,
      ),
    });
    return await this._fetchForRequest(range, freshWindow, "replace");
  }

  private _pendingFor(range: DateTime.Range<Tz>): Promise<void>[] {
    const pending: Promise<void>[] = [];
    for (const entry of this.ongoingFetches) {
      if (entry.epoch === this._epoch && entry.range.start.mse < range.end.mse &&
        range.start.mse < entry.range.end.mse) pending.push(entry.fetch);
    }
    return pending;
  }

  /** An extension satisfies the whole ask only after its overlapping predecessors land. */
  private async _fetchForRequest(
    requested: DateTime.Range<Tz>,
    window: DateTime.Range<Tz>,
    coverage: RangeBasedFetcher.Coverage,
  ): Promise<Option<DateTime.Range<Tz>>> {
    const pending = coverage === "replace" ? [] : this._pendingFor(requested);
    const epoch = this._epoch + (coverage === "replace" ? 1 : 0);
    let installed: Option<DateTime.Range<Tz>> = null;
    await Promise.all([
      this._actuallyFetch(window, coverage).then((range) => { installed = range; }),
      ...pending,
    ]);
    return epoch === this._epoch ? installed : null;
  }

  private async _actuallyFetch(
    range: DateTime.Range<Tz>,
    coverage: RangeBasedFetcher.Coverage = "extend",
  ): Promise<Option<DateTime.Range<Tz>>> {
    return await this._runEntry(range, coverage);
  }

  /** Wait for delivery and coverage bookkeeping; obsolete entries return no installed range. */
  private async _runEntry(
    range: DateTime.Range<Tz>,
    coverage: RangeBasedFetcher.Coverage,
  ): Promise<Option<DateTime.Range<Tz>>> {
    const entry = this.createFetchEntry(range, coverage);
    await entry.fetch;
    return entry.epoch === this._epoch ? entry.range : null;
  }

  /** A delivered fetch joins the committed record — unless the claim was
   *  assigned (invalidated or replaced) while it was in flight: then the
   *  assignment wins and the range is simply fetched again on demand. */
  private _commit(range: DateTime.Range<Tz>, _coverage: RangeBasedFetcher.Coverage, epoch: number): void {
    if (epoch !== this._epoch) return;
    // A "replace" entry already cleared the record and opened its epoch when it
    // started, so on completion it commits like any other: joined to whatever
    // same-epoch extension delivered before it.
    this._committed = this._committed == null ? range : RangeBasedFetcher._join(this._committed, range);
  }

  /** The claim after any completion: what delivered in the current epoch, plus
   *  what is still in flight from it. Older-epoch entries stay tracked until
   *  completion but cannot satisfy new demands or join a replacement window. */
  private _recomputeClaim(): Option<DateTime.Range<Tz>> {
    // Committed coverage first, then in-flight windows in the order they were
    // requested: when two pieces do not touch the newer one wins, so a failed
    // middle request leaves a hole rather than a bridge.
    let claim: Option<DateTime.Range<Tz>> = this._committed;
    for (const { range, epoch } of this.ongoingFetches) {
      if (epoch !== this._epoch) continue;
      claim = claim == null ? range : RangeBasedFetcher._join(claim, range);
    }
    return claim;
  }

  private static _touches<Tz extends string>(a: DateTime.Range<Tz>, b: DateTime.Range<Tz>): boolean {
    return a.end.mse >= b.start.mse && b.end.mse >= a.start.mse;
  }

  /**
   * The one-interval join this class is allowed: touching or overlapping
   * pieces merge; disjoint pieces do not — `b`, the newer, is kept and `a` is
   * forgotten (refetched on demand). Forgetting valid coverage is a cost the
   * one-interval API accepts; claiming an interval nobody fetched is not.
   */
  private static _join<Tz extends string>(a: DateTime.Range<Tz>, b: DateTime.Range<Tz>): DateTime.Range<Tz> {
    if (!RangeBasedFetcher._touches(a, b)) return b;
    return RangeBasedFetcher._union(a, b);
  }

  private static _union<Tz extends string>(a: DateTime.Range<Tz>, b: DateTime.Range<Tz>): DateTime.Range<Tz> {
    return new DateTime.Range(
      a.start.mse < b.start.mse ? a.start : b.start,
      a.end.mse > b.end.mse ? a.end : b.end,
    );
  }

  private createFetchEntry(
    range: DateTime.Range<Tz>,
    coverage: RangeBasedFetcher.Coverage = "extend",
  ): {
    range: DateTime.Range<Tz>;
    fetch: Promise<void>;
    coverage: RangeBasedFetcher.Coverage;
    epoch: number;
  } {
    // The optimistic claim includes only current-epoch entries.
    // A "replace" window is a new epoch, exactly like an explicit assignment:
    // everything pending before it belongs to the abandoned interval and may
    // neither commit nor re-claim, so the gap between the two windows is never
    // bridged by a late completion.
    if (coverage === "replace") {
      this._epoch++;
      this._committed = null;
    }
    const base = coverage === "replace" ? null : this._recomputeClaim();
    this._claim = base == null ? range : RangeBasedFetcher._join(base, range);
    let resolve: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const fetch = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const entry = { range, fetch, coverage, epoch: this._epoch };
    // Publish the entry and its epoch before user code runs. Reentrant demand
    // can now await this same completion, including its coverage bookkeeping.
    this.ongoingFetches.add(entry);
    const fail = (error: Error): void => {
      this.ongoingFetches.delete(entry);
      this._claim = this._recomputeClaim();
      reject(error);
    };
    try {
      this.fetcher(range).then(() => {
        this.ongoingFetches.delete(entry);
        this._commit(entry.range, coverage, entry.epoch);
        this._claim = this._recomputeClaim();
        resolve();
      }, fail);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
    return entry;
  }
}

export namespace RangeBasedFetcher {
  /**
   * What a fetch does to the coverage claim: `"extend"` unions the new range
   * with everything already covered (a scroll), `"replace"` makes the new range
   * the whole claim (a jump — see `RangeBasedFetcher.GAP_FILL_WINDOW_BUDGET`).
   */
  export type Coverage = "extend" | "replace";
}
