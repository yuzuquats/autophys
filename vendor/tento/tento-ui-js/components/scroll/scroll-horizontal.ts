import { nonnull } from "@tento-core/assert";
import { Constants } from "@tento-core/constants";
import { LiveData } from "@tento-core/livedata";
import { Tracing } from "@tento-core/tracing";
import { MathUtils } from "@tento-core/math";
import { Point } from "@tento-core/point";
import { html, LonaWebComponent } from "../../component.js";
import { component } from "../../component-decorators.js";
import { css } from "../../component-styles.js";
import { DomUtils } from "../../dom.js";
import { $_maybe, $qsa } from "../../dom-selectors.js";
import { $$ } from "../../fastdom.js";
import { DomFlags } from "../../dom-flags.js";
import { ColumnPlacement } from "@tento-scroll/engine/column-placement";
import { Globals } from "../../globals.js";
import { LazySync } from "../../lazy.js";
import { SizeGate } from "../../ui/size-gate.js";
import { CellHeight, MeasuredHeightPx } from "../sheet/cell-height.js";
import { Toast } from "../toast/toast.js";
import { Scrollable } from "@tento-scroll/engine/scrollable";
import { SettleWaits } from "@tento-scroll/engine/settle-wait";
import {
  type BindGeneration,
  type LastBound,
  ScrollEngine,
  SettleDebt,
  type SettleResult,
} from "@tento-scroll/engine/scroll-engine";
import { PopoverInfo, ScrollLayoutSnapshot } from "./scroll-layout-snapshot.js";
import { ScrollLayoutSnapshotOverlay } from "./scroll-layout-snapshot-overlay.js";
import { ScrollPopover } from "./scroll-popover.js";
import { ScrollTooltip } from "./scroll-tooltip.js";

/**
 * `LastBound` as the number recorded traces already carry: `-1` for "never".
 *
 * The breadcrumb key predates the type by months and sessions are diffed
 * against saved runs, so the WIRE stays a number even though the value stopped
 * being one. The sentinel lives here, at the one boundary that still needs it,
 * instead of inside the engine where it used to be the representation.
 */
function lastBoundKey(last: LastBound): number {
  return last.kind === "bound" ? last.generation : -1;
}

// Gecko (Firefox) applies the strict CSS table model to the children of
// #content's `display: inline-table`, breaking two things Blink is lenient
// about: %-heights don't resolve against the table box (#sidebar collapses)
// and position:sticky children stick to the anonymous table cell instead of
// the scrollport (#footers won't pin to the bottom). The
// :host([engine="gecko"]) path in $style swaps #content to inline-block and
// grows it to reserve the footer's bottom space. Detected once via UA — "Gecko"
// is in every browser's UA token, but "Firefox" is Gecko-specific.
const IS_GECKO =
  typeof navigator !== "undefined" && /firefox/i.test(navigator.userAgent);

/**
 * The `cid` attribute records which collection a column is currently bound to.
 * It is set on every bind and cleared on recycle, so attribute *presence* is an
 * exact "this column is bound" signal:
 *   - absent (`of` ⇒ null) ⇒ rendered but awaiting (re)bind — a transient
 *     strand we can self-heal;
 *   - present but different from the current collection ⇒ genuinely bound to
 *     another collection (stale) — hide, don't heal.
 * Detecting strands by presence avoids overloading an empty-string sentinel and
 * also catches a recycled column re-rendered without rebind (which keeps no
 * stale cid, rather than a misleading non-empty one).
 */
/**
 * DIAG(header-blank): the four ways a column can occupy the viewport yet paint
 * nothing. `pending-layout` / `recycled` are cleared only by a successful bind;
 * `unbound` is a rendered entry with no collection marker at all; `zero-height`
 * is the one no marker can see — a column that is bound, unmarked and honestly
 * laid out, whose every non-hidden cell measures 0px (the 2026-08-06 operator
 * break, where a scrub zeroed the heights and an honored render skip never
 * restored them).
 *
 * Exported because these four strings are a PUBLISHED taxonomy: 95 tracked UX
 * specs assert on them through the `scroll/header-violation` breadcrumb, so a
 * value renamed here silently un-forbids a spec rather than failing a build.
 * {@link HeaderViolationKind.ALL} is the exhaustive list — adding a member to
 * the union without adding it there fails `header-violation-kind.deno.test.ts`.
 */
export type HeaderViolationKind =
  | "pending-layout"
  | "recycled"
  | "unbound"
  | "zero-height";

export namespace HeaderViolationKind {
  /**
   * Every kind, in escalation-report order. Exhaustive over the union by
   * construction: the test that guards this asserts both directions, so a
   * fifth kind cannot be added to one and not the other.
   */
  export const ALL: readonly HeaderViolationKind[] = [
    "pending-layout",
    "recycled",
    "unbound",
    "zero-height",
  ];
}

/**
 * The payload of the `scroll/header-violation` breadcrumb — the escalated
 * (persistent, quiesce-gated) sighting the UX specs forbid by label.
 *
 * The keys are the contract, not a suggestion: `indices` is a slice of at most
 * twenty column indices (not one `index`), `gen` the bind generation the
 * sighting was observed under, and `ctx` the sweep context that escalated it
 * (`trailing`, `trailing-confirm`, `settled…`). The emit site pins itself to
 * this shape with `satisfies`, so a renamed key fails `ts check` instead of
 * quietly changing what the specs read.
 */
export interface HeaderViolationEvent {
  readonly kind: HeaderViolationKind;
  readonly indices: readonly number[];
  readonly gen: number;
  readonly ctx: string;
}

/**
 * How long the header sweep keeps excusing a marked column whose live bind is
 * queued while the generation's bind installation barrier stays held — the
 * mark-age grace (3 s), so a barrier that never lifts escalates within about
 * five 600 ms confirm passes of the first sweep that saw it held.
 */
const HELD_INSTALLATION_EXCUSE_MS = 3000;

/** The real clock behind the header sweep (see `headerSweepClock`). Reads the
 * globals at call time, so a test that swaps them still intercepts. `Number`
 * keeps the handle a number where the ambient timer types say `Timeout`. */
const SYSTEM_SWEEP_CLOCK: Tracing.Witness.WatchdogClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => Number(setTimeout(fn, ms)),
  clearTimeout: (id) => clearTimeout(id),
};

namespace BoundCollection {
  const ATTR = "cid";
  /**
   * Record the collection a bind just painted. With no id yet there is nothing
   * to record, and nothing to take away: a bind that lands before the host has
   * been told its collection must not strip a marker (only a recycle —
   * {@link clear} — means "no longer bound").
   */
  export function set($c: HTMLElement, collectionId: Option<string>): void {
    if (collectionId != null) $c.setAttribute(ATTR, collectionId);
  }
  export function clear($c: HTMLElement): void {
    $c.removeAttribute(ATTR);
  }
  export function of($c: HTMLElement): Option<string> {
    return $c.getAttribute(ATTR);
  }
}

@component({
  name: "std-scroll-horizontal",
})
export class ScrollHorizontal<
  Header extends HTMLElement,
  Body extends HTMLElement,
  Footer extends HTMLElement = Header,
> extends LonaWebComponent {
  // @init
  private delegate: Option<ScrollHorizontal.Delegate<Header, Body, Footer>>;
  private scrollNotificationGeneration = 0;
  _scrollEngine: Option<
    ScrollEngine<{ $header: Header; $body: Body; $footer?: Option<Footer> }>
  >;
  get scrollEngine(): ScrollEngine<{
    $header: Header;
    $body: Body;
    $footer?: Option<Footer>;
  }> {
    return this._scrollEngine!;
  }

  /**
   * Advance the engine's render epoch (interruptible rendering). Binds queued
   * under an older generation are dropped in the drain. Null-safe: a no-op
   * before the engine exists (early bind). See {@link ScrollEngine.setBindGeneration}.
   */
  setBindGeneration(generation: BindGeneration): void {
    const engine = this._scrollEngine;
    if (!engine) return;
    const previous = engine.currentBindGeneration;
    engine.setBindGeneration(generation);
    if (engine.currentBindGeneration !== previous) {
      this.resetHeaderSweeps();
      this.scheduleHeaderInvariantSweep("generation-changed");
    }
  }

  /** Hold binding while this generation's renderer and view model install. */
  beginBindGeneration(generation: BindGeneration): void {
    this.setBindGeneration(generation);
    this._scrollEngine?.beginBindGeneration(generation);
  }

  /** Release only the matching generation's installed content. */
  commitBindGeneration(generation: BindGeneration): void {
    this._scrollEngine?.commitBindGeneration(generation);
  }
  /**
   * Whether the engine has a viewport yet. False between `initialize()` and the
   * first `bindLayout()` — the window in which `scrollEngine.viewport` is
   * `undefined` behind its non-null assertion, so every strip read throws.
   * @see {@link ScrollEngine.hasViewport}
   */
  get hasViewport(): boolean {
    return this._scrollEngine?.hasViewport ?? false;
  }
  columnId: number = 0;
  // Indices for which assertChildren has already forced a self-heal rebind;
  // reset in bindColumnComponent once the index binds. Bounds the retry to one
  // emit.index per strand so a genuinely stuck column can't loop every frame.
  private healAttempted = new Set<number>();
  // Indices that were mismatched on the previous assertChildren run. A toast
  // only fires when an index is still mismatched on the next run (persistent),
  // so self-healing transients don't spam service accounts.
  private prevMismatchedIndices = new Set<number>();
  // One-shot resolvers awaiting the next full bind-drain (deferred===0). Drained
  // in the onBatchComplete handler. Backs whenSettled() so a consumer (the sheet
  // navigation reveal) can wait until rendered cells hold their NEW content, not
  // merely until binds were enqueued.
  private readonly bindDrainListeners = new Set<() => void>();
  private readonly settleWaiters = new SettleWaits({
    queue: () => this.scrollEngine.bindQueue(),
    lastUserInputAt: () => this._scrollEngine?.lastUserInputAt() ?? null,
    now: () => performance.now(),
    requestFrame: (callback) => $$.raf(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    settled: (debt, via, progress) => {
      const queue = this.scrollEngine.bindQueue();
      Tracing.log("scroll/when-settled", {
        released: via,
        debt: debt.kind,
        minGeneration: debt.kind === "none" ? -1 : debt.generation,
        lastBound: lastBoundKey(queue.last),
        gen: queue.current,
        pendingBinds: this.pendingBindsSnapshot(),
        ...(progress == null ? {} : {
          ...progress,
          pending: queue.kind === "pending",
        }),
      });
      if (via !== "fast") this.scheduleHeaderInvariantSweep(`settled-${via}`);
    },
    cancelled: (debt, progress) => {
      Tracing.log("scroll/settle-cancelled", {
        debt: debt.kind,
        minGeneration: debt.kind === "none" ? -1 : debt.generation,
        ...progress,
      });
    },
  });
  private scrollEngineDelegate(
    delegate: ScrollHorizontal.Delegate<Header, Body, Footer>,
  ): ScrollEngine.Delegate<{
    $header: Header;
    $body: Body;
    $footer?: Option<Footer>;
  }> {
    const bindColumnComponent = (
      $c: HTMLElement,
      index: number,
      widthPx: Option<number>,
      offsetPx: number,
    ) => {
      $c.toggleAttribute("recycled", false);
      // The bind reinstates live geometry, so the column leaves the pool park
      // in the same write that gives it its real `--offset` — never a frame at
      // the park position with a live offset, or vice versa.
      $c.toggleAttribute("pooled", false);
      // The index whose content this column now holds: `onPlace` compares it
      // against a later placement (a bind installation that moved the range)
      // to hide content that would otherwise ride along to another index.
      $c.setAttribute("bound-idx", String(index));
      $c.toggleAttribute("placed-stale", false);
      $c.removeAttribute("column-placeholder");
      BoundCollection.set($c, this.collectionId);
      // Successful bind clears any pending self-heal so a future, unrelated
      // strand at this index can heal again.
      this.healAttempted.delete(index);
      $c.assignStyles({
        "--idx": String(index),
        width: widthPx ? widthPx + "px" : "",
        "--offset": offsetPx != null ? offsetPx + "px" : "",
      });
    };
    /**
     * Hand a column back to the pool cleanly. A pooled column is not "a column
     * awaiting a bind" — it is not in `engine.entries` at all, so BY DEFINITION
     * no bind is coming for it, and both of the things it used to keep are lies:
     *
     *  - `pending-layout` means "marked by a structural rebind, will be cleared
     *    by its bind". Its only clear is a completed bind (the `onBind` finally),
     *    so a mark carried into the pool is permanent — it poisons every later
     *    diagnostic (the invariant sweep counts it as an untracked stranded
     *    column overlapping the viewport, which reads as an engine-coverage
     *    failure) and it can never be true again until it rebinds anyway.
     *  - its `--offset` still names the index it was recycled FROM, at that
     *    generation's column width. Parked in place it overlaps the live
     *    viewport at a stale geometry that no reconcile window covers and no
     *    per-index bind can address. Park it instead (see the `[pooled]` rule in
     *    $styles: `translateX(0)` = content x 0, `--base-offset` px to the left
     *    of any real scroll position) so it is provably outside the scrollport
     *    until `bindColumnComponent` gives it live geometry again.
     *
     * `[recycled]` (opacity 0) stays as-is: it is the paint-side marker and is
     * also set by assertChildren on TRACKED columns, which must keep their
     * geometry.
     */
    const poolColumn = ($c: HTMLElement) => {
      $c.removeAttribute("pending-layout");
      $c.removeAttribute("bound-idx");
      $c.removeAttribute("placed-stale");
      $c.toggleAttribute("pooled", true);
    };
    const recycleColumn = (column: { $header: Header; $body: Body; $footer?: Option<Footer> }) => {
      const { $header, $body, $footer } = column;
      $header.toggleAttribute("recycled", true);
      $body.toggleAttribute("recycled", true);
      if ($footer) $footer.toggleAttribute("recycled", true);
      // Clear the bound-collection marker so a recycled column reads as
      // unbound (not stale) until its next bind — keeps strand detection in
      // assertChildren a clean attribute-presence check.
      BoundCollection.clear($header);
      BoundCollection.clear($body);
      if ($footer) BoundCollection.clear($footer);
      poolColumn($header);
      poolColumn($body);
      if ($footer) poolColumn($footer);
      delegate.onRecycle?.({ $header, $body, $footer });
    };
    return {
      onCreate: () => {
        const iid = this.columnId++;

        const { $header, $body, $footer } = delegate.onCreate();
        $header.slot = "header";
        $header.setAttribute("dbg-id", String(iid));

        $body.slot = "body";
        $body.setAttribute("dbg-id", String(iid));

        if ($footer) {
          $footer.slot = "footer";
          $footer.setAttribute("dbg-id", String(iid));
        }

        $$.mutate(() => {
          // Appending a connected column again would move it, and a move
          // disconnects it, which retires its bind.
          if ($header.parentNode === this) return;
          this.appendChild($header);
          this.appendChild($body);
          if ($footer) this.appendChild($footer);
        });
        return { $header, $body, $footer };
      },
      onBind: (
        { $header, $body, $footer },
        index,
        position,
        widthPx,
        resizeOnly,
        isOffscreen,
      ) => {
        Tracing.info("ui")("core/sheet-scroll/cell/bind", index);
        const resolvedWidth = widthPx ?? this.layoutProps!.cellWidthPx;
        try {
          delegate.onBind(
            { $header, $body, $footer },
            index,
            resolvedWidth,
            resizeOnly,
            isOffscreen,
          );

          const offset = MathUtils.roundToDecimals(position, 3);
          const width = MathUtils.roundToDecimals(resolvedWidth, 3);
          bindColumnComponent($header, index, width, offset);
          bindColumnComponent($body, index, width, offset);
          if ($footer) bindColumnComponent($footer, index, width, offset);
          if (!resizeOnly) $header.removeAttribute("bind-failed");
        } catch (error) {
          // A successful neighbouring column cannot certify this failed bind.
          // The enclosing engine still isolates the exception and drains on.
          $header.setAttribute("bind-failed", "");
          throw error;
        } finally {
          // Clear `pending-layout` even if the delegate bind threw. The scroll
          // engine catches per-column onBind errors (scroll-engine.ts ~492) and
          // keeps draining, so a column that fails to rebind MUST NOT stay
          // `visibility: hidden` forever — fail open to stale-content-at-the-
          // new-geometry over a permanently blank column. Clearing on any bind
          // (incl. resize/offset-only) is safe; only the mark side is gated.
          $header.removeAttribute("pending-layout");
          $body.removeAttribute("pending-layout");
          if ($footer) $footer.removeAttribute("pending-layout");
        }
      },
      onRecycle: (column) => {
        Tracing.info("ui")(
          "core/sheet-scroll/cell/recycle",
          column.$header.getAttribute("idx"),
        );
        recycleColumn(column);
      },
      options: {
        ...delegate.options,
        // No-delay binding: content binds every frame against one wall-clock
        // deadline, visible columns first, then in the direction of travel.
        frameDeadlineMs: () => ScrollHorizontal.frameDeadlineMs(),
        // Column retention: recycled columns kept keyed by the index they last
        // showed, so a fling back reattaches them (engine `Pool`).
        columnRetention: () => ScrollHorizontal.columnRetention(),
        // Placement for a column whose full bind is still queued when a bind
        // installation commits: live geometry now, content at its bind. Leaves `recycled` (opacity 0)
        // and `pending-layout` untouched and never sets the bound-collection
        // marker, so the column reads as unbound to every invariant until its
        // real bind lands. Only columns without live geometry are touched.
        onPlace: ({ $header, $body, $footer }, index, position, widthPx) => {
          const resolvedWidth = widthPx ?? this.layoutProps!.cellWidthPx;
          const offset = MathUtils.roundToDecimals(position, 3);
          const width = MathUtils.roundToDecimals(resolvedWidth, 3);
          const desired: ColumnPlacement.Desired = { index, offsetPx: offset, widthPx: width };
          for (const $c of [$header, $body, $footer]) {
            if (!$c) continue;
            // The decision is `ColumnPlacement.plan` (pure, tested): every
            // value compared, geometry only, markers untouched.
            const plan = ColumnPlacement.plan({
              idx: $c.style.getPropertyValue("--idx"),
              offset: $c.style.getPropertyValue("--offset"),
              width: $c.style.width,
              pooled: $c.hasAttribute("pooled"),
            }, desired);
            // Content that belongs to another index must not ride along to
            // this one: hide it until the full bind lands (the bind clears the
            // mark). Decided before the geometry write, so a column placed back
            // at its own index shows its content again in the same frame.
            $c.toggleAttribute(
              "placed-stale",
              ColumnPlacement.stale($c.getAttribute("bound-idx"), desired, $c.hasAttribute("pooled"), $c.hasAttribute("recycled")),
            );
            if (plan.kind === "skip") continue;
            if (plan.unpool) $c.toggleAttribute("pooled", false);
            $c.assignStyles(plan.styles);
          }
          // Every placement reaches the delegate: a header's label is a pure
          // function of the column's range and is written here, at placement,
          // so a placed header is never unlabelled.
          this.delegate?.options?.onPlace?.({ $header, $body, $footer }, index, position, resolvedWidth);
        },
        onBatchComplete: () => {
          if (ScrollHorizontal.columnRetention() > 0) {
            // Trace hook `scroll/column-retention`: how the pool answered since the last drain.
            const stats = this.scrollEngine.takeColumnRetentionStats();
            if (stats.hits + stats.retargets + stats.created > 0) Tracing.log("scroll/column-retention", stats);
          }
          $$.mutateEnd(() => this.assertChildren());
          // Passive recovery consumers sample again after this batch's DOM
          // writes and repair bookkeeping. A drain notification is not success.
          $$.mutateEnd(() => {
            for (const listener of [...this.bindDrainListeners]) {
              if (this.bindDrainListeners.has(listener)) listener();
            }
          });
          this.scheduleHeaderInvariantSweep("batch-complete");
          // The queue fully drained — every rendered cell now holds its new
          // content. Wake settle waiters so the sheet's post-navigation reveal
          // flips opacity only after new content is painted, never on stale
          // recycled content at the new geometry (the nav flash). Each waiter is
          // idempotent (whenSettled) — it unlinks itself, so its bounded
          // fallback can't double-fire after this drain wakes it.
          if (this.settleWaiters.size > 0) {
            // Trace hook `scroll/settle-flush`: how many settle waiters this drain woke.
            Tracing.log("scroll/settle-flush", { count: this.settleWaiters.size });
            this.settleWaiters.drain();
          }
          // Pending-layout coverage: after a structural pass's
          // drain, no rendered column may still carry `pending-layout` (each
          // column's onBind finally clears its own mark). remaining > 0 means
          // a marked column was never re-bound (the 1:1 coverage invariant
          // broke) — keep watching until a later drain clears it, so the
          // final drain log always reports the settled state.
          if (this.pendingLayoutMarked != null) {
            const marked = this.pendingLayoutMarked;
            let remaining = 0;
            const engine = this._scrollEngine;
            const orphanIndices: number[] = [];
            if (engine) {
              for (const entry of engine.entries.all) {
                const { $header, $body, $footer } = entry.t;
                let isMarked =
                  $header.hasAttribute("pending-layout") ||
                  $body.hasAttribute("pending-layout");
                if (!isMarked && $footer) {
                  isMarked = $footer.hasAttribute("pending-layout");
                }
                if (isMarked) {
                  remaining += 1;
                  orphanIndices.push(entry.index);
                }
              }
            }
            if (remaining === 0) this.pendingLayoutMarked = null;
            Tracing.log("scroll/pending-layout/drain", { marked, remaining });
            // Orphaned-epoch enforcement: marks laid under an OLDER generation
            // than the batch that just drained can never be cleared by their
            // promising pass (its re-emits were generation-gated away when a
            // navigation superseded it) — the column sits fully bound but
            // visibility:hidden for the life of the sheet. Re-issue each such
            // column through the LIVE bind: the same onBind that binds current
            // content clears the mark. One attempt per orphaned epoch (the
            // epoch is advanced below), so a further supersede re-arms rather
            // than loops.
            if (
              remaining > 0 &&
              engine != null &&
              this.pendingLayoutMarkGen != null &&
              this.pendingLayoutMarkGen < engine.currentBindGeneration
            ) {
              const markGen = this.pendingLayoutMarkGen;
              this.pendingLayoutMarkGen = engine.currentBindGeneration;
              for (const index of orphanIndices) {
                engine.emit.index(index);
              }
              // DOM-visible repair counter: session trails evict quickly, so a
              // remote diagnosis (or a battery) can read from the host itself
              // that the orphaned-mark race occurred and was repaired.
              this.dataset.orphanReemits = String(
                Number(this.dataset.orphanReemits ?? "0") + 1,
              );
              Tracing.log("scroll/pending-layout/orphan-reemit", {
                reEmitted: orphanIndices.length,
                markGen,
                gen: engine.currentBindGeneration,
              });
            }
          }
        },
      },
    };
  }

  // @props
  private collectionId: Option<string>;
  private props: Option<ScrollHorizontal.Props>;
  private layoutProps: Option<ScrollEngine.LayoutProps>;
  /**
   * The index space the last {@link bindLayout} named — what an index MEANS to
   * the component's own callers. Kept so the rebinds this component originates
   * (a viewport-length change) can say which space they are in without inventing
   * one: a resize does not change the meaning of an index, and the way to say
   * that is to hand back the space already in force.
   */
  #space: Option<ScrollEngine.IndexSpace.Erased> = null;

  private bodyHeight: Option<number>;
  private scrollBindRevision = 0;
  private scrollBodyRevision = 0;

  // The column count of the
  // last markRenderedColumnsPendingLayout(true); consumed (and cleared) by the
  // `scroll/pending-layout/drain` log in onBatchComplete.
  private pendingLayoutMarked: Option<number> = null;
  // The bind generation the marks were laid under. A mark is a PROMISE that the
  // marking pass's own re-emits will clear it via onBind; when a navigation
  // bumps the generation before those re-emits drain, the promise is dead and
  // the marks strand (2026-08-06 operator break: every header column bound,
  // text and heights present, `pending-layout` never cleared — a permanently
  // hidden band). onBatchComplete enforces the promise for orphaned epochs.
  private pendingLayoutMarkGen: Option<BindGeneration> = null;
  private footerHeight: Option<number>;
  private scrollHeightSnapshot: Option<number>;

  // @components
  private $staticAnchorHeader = this.$("static-anchor-header");
  private $staticAnchorBody = this.$("static-anchor-body");
  private $staticAnchorFooter = this.$("static-anchor-footer");
  private $contentViewport = this.$("content-viewport");
  private $scrollable = new Scrollable.Dom(this.$contentViewport, {
    onScrollPosition: (position) => {
      // Full geometry stays live for legacy listeners; position-only consumers
      // never pay for an extent they do not use.
      const recipient = this.delegate;
      const generation = this.scrollNotificationGeneration;
      const onScroll = recipient?.onScroll;
      const onScrollPosition = recipient?.onScrollPosition;
      onScroll?.call(recipient, this.$scrollable.getScrollInfo()!);
      // A replacement binding or callback starts with its next event.
      if (this.delegate === recipient && this.scrollNotificationGeneration === generation &&
        recipient?.onScrollPosition === onScrollPosition) {
        onScrollPosition?.call(recipient, position);
      }
    },
    // Hover/hit-test suppression during wheel scroll: content moving under a
    // stationary cursor makes Chrome re-hit-test the ~whole column subtree per
    // scrolled frame to maintain hover/target state (run30: 557 walks,
    // 2,416ms, all input-pipeline — zero app JS). Wheel activity shows the
    // #wheel-shield overlay so those walks terminate at one element (see the
    // CSS block for why the shield, not inherited pointer-events). Wheel-only:
    // drags/touches never engage it.
    // The style state lives on the shield (`active`), so toggling it
    // invalidates that one element. A rule keyed on a host attribute
    // (`:host([wheel-scrolling]) #wheel-shield`) crosses the shadow boundary
    // and makes the style invalidator walk the host's whole subtree, forced
    // in the first frame of every wheel gesture and again at settle. The
    // host keeps `wheel-scrolling` as an observable marker only: no style
    // rule may select on it.
    onWheelActivity: (active) => {
      $$.mutate(() => {
        this.$("wheel-shield").toggleAttribute("active", active);
        this.toggleAttribute("wheel-scrolling", active);
      });
    },
    snapping: {
      onSnap: () => {
        // A scroll-settle can fire during startup before initialize() +
        // bindLayout() have created the engine and its viewport. Skip until
        // the engine is bound; otherwise `viewport` dereferences undefined.
        if (!this._scrollEngine?.hasViewport) return;
        const ni = this.scrollEngine.viewport.scrollOffset.nearest();
        if (ni == null) return;
        // The view moving on its own after a scroll settles. Name it: a run of
        // stepped scrollLeft writes on frames slower than the 80ms settle is
        // snapped back between every two steps (ux formula-scroll-recycle
        // fresh-fail, rc e621ce/867c44), and without this span the trace shows
        // only a scroll that stopped binding columns.
        Tracing.log("scroll/snap", { index: ni, from: Math.round(this.$scrollable.contentOffset) });
        // A snap settle moves the view to the nearest column and nothing
        // else: the map and the bound content are already correct.
        this.scrollEngine.bindIndex(ni, {
          kind: "reveal",
          at: {
            position: "start",
            scrollBehavior: "smooth",
            useNativeScrollTo: false,
          },
          viewportChangeSource: "snap",
        });
      },
      enabled: () => true,
    },
  });
  private $debugOverlay = new LazySync<ScrollLayoutSnapshotOverlay>(() => {
    const $e = ScrollLayoutSnapshotOverlay.make();
    $e.id = "scroll-debug-overlay";
    $e.assignStyles({
      position: "absolute",
      pointerEvents: "none",
      zIndex: String(Constants.MAX_Z_INDEX),
      overflow: "visible",
    });
    this.$("bodies").appendChild($e);
    return $e;
  });
  private $headerDebugOverlay = new LazySync<ScrollLayoutSnapshotOverlay>(
    () => {
      const $e = ScrollLayoutSnapshotOverlay.make();
      $e.id = "scroll-header-debug-overlay";
      $e.assignStyles({
        position: "absolute",
        pointerEvents: "none",
        zIndex: String(Constants.MAX_Z_INDEX),
        overflow: "visible",
      });
      this.$("headers").appendChild($e);
      return $e;
    },
  );

  // @pointer
  readonly pointerPosition = new LiveData<
    Option<{
      viewportX: number;
      viewportY: number;
      contentX: number;
    }>
  >(null);
  private _pointerTracking = (() => {
    const vp = this.$contentViewport;
    vp.addEventListener(
      "pointermove",
      (e: PointerEvent) => {
        const rect = vp.getBoundingClientRect();
        const viewportX = e.clientX - rect.left;
        const viewportY = e.clientY - rect.top;
        const contentX =
          viewportX + vp.scrollLeft - this.$scrollable.baseOffset;
        this.pointerPosition.update({ viewportX, viewportY, contentX });
      },
      { capture: true },
    );
    vp.addEventListener("pointerleave", () => {
      this.pointerPosition.update(null);
    });
  })();

  // @state
  private currentHeaderHeightPx: string = "";
  private _pendingFixedChildAppends = new Set<HTMLElement>();
  private readonly fixedChildBindings = new WeakMap<HTMLElement, object>();

  private size: Option<Size>;
  private sizeGate = new SizeGate();
  onSizeChangeTarget = this.$contentViewport;
  onSizeChange: Option<(s: Size) => void> = (s: Size) => {
    const width = s.width || this.offsetWidth;
    const height = s.height || this.offsetHeight;
    // Hidden carousel/tab pages report 0x0 before the scroll surface can render.
    // Do not resolve the bind gate until the viewport has real dimensions.
    // No box means no scroll position: the next box starts at scrollLeft 0,
    // and a box appearing is when the model's position has to be put back.
    if (width <= 0 || height <= 0) {
      this.$scrollable.positionLost();
      return;
    }
    this.$scrollable.reassertPosition();
    // Set on the shield, not the host: a custom property inherits, and on
    // the host it would restyle the whole content subtree.
    const shield = this.$("wheel-shield");
    shield.style.setProperty("--wheel-shield-width", width + "px");
    shield.style.setProperty("--wheel-shield-height", height + "px");

    this.size = { width, height };
    this.sizeGate.resolve(this.size);
    if (this._scrollEngine && this.layoutProps && width > 0) {
      // Skip if the length hasn't changed — avoids redundant rebinds during
      // startup when legend measurement triggers multiple resize events.
      if (this.layoutProps.length === width) {
        this._scrollEngine.rebindViewport();
        return;
      }
      this.bindLayout(
        // A viewport-length change cannot change what an index means, so this
        // re-states the space already in force. Before the first `bindLayout`
        // there is none — unreachable behind the `layoutProps` guard above, and
        // identity is the right answer anyway for a consumer that never named
        // one.
        { ...this.layoutProps, length: width },
        this.#space ?? ScrollEngine.IndexSpace.identity(),
      );
      this._scrollEngine.rebindViewport();
    }
  };

  /**
   * Seed the size gate from a direct measurement when no ResizeObserver
   * notification has arrived yet — the twin of
   * `SheetElement.seedSizeFromMeasurement`. ResizeObserver callbacks run in
   * the "update the rendering" step, so a document that is not being rendered
   * (a background tab, a frame-starved preview) gets none, and `bind` /
   * `bindIndex` waited on the gate with no other way to fill it. Measures the
   * observed element (`onSizeChangeTarget`), once per bind and only while the
   * size is unset. The zero guard is the one `onSizeChange` applies: a
   * viewport under `display: none` measures 0x0 and stays unresolved.
   */
  private seedSizeFromMeasurement(): void {
    if (this.size != null) return;
    if (!this.isConnected) return;
    const width = this.$contentViewport.offsetWidth;
    const height = this.$contentViewport.offsetHeight;
    if (width <= 0 || height <= 0) return;
    this.onSizeChange?.({ width, height });
  }

  private popoverInfo: Option<{
    popover: PopoverInfo;
    location: "body" | "header" | "footer";
  }>;
  renderDebugPopoverInfo() {
    const eligibleToShow = this.props?.canShowDebugPopover?.get();
    const info = this.popoverInfo;
    if (eligibleToShow && info) {
      let $overlay: ScrollLayoutSnapshotOverlay =
        info.location === "header"
          ? this.$headerDebugOverlay.get()
          : this.$debugOverlay.get();
      const snapshot = this.scrollPopoverDelegate.layoutSnapshot(info.location);
      const spaceRemaining = info.popover.spaceRemaining(snapshot.viewportInfo);

      const { x, y, width, height } = snapshot.viewportInfo;
      $overlay.assignStyles({
        display: "block",
        left: x + "px",
        top: y + "px",
        width: width + "px",
        height: height + "px",
        "--overlay-bg": "var(--blue-dimmed)",
        "--overlay-bg-opacity": "0.3",
        borderRadius: "24px",
        "--border-radius": "24px",
      });
      $overlay.bind({
        viewportInfo: snapshot.viewportInfo,
        point: spaceRemaining,
      });
    } else {
      this.$debugOverlay.maybeGet()?.style.setProperty("display", "none");
      this.$headerDebugOverlay.maybeGet()?.style.setProperty("display", "none");
    }
  }

  private scrollPopoverDelegate: ScrollPopover.Delegate = {
    appendFixedChild: ($e, location, index, onOffsetChange) => {
      this._appendFixedChild($e, location);
      return this.scrollEngine.fixed.setFixedChildIndex(
        $e,
        index,
        (_$e, offsetX) => onOffsetChange(offsetX),
        false,
      );
    },
    layoutSnapshot: (location) => {
      const viewportSize = {
        width:
          this.scrollEngine.viewport.props.length -
          this.scrollEngine.viewport.props.startOccludedPx -
          this.scrollEngine.viewport.props.endOccludedPx,
        height: this.$("content-viewport").offsetHeight,
      };
      const headerHeight = this.headerPeek.height;
      const scrollHeight =
        this.scrollHeightSnapshot ?? this.$("content-viewport").scrollHeight;

      const visibleHeight = viewportSize.height - headerHeight;
      const bodyScrollHeight = scrollHeight - headerHeight;
      const overlayHeight = Math.max(visibleHeight, bodyScrollHeight);
      return new ScrollLayoutSnapshot({
        viewportStartOffset:
          this.scrollEngine.viewport.visible.offsetStart +
          this.$scrollable.baseOffset,
        viewportSize,
        scrollHeight,
        headerHeight,
        footerHeight: this.footerHeight ?? 0,
        bodyHeight:
          this.bodyHeight != null
            ? Math.max(this.bodyHeight + 68, viewportSize.height - headerHeight)
            : overlayHeight,
        location,
        scrollTop: this.listScrollTop,
      });
    },
    getAnchorFrame: (index) => ({
      left:
        this.scrollEngine.window.getOffset(index)! -
        this.scrollEngine.viewport.visible.offsetStart,
      width: this.scrollEngine.cellWidth.get(index),
    }),
    onPopoverInfoChange: (info) => {
      this.popoverInfo = info;
      this.renderDebugPopoverInfo();
    },
  };
  readonly popoverController = new ScrollPopover.Controller(
    this.scrollPopoverDelegate,
  );
  readonly tooltipController = new ScrollTooltip.Controller(
    this.scrollPopoverDelegate,
  );

  /*
   Constructor/Bind
   =============================================================================
  */
  /**
   * Bind content every frame up to a wall-clock deadline instead of holding it:
   * while either axis moves, the engine drain and the calendar strip queue stop
   * at {@link FRAME_DEADLINE_MS} after the frame opened (whatever already ran in
   * the frame counts), visible columns first, then by distance in the direction
   * of travel; one bind per frame always runs. On by default since dom-perf
   * 49 (the operator's flip of 2026-10-12); the lona row turns it off.
   */
  static readonly FRAME_DEADLINE = "scroll-frame-deadline";
  /**
   * Content budget per frame, measured from the frame's flush. The deadline
   * counts wall clock from the flush, so script that already ran in the frame
   * shrinks it, but the native style, layout and paint that follow the script
   * do not: on the M4 a placing frame spends 9-12 ms there under a calendar
   * gesture (CPU-profiler self time per steady frame). 16.7 - 10 - ~1 ms
   * margin leaves ~6 ms, below the settled 8 ms ledger, so a frame's script
   * and native work can fit one vsync instead of two.
   */
  static readonly FRAME_DEADLINE_MS = 6;
  /**
   * The content budget in whole milliseconds (`?flag:scroll-frame-deadline-ms=8`
   * or the stored page value), for measuring other budgets on one bundle;
   * absent, {@link FRAME_DEADLINE_MS}. Read through {@link frameDeadlineMs}, so
   * the page reports the budget it runs.
   */
  static readonly FRAME_DEADLINE_MS_FLAG = "scroll-frame-deadline-ms";
  static frameDeadlineMs(): Option<number> {
    if (!DomFlags.read(ScrollHorizontal.FRAME_DEADLINE, true)) return null;
    return DomFlags.readCount(ScrollHorizontal.FRAME_DEADLINE_MS_FLAG, ScrollHorizontal.FRAME_DEADLINE_MS);
  }
  /**
   * Keep recycled columns keyed by the index they last showed, so a fling back
   * over dates shown moments ago reattaches the columns that showed them, with
   * their content, instead of retargeting LIFO spares that showed other dates
   * (tento-scroll-js `ScrollEngine.Pool`). The pool grows to
   * {@link COLUMN_RETENTION_SPARES} spares (or `scroll-column-retention-spares`);
   * parked spares stay rendered and are hidden by their park marks. On by
   * default; the lona row turns it off.
   */
  static readonly COLUMN_RETENTION = "scroll-column-retention";
  /**
   * The default retention pool, K = 20 spares: every parked spare's subtree stays in the style tree, so the pool is
   * sized for a fling back's hits at a fraction of the active-style cost of a pool four visible lengths long.
   */
  static readonly COLUMN_RETENTION_SPARES = 20;
  /**
   * The retention pool's size, a whole number (default
   * {@link COLUMN_RETENTION_SPARES}). Every parked spare keeps its column's
   * shadow roots in the document, and a style update that has active style
   * to update walks them all, so a smaller pool makes every frame cheaper
   * and keeps fewer dates for a fling back.
   */
  static readonly COLUMN_RETENTION_SPARES_FLAG = "scroll-column-retention-spares";
  static columnRetention(): number {
    if (!DomFlags.read(ScrollHorizontal.COLUMN_RETENTION, true)) return 0;
    return DomFlags.readCount(ScrollHorizontal.COLUMN_RETENTION_SPARES_FLAG, ScrollHorizontal.COLUMN_RETENTION_SPARES);
  }
  /**
   * Host-only park marks: the `[recycled]` mark hides a column
   * with non-inherited properties only (opacity and a full clip, which also
   * removes it from hit-testing) instead of `pointer-events: none`. An
   * inherited property on the mark changes every descendant's computed style,
   * so each recycle and each reattach restyled the column's whole subtree;
   * with retention the reattached columns carry their full content, and that
   * restyle dominated a return fling's style recalculation. With
   * non-inherited properties a toggle restyles the host alone. On by
   * default; the lona row turns it off. Read once per page.
   */
  static readonly PARK_HOST_ONLY = "scroll-park-host-only";
  static parkHostOnly(): boolean {
    return DomFlags.read(ScrollHorizontal.PARK_HOST_ONLY, true);
  }
  initialize(delegate: ScrollHorizontal.Delegate<Header, Body, Footer>) {
    this.scrollNotificationGeneration++;
    this.delegate = delegate;
    this._scrollEngine = new ScrollEngine(
      this.$scrollable,
      this.scrollEngineDelegate(delegate),
    );
    this.style.setProperty("--base-offset", this.$scrollable.baseOffset + "px");
    if (ScrollHorizontal.parkHostOnly()) this.toggleAttribute("park-host-only", true);
    // Keeps the listScrollTop skip-cache truthful; clamping from content
    // resizes also fires here. Layout is clean when the event is dispatched,
    // but the scrollable's own listener (added in its constructor, so it runs
    // first) recycles columns inside the event, so a scrollTop read here
    // would force their layout: take the position it read.
    this.$("content-viewport").addEventListener(
      "scroll",
      (e) => {
        this._lastListScrollTop = this.$scrollable.positionAt(e)?.top ?? (e.target as HTMLElement).scrollTop;
      },
      { passive: true },
    );
  }

  connectedCallback() {
    super.connectedCallback();
    // Reversible detach (see `disconnectedCallback`): a reappended scroller
    // keeps its engine; any bind or visible-range debt queued at detach time
    // drains again under the engine's new lifecycle epoch.
    this._scrollEngine?.resume();
  }

  disconnectedCallback() {
    // A detached element keeps no scroll position; see `onSizeChange`.
    this.$scrollable.positionLost();
    this.scrollBindRevision++;
    this.scrollBodyRevision++;
    this.resetHeaderSweeps();
    this.bindDrainListeners.clear();
    this._scrollEngine?.dispose();
    super.disconnectedCallback();
    this.settleWaiters.cancelAll();
    this.props?.canShowDebugPopover?.removeListener(this);
  }

  async bind(props: {
    collectionId: string;
    contextDirtied: boolean;
    layout: {
      cellWidthPx: number;
      leftOccludedPx: number;
      rightOccludedPx: number;
    };
    scroll: ScrollHorizontal.Props;
  }) {
    this.seedSizeFromMeasurement();
    const size = await this.sizeGate.waitForSize();
    this.bindLayout(
      {
        startOccludedPx: props.layout.leftOccludedPx,
        endOccludedPx: props.layout.rightOccludedPx,
        length: size.width,
        cellWidthPx: props.layout.cellWidthPx,
      },
      // This entry point takes no space from its caller, and a consumer that
      // never names one is a consumer whose indices ARE its content. On the
      // first layout there is no outgoing window to carry an anchor out of
      // anyway; a caller with a real index space drives `bindLayout` directly
      // (`SheetLayout`).
      this.#space ?? ScrollEngine.IndexSpace.identity(),
    );
    this.bindScroll(props.scroll);
    this.bindIndex(0, props.collectionId, false, props.contextDirtied);
  }

  /** Rebind the geometry, in the index space `space` names — see
   *  {@link ScrollEngine.bindLayout}, which owns what a space change costs. */
  bindLayout<K extends ScrollEngine.ContentKey>(
    props: ScrollEngine.LayoutProps,
    space: ScrollEngine.IndexSpace<K>,
  ): void {
    // Geometry equality is only half the question, so this fast path answers
    // both halves or it does not fire. It used to short-circuit on pixels
    // alone, returning before the engine was ever consulted: week x 6 and
    // month x 6 resolve to the same column width, so the flip between them
    // never reached `ScrollEngine.bindLayout` and the raw index survived into a
    // space where it named a different date (week 38 became month 38, three
    // years out). The engine's own space is the authority on the other half —
    // this component's `#space` records what it was TOLD, which is the same
    // thing right up until a rebind it skipped.
    if (
      this.layoutProps &&
      this.layoutProps.cellWidthPx === props.cellWidthPx &&
      this.layoutProps.startOccludedPx === props.startOccludedPx &&
      this.layoutProps.endOccludedPx === props.endOccludedPx &&
      this.layoutProps.length === props.length &&
      space.key === this.scrollEngine.space?.key
    ) {
      return;
    }
    Tracing.info("ui")("core/sheet-scroll/bind/layout-props", this.size);
    this.layoutProps = props;
    this.#space = space;
    this.scrollEngine.bindLayout(props, space);
    this.bindLayoutStyles(props, this.size?.width ?? null);
  }

  /** A full bind with a declared destination does not visit the old anchor. */
  bindLayoutAt<K extends ScrollEngine.ContentKey>(
    props: ScrollEngine.LayoutProps,
    space: ScrollEngine.IndexSpace<K>,
    index: number,
    collectionId: string,
    animate: boolean,
  ): void {
    if (!ScrollEngine.isAddressableAnchor(index)) {
      throw new Error(`Unaddressable layout anchor: ${index}`);
    }
    this.layoutProps = props;
    this.#space = space;
    this.collectionId = collectionId.slice(0, 4);
    this.scrollEngine.bindLayoutAt(props, space, index, {
      kind: "reanchor",
      at: {
        position: "start",
        scrollBehavior: animate ? "auto" : "instant",
        useNativeScrollTo: false,
      },
      viewportChangeSource: "bind",
    });
    // The parent supplied measured geometry; the child's first ResizeObserver
    // delivery may still be pending (and later take its equal-width fast path).
    this.bindLayoutStyles(props, props.length);
  }

  private bindLayoutStyles(props: ScrollEngine.LayoutProps, viewportWidth: Option<number>): void {
    $$.mutate(() => {
      // Engine callbacks may synchronously install a successor layout. Its
      // geometry owns the eventual write, even when the old bind unwinds last.
      if (this.layoutProps !== props) return;
      // The cell width is NOT published as a host custom property. Every
      // bound column carries its width inline (bindColumnComponent, always a
      // number), and a width change re-emits every column anyway
      // (scrollEngine.bindLayout → emit.all "layout-changed"), so the
      // property had no reader. It still had a cost: a custom property
      // written on this host — an ancestor of every slotted cell —
      // invalidates the whole subtree, measured at ~5.8k elements / ~230ms
      // per write on the calendar sheet, once per day↔week switch. Visible
      // width changes on sidebar resizes too; only the static anchors need it.
      this.style.setProperty("--sidebar-width", props.startOccludedPx + "px");
      this.setStaticAnchorWidth(viewportWidth != null
        ? viewportWidth - props.startOccludedPx - props.endOccludedPx + "px"
        : "");
    });
  }

  private setStaticAnchorWidth(width: string): void {
    for (const $anchor of [this.$staticAnchorHeader, this.$staticAnchorBody, this.$staticAnchorFooter]) {
      $anchor.style.width = width;
    }
  }

  bindScroll(props: ScrollHorizontal.Props): void {
    const revision = ++this.scrollBindRevision;
    const bodyRevision = ++this.scrollBodyRevision;
    // Remove listener from previous props before replacing
    this.props?.canShowDebugPopover?.removeListener(this);
    this.props = props;

    this.props.canShowDebugPopover?.addListener(this, () =>
      this.renderDebugPopoverInfo(),
    );
    const apply = (height: Option<number>): void => {
      $$.mutate(() => {
        if (this.scrollBindRevision !== revision) return;
        this.headerPeek.setHeight(props.headerHeight, false);
        // A drag-resize may have supplied a newer body height while this full
        // request was queued. Its header/footer still belong to this request.
        if (this.scrollBodyRevision === bodyRevision && height != null) {
          this.bodyHeight = height;
          // Gecko augments this height in its stylesheet calc.
          this.$("content").style.setProperty("--content-body-height", height + "px");
        }
        this.footerHeight = props.footerHeight ?? null;
        const footerH = props.footerHeight ? props.footerHeight + 2 + "px" : "";
        this.$("footers").style.height = footerH;
        this.$("footer-sidebar").style.height = footerH;
        if (IS_GECKO) {
          // Gate the Firefox-only inline-block layout path (see IS_GECKO and the
          // #content comment in $style). Blink keeps the untouched inline-table
          // path. `has-footer` triggers the taller-#content rule that reserves
          // the footer's bottom space block flow doesn't. Idempotent.
          this.setAttribute("engine", "gecko");
          this.toggleAttribute("has-footer", !!props.footerHeight);
        }
      });
    };
    if (props.scrollContentHeight != null) {
      // Explicit geometry needs no measurement of the outgoing DOM.
      apply(props.scrollContentHeight);
    } else {
      $$.measure(() => {
        if (this.scrollBindRevision !== revision) return;
        if (this.scrollBodyRevision !== bodyRevision) {
          apply(null);
          return;
        }
        const height = this.$("content-viewport").scrollHeight;
        this.scrollHeightSnapshot = height;
        apply(height);
      });
    }
  }

  /**
   * Lightweight scroll height update that skips the $$.measure() phase.
   * Used during drag resize to avoid forced layout from scrollHeight reads.
   */
  bindScrollHeightOnly(scrollContentHeight: number): void {
    this.scrollBodyRevision++;
    this.bodyHeight = scrollContentHeight;
    this.$("content").style.setProperty(
      "--content-body-height",
      scrollContentHeight + "px",
    );
  }

  async bindIndex(
    index: Option<number>,
    collectionId: string,
    animate: boolean,
    contextDirtied: boolean,
    skipScroll: boolean = false,
  ) {
    Tracing.info("ui")("core/sheet-scroll/bind/index", index);
    // The collection is known NOW, not when the size gate opens. A hidden page
    // (0x0 until it is shown) keeps the gate shut for as long as it stays
    // hidden, and the engine drains binds meanwhile (`bindLayout` →
    // layout-changed): every one of them stamps `this.collectionId` onto its
    // column. Assigned after the await, the drain ran with no id, the columns
    // were painted without a `cid`, and the header sweep escalated them as
    // `unbound` (ux corpus, frame-starved hidden page). Same order as
    // `bindLayoutAt`.
    collectionId = collectionId.slice(0, 4);
    this.collectionId = collectionId;
    this.seedSizeFromMeasurement();
    const size = await this.sizeGate.waitForSize();
    $$.mutate(() => {
      const props = this.layoutProps;
      if (!props) return;
      this.setStaticAnchorWidth(size.width - props.startOccludedPx - props.endOccludedPx + "px");
    });
    // The one call site where the kind is data, not a constant: this wrapper's
    // two booleans ARE the 2x2 that `IndexBind` names. `contextDirtied` decides
    // whether content is dirtied and re-emitted; `skipScroll` decides whether
    // the view moves — and, when content is dirtied, whether the map is
    // re-origined (only the moving case re-anchors).
    const at: ScrollEngine.RevealAt = {
      position: "start",
      scrollBehavior: animate ? "auto" : "instant",
      useNativeScrollTo: false,
    };
    const bind: ScrollEngine.IndexBind = contextDirtied
      ? (skipScroll
        ? { kind: "refresh", viewportChangeSource: "bind" }
        : { kind: "reanchor", at, viewportChangeSource: "bind" })
      : (skipScroll
        ? { kind: "reconcile", viewportChangeSource: "bind" }
        : { kind: "reveal", at, viewportChangeSource: "bind" });
    this.scrollEngine.bindIndex(index ?? 0, bind);
  }

  private assertChildren() {
    // Pending-bind ≠ strand. A mid-rebind reconcile (e.g. a resize firing a
    // second bindLayout) pulls pooled entries back into entries._all with their
    // cid cleared and their bind queued for the NEXT frame; running the strand
    // check now false-flags them and toggles [recycled] (opacity:0) for one
    // frame — the visible resize flicker, and a violation of scroll north-star
    // N3 ("never paint empty when prior content exists"). Skip while binds are
    // pending: the batch's own onBatchComplete re-runs this once drained, with
    // every cid set. Genuine strands (batcher empty, bad cid) still reach the
    // checks below.
    if (this.scrollEngine.hasPendingBinds) return;
    const currentCid = this.collectionId ?? null;
    const currentMismatched = new Set<number>();
    for (const entry of this.scrollEngine.entries.all) {
      const { $header, $body, $footer } = entry.t;

      const headerCid = BoundCollection.of($header);
      const bodyCid = BoundCollection.of($body);

      if (headerCid !== currentCid) {
        currentMismatched.add(entry.index);
        // `healed=true` means a self-heal emit was ALREADY spent on this index
        // and it is still mismatched — the heal was dropped (generation gate)
        // or its bind never landed, so no further emit is coming.
        Tracing.info("ui")(
          "core/sheet-scroll/assert",
          `header cid mismatch: ${headerCid ?? ""} !== ${currentCid ?? ""}, index: ${entry.index}, healed: ${this.healAttempted.has(entry.index)}`,
        );
        // Only toast when this index was already mismatched on the previous
        // assert — i.e. it failed to self-heal — so transients stay quiet.
        if (
          Globals.isServiceAccount &&
          this.prevMismatchedIndices.has(entry.index)
        ) {
          Toast.error("sheet/recycling/mismatch", {
            description: `header cid mismatch: ${headerCid ?? ""} !== ${currentCid ?? ""}, index: ${entry.index}`,
          });
        }
        // No cid = rendered but unbound (a transient strand): force a clean
        // rebind of whatever occupies this index next frame, once per index.
        // A present-but-different cid is a genuine stale binding — hide only.
        if (headerCid == null && !this.healAttempted.has(entry.index)) {
          this.healAttempted.add(entry.index);
          this.scrollEngine.emit.index(entry.index);
        }
        $header.toggleAttribute("recycled", true);
      }
      if (bodyCid !== currentCid) {
        Tracing.info("ui")(
          "core/sheet-scroll/assert",
          `body cid mismatch: ${bodyCid ?? ""} !== ${currentCid ?? ""}, index: ${entry.index}, healed: ${this.healAttempted.has(entry.index)}`,
        );
        $body.toggleAttribute("recycled", true);
      }
      if ($footer) {
        const footerCid = BoundCollection.of($footer);
        if (footerCid !== currentCid) {
          $footer.toggleAttribute("recycled", true);
        }
      }
    }
    this.prevMismatchedIndices = currentMismatched;
  }

  // DIAG(header-blank): at most one pending sweep. A drain and a settle can both
  // request one in the same frame; they must not each pay for a geometry pass.
  private headerSweepScheduled = false;
  private headerSweepEpoch = 0;

  // DIAG(header-blank): a violation seen by ONE sweep can be a legitimate
  // mid-pipeline window (marked at bind start, bound a few frames later) — only
  // one that SURVIVES in the same generation is a strand. Keyed `gen:kind:index`.
  private prevHeaderViolations = new Set<string>();

  // When the last pending-layout MARK pass ran (negative infinity = never):
  // the sweep refuses to escalate violations younger than the grace window,
  // because a slow bind legitimately holds its marks while its gates resolve.
  private lastPendingLayoutMarkMs: number = Number.NEGATIVE_INFINITY;

  // DIAG(header-blank): the settle callback is once-per-request, so a column
  // stranded AFTER the last settle would never be re-inspected. Each scheduled
  // sweep re-arms this trailing pass; it fires only when the pipeline has been
  // quiet for the debounce window — the second strike for a permanent strand.
  private headerSweepTrailingTimer: Option<number> = null;

  // Clock for the header sweep's ages and timers (mark age, held-installation
  // age, the trailing / confirm re-arms). Null = the real clock; a test sets a
  // virtual one (the `Tracing.Witness.WatchdogClock` seam) to drive the
  // confirm ladder without waiting on wall time.
  private headerSweepClock: Option<Tracing.Witness.WatchdogClock> = null;

  // When the sweep first saw the live generation's bind installation barrier
  // held (`ScrollEngine.bindInstallationPending`), on the sweep clock. A queued
  // live bind excuses a marked column only while its drain can make progress;
  // a barrier held past {@link HELD_INSTALLATION_EXCUSE_MS} no longer does.
  private installationHeldSince: Option<{ readonly gen: BindGeneration; readonly atMs: number }> = null;

  // The bind generation whose strand the sweep has already tried to heal. One
  // attempt per generation, ever: the heal issues binds, whose drain schedules
  // another sweep, so an ineffective heal would otherwise re-arm itself every
  // ~600ms for the life of the sheet. -1 = no generation healed yet (the engine
  // starts at 0, and a heal is a no-op before the engine exists).
  private headerHealAttemptedGen: number = -1;

  private get sweepClock(): Tracing.Witness.WatchdogClock {
    return this.headerSweepClock ?? SYSTEM_SWEEP_CLOCK;
  }

  private resetHeaderSweeps(): void {
    this.headerSweepEpoch++;
    this.headerSweepScheduled = false;
    this.prevHeaderViolations.clear();
    this.installationHeldSince = null;
    if (this.headerSweepTrailingTimer != null) this.sweepClock.clearTimeout(this.headerSweepTrailingTimer);
    this.headerSweepTrailingTimer = null;
  }

  /**
   * The engine's pending-predicate operands for the `scroll/when-settled`
   * record (`scroll-pending/v1`), captured in the authoritative settle
   * callback so initial-document waits are covered too. Diagnostic only:
   * `diagnosticPendingBinds` reads fields, never a layout or the queue, and
   * its failure is explicit ("unavailable") rather than suppressing the
   * settle record. Built once per settle, like every other attribute of the
   * record (`Tracing.log` takes values, not thunks). The schema carries only
   * operands with a source: a field for the owners of background debt waits
   * for `FrameBudget` to name them, as `scroll-pending/v2`.
   */
  private pendingBindsSnapshot(): Record<string, unknown> {
    try {
      const capturedAt = performance.now();
      const snapshot = this.scrollEngine.diagnosticPendingBinds();
      return {
        status: "captured",
        schema: "scroll-pending/v1",
        timeOrigin: performance.timeOrigin,
        capturedAt,
        ...snapshot,
        captureDurationMs: performance.now() - capturedAt,
      };
    } catch {
      return { status: "unavailable", schema: "scroll-pending/v1" };
    }
  }

  /**
   * Queue a header-invariant sweep for the NEXT frame's read phase: `mutateEnd`
   * lands after this frame's writes, and the `measure` it queues runs once the
   * browser has committed them. So the sweep never forces a synchronous layout,
   * and never reports a column whose clearing write is still queued.
   */
  private scheduleHeaderInvariantSweep(context: string): void {
    const engine = this._scrollEngine;
    if (!engine) return;
    const generation = engine.currentBindGeneration;
    const epoch = this.headerSweepEpoch;
    const current = () => this._scrollEngine === engine &&
      engine.currentBindGeneration === generation && this.headerSweepEpoch === epoch;
    if (this.headerSweepTrailingTimer != null) {
      this.sweepClock.clearTimeout(this.headerSweepTrailingTimer);
    }
    this.headerSweepTrailingTimer = this.sweepClock.setTimeout(() => {
      if (!current()) return;
      this.headerSweepTrailingTimer = null;
      $$.measure(() => { if (current()) this.sweepHeaderInvariants("trailing"); });
    }, 600);
    if (this.headerSweepScheduled) return;
    this.headerSweepScheduled = true;
    $$.mutateEnd(() =>
      $$.measure(() => {
        if (!current()) return;
        this.headerSweepScheduled = false;
        this.sweepHeaderInvariants(context);
      }),
    );
  }

  /**
   * Report first, then — on a quiesce pass only — repair what the DOM alone
   * can diagnose. Columns that occupy the horizontal viewport while still
   * carrying a "not painted yet" marker are the defect: `pending-layout` and
   * `recycled` are cleared only by a successful bind (the `onBind` finally),
   * so a column whose clearing bind was lost stays `visibility: hidden` for
   * the life of the sheet — a permanent blank band in the header.
   *
   * Every context except a quiesce pass is strictly read-only, and even the
   * quiesce passes emit their `scroll/header-violation` breadcrumb BEFORE
   * healing, so the UX specs still trip on the defect they were written for.
   * The heal covers TRACKED indices only and goes through the engine's bind
   * pipeline (`emit.index`) — never a direct attribute write — so the markers
   * are cleared by the same `onBind` that gives the column its content.
   * Strands at indices the engine does not track are reported, never repaired
   * from here: an uncovered viewport is the engine's own invariant
   * (`ScrollEngine.enforceViewportCoverage`, checked at every batch quiesce),
   * and this sweep is its independent DOM-truth tripwire — repairing an
   * engine-coverage bug from the DOM side would hide it.
   * See {@link healHeaderStrand}.
   */
  private sweepHeaderInvariants(context: string): void {
    const engine = this._scrollEngine;
    if (!engine) return;
    const viewportWidth = window.innerWidth;
    // DIAG(header-blank): ground truth of the header strip at quiesce — the
    // per-column geometry/state a remote session cannot otherwise show. One
    // compact row per in-viewport slotted header column: [idx, left, width,
    // HEIGHT, pending, recycled, visible, hasCid, cellCount, zeroHeightCells,
    // ridCells]. Height + per-cell facts joined 2026-08-06: the operator's
    // live break was columns painted-and-covering (all earlier fields healthy)
    // whose CELLS were 0px tall — recycle zeroes `--height` and a skipped
    // rebind never restores it — which a width-only row cannot see. Emitted
    // only on the `trailing` pass (once per quiesce), capped, so a healthy
    // session costs one small breadcrumb per interaction pause.
    if (context === "trailing") {
      const cols: number[][] = [];
      for (const $child of [...this.children]) {
        if (!($child instanceof HTMLElement)) continue;
        if ($child.getAttribute("slot") !== "header") continue;
        const rect = $child.getBoundingClientRect();
        if (!(rect.width > 0 && rect.right > 0 && rect.left < viewportWidth)) {
          continue;
        }
        if (cols.length >= 24) break;
        const style = getComputedStyle($child);
        let cellCount = 0;
        let zeroHeightCells = 0;
        let ridCells = 0;
        for (const $cell of $child.children) {
          if (!($cell instanceof HTMLElement)) continue;
          cellCount++;
          // MEASURED, branded: the pixels, not `$cell.height` (which is the
          // last bind's claim and can agree with a dead column — seam 10).
          if (
            CellHeight.isDeadOnScreen(
              MeasuredHeightPx.of($cell.getBoundingClientRect().height),
            )
          ) {
            zeroHeightCells++;
          }
          if ($cell.hasAttribute("rid")) ridCells++;
        }
        cols.push([
          ScrollHorizontal.columnIndexOf($child),
          Math.round(rect.left),
          Math.round(rect.width),
          Math.round(rect.height),
          $child.hasAttribute("pending-layout") ? 1 : 0,
          $child.hasAttribute("recycled") ? 1 : 0,
          style.visibility === "visible" && style.opacity !== "0" ? 1 : 0,
          BoundCollection.of($child) != null ? 1 : 0,
          cellCount,
          zeroHeightCells,
          ridCells,
        ]);
      }
      const range = engine.hasViewport
        ? engine.viewport.visible.indexRange
        : null;
      Tracing.log("header/dom-truth", {
        gen: engine.currentBindGeneration,
        iw: viewportWidth,
        dpr: window.devicePixelRatio,
        range: range == null ? null : [range.start, range.end],
        cols,
      });
    }
    const pendingLayout: number[] = [];
    const recycled: number[] = [];
    const unbound: number[] = [];
    const zeroHeight: number[] = [];
    // INV(zero-height): a VISIBLE header column whose every non-hidden cell
    // measures 0px tall is bound-looking but dead — the 2026-08-06 operator
    // break signature (scrub/recycle zeroed the heights, an honored render
    // skip never restored them, and no marker-based kind above can see it:
    // pending=0, recycled=0, cid+rid present). Hidden cells legitimately
    // measure 0 (the reflow path hides null-layout cells), so only non-hidden
    // cells count, and a column with no countable cells is not a violation.
    //
    // The height read here is {@link MeasuredHeightPx} — the sweep is the
    // DOM-TRUTH tripwire, so it is entitled to the pixels and to nothing else
    // (seam 10). It runs inside a `$$.measure`, where layout is already read.
    const allCellsZeroHeight = ($col: HTMLElement): boolean => {
      let countable = 0;
      for (const $cell of $col.children) {
        if (!($cell instanceof HTMLElement)) continue;
        if ($cell.hasAttribute("hidden")) continue;
        if ($cell.style.display === "none") continue;
        countable++;
        const measured = MeasuredHeightPx.of(
          $cell.getBoundingClientRect().height,
        );
        if (!CellHeight.isDeadOnScreen(measured)) return false;
      }
      return countable > 0;
    };
    const tracked = new Set<HTMLElement>();
    // Indices the engine still owns an entry for. A persistent violation at a
    // tracked index has a known occupant to re-emit; one at an UNtracked index
    // is a stranded pool column no per-index bind can reach — report-only
    // here, because an uncovered viewport is the engine's own invariant
    // (enforceViewportCoverage repairs it at batch quiesce, long before this
    // sweep's escalation ladder would fire).
    const trackedIndices = new Set<number>();
    const inViewport = ($e: HTMLElement): boolean => {
      const rect = $e.getBoundingClientRect();
      return rect.width > 0 && rect.right > 0 && rect.left < viewportWidth;
    };
    for (const entry of engine.entries.all) {
      // onCreate always produces a header for an entry; a missing one means the
      // occupant map is corrupt — surface it rather than skip it.
      const $header = nonnull(
        entry.t.$header,
        "ScrollHorizontal.sweepHeaderInvariants: entry.t.$header",
      );
      tracked.add($header);
      trackedIndices.add(entry.index);
      // Record queued marks too. The escalation gate below distinguishes
      // runnable live binds from stale binds and a stalled installation barrier.
      // Skipping here would bypass that bounded-progress check entirely.
      // A TRACKED entry must never sit at the pool park: the park is only
      // legitimate for a column with no engine entry. One here is an occupant
      // pulled back out of the pool whose bind never landed — it is off-screen
      // by construction, so the viewport gate below would silently drop it.
      // Report it (as `unbound`: the recycle cleared its cid) so the two-strike
      // ladder can heal it by index like any other tracked strand.
      if ($header.hasAttribute("pooled")) {
        unbound.push(entry.index);
        continue;
      }
      if (!inViewport($header)) continue;
      if ($header.hasAttribute("pending-layout")) {
        pendingLayout.push(entry.index);
      }
      if ($header.hasAttribute("recycled")) recycled.push(entry.index);
      // Only meaningful for a tracked entry: a pooled header legitimately
      // carries no collection marker until its next bind. And only once the
      // host HAS a collection — before that no bind can stamp one, so a
      // missing marker is the expected state, not a strand (the same
      // comparison `assertChildren` makes: null against null is bound).
      if (BoundCollection.of($header) == null) {
        if (this.collectionId != null) unbound.push(entry.index);
      }
      // Only flag zero-height on a column no other kind already owns: a
      // pending/recycled/unbound column is legitimately mid-pipeline at 0.
      else if (
        !$header.hasAttribute("pending-layout") &&
        !$header.hasAttribute("recycled") &&
        allCellsZeroHeight($header)
      ) {
        zeroHeight.push(entry.index);
      }
    }
    // Headers still slotted into the host that the engine no longer tracks — a
    // pooled column left painted at a live position has no entry to find it by.
    for (const $child of [...this.children]) {
      if (!($child instanceof HTMLElement)) continue;
      if ($child.getAttribute("slot") !== "header") continue;
      if (tracked.has($child)) continue;
      if (!inViewport($child)) continue;
      const index = ScrollHorizontal.columnIndexOf($child);
      if ($child.hasAttribute("pending-layout")) pendingLayout.push(index);
      if ($child.hasAttribute("recycled")) recycled.push(index);
    }
    const byKind: Array<[HeaderViolationKind, number[]]> = [
      ["pending-layout", pendingLayout],
      ["recycled", recycled],
      ["unbound", unbound],
      ["zero-height", zeroHeight],
    ];
    // Two-strike escalation, QUIESCE- and AGE-GATED. A batch-complete sweep
    // can land in the middle of a long sheet bind (cold boot, slow network:
    // the marks are applied at bind start, the size/layout gates are still
    // pending, and an unrelated small batch drains meanwhile) — two such
    // sweeps in a row are NOT evidence of a strand. Escalation to the
    // `scroll/header-violation` breadcrumb (the one the UX tests forbid)
    // therefore requires ALL of: a quiesce context (`trailing` /
    // `trailing-confirm` / settled — never batch-complete), a second sighting
    // (the two-strike memory), and marks older than the grace window (a bind
    // legitimately stalled at a gate keeps its marks for seconds). A quiesce
    // sweep that finds something it cannot yet escalate re-arms one confirm
    // pass timed past the grace window — a real strand is still there and
    // escalates then; a slow bind has cleared its marks and the confirm sweep
    // resets the memory.
    const current = new Set<string>();
    let persistentEscalated = 0;
    let persistentFound = 0;
    // Union of the escalated indices across kinds (a column usually violates
    // two at once) — the heal set, deduped so each index costs one bind.
    const escalatedIndices = new Set<number>();
    const gen = engine.currentBindGeneration;
    const nowMs = this.sweepClock.now();
    const sinceMarkMs = nowMs - this.lastPendingLayoutMarkMs;
    const quiesce =
      context === "trailing" ||
      context === "trailing-confirm" ||
      context.startsWith("settled");
    // QUEUE-IDLE BYPASS of the mark-age grace (2026-08-06 operator break): a
    // mark is a promise that its laying pass's re-emits will clear it, so with
    // the bind queue EMPTY at quiesce that promise is dead — no bind is coming
    // for ANY column, tracked or not. The age grace exists to protect marks
    // whose pass is stalled at a gate; but it is also STARVABLE: every mark
    // pass resets `lastPendingLayoutMarkMs`, and steady churn (weather data
    // re-marking on arrival) keeps `sinceMarkMs` forever young while an
    // orphaned co-hide (a sidebar-occlusion structural pass superseded by a
    // navigation) leaves fully-bound columns visibility:hidden for the life of
    // the sheet. Queue-idle is the precise, unstarvable signal.
    const queueIdle = !engine.hasPendingBinds;
    const mayEscalate = quiesce && (sinceMarkMs > 3000 || queueIdle);
    // UNTRACKED FAST PATH: an UNTRACKED stuck column (pooled, no engine entry)
    // that overlaps the viewport can never be cleared by an in-flight bind —
    // no bind is coming for it, by definition — so the mark-age grace is
    // meaningless for it. It escalates at the FIRST quiesce pass, because a
    // user actively clicking through sheets re-marks faster than the
    // grace+confirm ladder and the report would otherwise never fire
    // (2026-08-05 operator trail: identical flank cohort at trailing on two
    // consecutive sheets, zero escalations). The report matters doubly now:
    // an untracked strand surviving to a sweep means the engine's own
    // viewport-coverage invariant failed to repair it.
    const mayEscalateUntracked = quiesce;
    // A BIND STILL COMING is not a strand. `pending-layout` and `recycled` are
    // cleared by any completed bind (`onBind` finally / `bindColumnComponent`),
    // so a tracked column whose bind is queued at the live epoch still holds
    // the promise its mark is waiting on — only a frame-starved drain is late
    // (ux corpus returning-active-user c40: the leading overscan columns bound
    // last, 5.4 s after the mark at ~1 frame/s, and escalated at 4.4 s with
    // both binds queued). The age grace cannot tell late from lost; the queue
    // can. Held here, the sighting keeps re-arming the confirm pass until the
    // bind lands; a mark that outlives its bind escalates on the next pair.
    // `unbound` is the same promise: every completed bind stamps the `cid`
    // (`bindColumnComponent`), so a queued live bind is its pending clear too.
    // `zero-height` is not — a bind can land and leave the cells at 0px.
    //
    // QUEUED IS NOT RUNNABLE. The drain runs nothing while the generation's
    // bind installation barrier is held (`beginBindGeneration` until the
    // driver's `commitBindGeneration`), and a bind pass that throws leaves it
    // held. A queued bind behind a barrier that never lifts is a strand whose
    // confirm pass would otherwise re-arm every 600 ms for the life of the
    // sheet, logging `header-suspect` and never escalating. So a held barrier
    // excuses the sighting only for HELD_INSTALLATION_EXCUSE_MS from the first
    // sweep that saw it held — the same 3 s the mark-age grace gives a bind
    // stalled at its gates — and escalates through the path every other strand
    // takes after that.
    if (!engine.bindInstallationPending) this.installationHeldSince = null;
    else if (this.installationHeldSince?.gen !== gen) {
      this.installationHeldSince = { gen, atMs: nowMs };
    }
    const installationHeldMs = this.installationHeldSince == null
      ? 0
      : nowMs - this.installationHeldSince.atMs;
    const drainCanProgress = installationHeldMs < HELD_INSTALLATION_EXCUSE_MS;
    let stalledBehindInstallation = false;
    const bindComing = (kind: HeaderViolationKind, index: number): boolean => {
      if (kind !== "pending-layout" && kind !== "recycled" && kind !== "unbound") return false;
      if (!engine.hasLiveBindQueued(index)) return false;
      if (!drainCanProgress) stalledBehindInstallation = true;
      return drainCanProgress;
    };
    for (const [kind, indices] of byKind) {
      if (indices.length === 0) continue;
      const persistent: number[] = [];
      const fresh: number[] = [];
      for (const index of indices) {
        const key = `${gen}:${kind}:${index}`;
        current.add(key);
        if (this.prevHeaderViolations.has(key)) persistent.push(index);
        else fresh.push(index);
      }
      persistentFound += persistent.length;
      const escalating = persistent.filter((index) =>
        trackedIndices.has(index)
          ? mayEscalate && !bindComing(kind, index)
          : mayEscalateUntracked,
      );
      const held = persistent.filter((index) => !escalating.includes(index));
      if (escalating.length > 0) {
        persistentEscalated += escalating.length;
        for (const index of escalating) escalatedIndices.add(index);
        Tracing.log("scroll/header-violation", {
          kind,
          indices: escalating.slice(0, 20),
          gen,
          ctx: context,
        } satisfies HeaderViolationEvent);
      }
      if (fresh.length > 0 || held.length > 0) {
        // NOT named `scroll/header-violation-*`: the UX specs forbid that label
        // by substring, and a non-escalating sighting must not trip them.
        Tracing.log("scroll/header-suspect", {
          kind,
          indices: [...fresh, ...held].slice(0, 20),
          gen,
          ctx: context,
        });
      }
    }
    this.prevHeaderViolations = current;
    if (
      quiesce &&
      current.size > 0 &&
      persistentEscalated === 0 &&
      this.headerSweepTrailingTimer == null
    ) {
      // With the queue idle the confirm needs no grace runway — the second
      // strike only exists to rule out a sweep that raced a live drain.
      const delay = queueIdle ? 600 : Math.max(600, 3100 - sinceMarkMs);
      const epoch = this.headerSweepEpoch;
      const current = () => this._scrollEngine === engine &&
        engine.currentBindGeneration === gen && this.headerSweepEpoch === epoch;
      this.headerSweepTrailingTimer = this.sweepClock.setTimeout(() => {
        if (!current()) return;
        this.headerSweepTrailingTimer = null;
        $$.measure(() => { if (current()) this.sweepHeaderInvariants("trailing-confirm"); });
      }, delay);
    }
    if (persistentEscalated > 0) {
      if (stalledBehindInstallation) {
        // Why a column with its bind queued escalated anyway: the barrier the
        // drain waits on has not lifted within the excuse budget.
        Tracing.log("scroll/header-installation-held", {
          gen,
          heldMs: Math.round(installationHeldMs),
          ctx: context,
        });
      }
      Tracing.err("ui")(
        `scroll/header-invariant ctx=${context} gen=${gen} persistent=${persistentEscalated} pending-layout=${pendingLayout.length} recycled=${recycled.length} unbound=${unbound.length} zero-height=${zeroHeight.length}${stalledBehindInstallation ? ` installation-held=${Math.round(installationHeldMs)}ms` : ""}`,
      );
      // Dev mode is LOUD: a persistent header invariant is a rendering bug the
      // sweep is about to paper over — surface it where a developer cannot
      // miss it, then heal below (best-effort keep running for everyone).
      if (Globals.isServiceAccount) {
        Toast.error("scroll/header-invariant", {
          description: `persistent header violations (${persistentEscalated}): pending=${pendingLayout.length} recycled=${recycled.length} unbound=${unbound.length} zeroH=${zeroHeight.length} — healing`,
        });
      }
    } else if (current.size > 0) {
      Tracing.info("ui")(
        `scroll/header-invariant-transient ctx=${context} gen=${gen} found=${current.size} persistent=${persistentFound} pending-layout=${pendingLayout.length} recycled=${recycled.length} unbound=${unbound.length}`,
      );
    }
    // Repair strictly AFTER every diagnostic above has been emitted, from any
    // quiesce pass that escalated a strand — TRACKED indices only. Uncovered-
    // viewport strands (untracked pool columns under the user) are the
    // engine's own viewport-coverage invariant, repaired at batch quiesce
    // inside ScrollEngine; from the DOM side they stay report-only.
    if (quiesce && persistentEscalated > 0) {
      this.healHeaderStrand(engine, gen, escalatedIndices, trackedIndices);
    }
  }

  /**
   * Bounded re-emit for strands the DOM alone can diagnose, at indices the
   * engine still tracks. To every engine structure such a column reads
   * healthy — it has an entry, its binds drained — but the DOM says its
   * content never landed. The repair is one call per index to the engine's
   * public primitive: `emit.index` enqueues a FULL bind of the current
   * occupant at the LIVE generation, and the `onBind` finally clears the
   * markers itself — this method never touches an attribute.
   *
   * Escalated indices the engine does NOT track are counted and reported,
   * never repaired here. An untracked strand means the strip under the
   * viewport is not covered by live entries — that is the engine's own
   * viewport-coverage invariant (`ScrollEngine.enforceViewportCoverage`,
   * enforced at every batch quiesce), and this sweep is its independent
   * DOM-truth tripwire. Driving the engine's reconcile from out here would
   * paper over the engine bug the report exists to catch.
   *
   * One attempt per bind generation ({@link headerHealAttemptedGen}), and
   * only a TRACKED re-emit consumes it — an untracked-only escalation is
   * pure reporting and must not burn the generation's sole heal on nothing,
   * suppressing a later tracked strand in the same generation. A heal that
   * does not take is reported by the next sweep but never retried, so the
   * pipeline cannot loop.
   */
  private healHeaderStrand(
    engine: ScrollEngine<{
      $header: Header;
      $body: Body;
      $footer?: Option<Footer>;
    }>,
    gen: number,
    escalatedIndices: ReadonlySet<number>,
    trackedIndices: ReadonlySet<number>,
  ): void {
    if (this.headerHealAttemptedGen === gen) return;

    let trackedHeals = 0;
    let untracked = 0;
    for (const index of escalatedIndices) {
      if (trackedIndices.has(index)) {
        engine.emit.index(index);
        trackedHeals += 1;
      } else {
        untracked += 1;
      }
    }
    if (trackedHeals > 0) {
      this.headerHealAttemptedGen = gen;
      // DOM-visible repair counter (shared with the batch-complete orphan
      // path): trails evict fast, so remote diagnosis reads the host itself.
      this.dataset.orphanReemits = String(
        Number(this.dataset.orphanReemits ?? "0") + 1,
      );
    }

    // Breadcrumb only when something was actually healed: an untracked-only
    // pass is pure reporting (and re-enters every sweep, since it leaves the
    // generation's attempt unspent) — its counts already ride the
    // `scroll/header-violation` diagnostics above.
    if (trackedHeals > 0) {
      Tracing.log("scroll/header-heal", {
        gen,
        tracked: trackedHeals,
        untracked,
      });
      Tracing.info("ui")(
        `scroll/header-heal gen=${gen} tracked=${trackedHeals} untracked=${untracked}`,
      );
    }
  }

  /**
   * The index a column last bound to, recovered from the `--idx` custom property
   * written on every bind. -1 when the column has never bound — it still counts
   * as a violation, we just cannot name its index.
   */
  private static columnIndexOf($c: HTMLElement): number {
    const parsed = Number.parseInt($c.style.getPropertyValue("--idx"), 10);
    return Number.isNaN(parsed) ? -1 : parsed;
  }

  /*
   Background Api
   =============================================================================
  */

  /**
   * Hide/show the whole content viewport (headers + bodies + sidebar)
   * via opacity on `#content-viewport`. The sheet host calls (false) synchronously on
   * a full-rebind sheet change — co-hiding content with the legend so
   * no stale old-sheet cells stay painted (gap G3) — and (true) at
   * reveal time together with `legend-ready`; the app main-reconciler
   * uses it for fullscreen/null-state presentation.
   */
  toggleContentVisibility(force: Option<boolean>, _animate: boolean): void {
    // Opacity is local to this box. An inherited custom property on the host
    // made every hide/reveal invalidate styles throughout all slotted columns.
    this.$("content-viewport").style.opacity = force ? "1" : "0";
  }

  /**
   * Toggle `pending-layout` on every currently-rendered column (its header,
   * body, and footer). While set, a column keeps its geometry (translateX /
   * width) but is `visibility: hidden` — so a structural rebind that commits
   * new X/Y geometry synchronously does NOT flash the column's STALE content at
   * the NEW position before its content rebinds (gap G4). Each column clears its
   * own mark on the next successful bind (the `onBind` finally), so the reveal
   * is per-column as the drain lands — the finer-grained companion to
   * `toggleContentVisibility`'s whole-viewport co-hide. The sheet host marks
   * (true) before a same-sheet structural rebind and alongside a full-rebind's
   * `toggleContentVisibility(false)`. Marking happens ONLY here: resize /
   * offset-only binds never mark (see `assertChildren`), so a resize never
   * blanks columns; clearing on any bind is safe.
   */
  markRenderedColumnsPendingLayout(hidden: boolean): void {
    const engine = this._scrollEngine;
    if (!engine) return;
    // Age anchor for the invariant sweep's escalation grace window: marks laid
    // by a bind that is still inside its gates are young, not stranded.
    if (hidden) this.lastPendingLayoutMarkMs = this.sweepClock.now();
    let columns = 0;
    for (const entry of engine.entries.all) {
      const { $header, $body, $footer } = entry.t;
      $header.toggleAttribute("pending-layout", hidden);
      $body.toggleAttribute("pending-layout", hidden);
      if ($footer) $footer.toggleAttribute("pending-layout", hidden);
      columns += 1;
    }
    // Trace hook `scroll/pending-layout/mark`: pairs with the
    // `scroll/pending-layout/drain` log in onBatchComplete. `gen` is the epoch
    // the marks were laid under: a `scroll/bind-drop-stale` at a LOWER gen
    // names binds that will never arrive to clear these marks.
    Tracing.log("scroll/pending-layout/mark", {
      hidden,
      columns,
      gen: engine.currentBindGeneration,
    });
    this.pendingLayoutMarked = hidden ? columns : null;
    this.pendingLayoutMarkGen = hidden ? engine.currentBindGeneration : null;
  }

  /**
   * Resolves once the bind queue has fully drained (the next `onBatchComplete`),
   * i.e. every rendered cell holds its current content; resolves synchronously
   * when nothing is pending. The sheet's post-navigation reveal chains on this so
   * the sheet is shown only after new content paints — never one frame of stale
   * recycled content stretched to the new sheet's geometry.
   */
  /**
   * Resolve once the bind queue has drained AND the caller's {@link SettleDebt}
   * has been repaid — a bind has actually run at the generation the waiting
   * work was promised at.
   *
   * The debt is not decoration. "The queue is empty" is true in two states:
   * after the caller's binds have drained, and BEFORE they have been enqueued.
   * A superseded sheet switch produces the second one — the generation bump
   * makes the drain drop the outgoing instructions, emptying the queue for a
   * microtask or two — and a consumer that releases there acts on work that has
   * not happened. That is how the navigation reveal came to fire with every
   * scrubbed cell still 0px (2026-08-18, `sheet/reveal` with waitMs=0 and no
   * `scroll/when-settled` breadcrumb at all, because this fast path is the one
   * route that emits none).
   *
   * Which debt to pass is the caller's statement about what it is owed, and
   * `SettleDebt.owed` is the only place the three release rules live — the fast
   * path below and the bounded fallback ask it the same question so they cannot
   * drift. If nothing is ever bound at the awaited generation the fallback
   * still releases within ~2 frames, so a consumer whose incoming pass
   * legitimately binds nothing costs a couple of frames, never a lock.
   *
   * Resolves with a {@link SettleResult}. Cancellation unlinks this consumer
   * without certifying its bind debt or running reveal diagnostics. Which genuine path fired
   * is not bookkeeping: `drain` means the debt was repaid, `fallback-exhausted`
   * means it was not and liveness won, and a caller that goes on to audit the
   * pixels (the reveal) has to be able to say which of those it is auditing
   * after. The same leaf already went into the breadcrumb below.
   */
  whenSettled(debt: SettleDebt, signal: Option<AbortSignal>): Promise<SettleResult> {
    return this.settleWaiters.wait(debt, signal);
  }

  /** Observe genuine batch drains without scheduling frames or renewing a
   * deadline. Subscribe before rechecking the current queue to avoid lost wakes. */
  onBindDrain(callback: () => void): () => void {
    this.bindDrainListeners.add(callback);
    return () => { this.bindDrainListeners.delete(callback); };
  }

  onRecycle(): void {
    this.scrollBindRevision++;
    this.scrollBodyRevision++;
    this.resetHeaderSweeps();
    this.bindDrainListeners.clear();
    this.settleWaiters.cancelAll();
    this._scrollEngine?.dispose();
    super.onRecycle();
  }

  readonly headerPeek = ((self) => ({
    _all: new Map() as Map<number, number>,

    toggle(force?: Option<boolean>, animate: boolean = true) {
      self.$("headers-bg").toggleAttribute("no-transition", !animate);
      self.toggleAttribute("fullscreen-bg", force ?? undefined);
    },

    get height(): number {
      const bg = Number.parseInt(
        self.$("headers-bg").style.getPropertyValue("--headers-bg-peek"),
      );
      return bg - 6;
    },

    setHeight(heightPx: Option<number>, animate: boolean = false) {
      self.$("headers-bg").toggleAttribute("no-transition", !animate);
      let height = heightPx ? heightPx + "px" : "";
      const fullscreen = self.hasAttribute("header-peek-fullscreen");
      if (fullscreen) {
        height = "100%";
      }

      self
        .$("headers-bg")
        .style.setProperty(
          "--headers-bg-peek",
          fullscreen ? height : heightPx ? heightPx + 6 + "px" : "",
        );
      self.$("headers").style.height = height;
      self.style.setProperty("--body-top-offset", height);
      if (height !== self.currentHeaderHeightPx) {
        self.currentHeaderHeightPx = height;
      }
    },

    toggleShadow(force: boolean) {
      self.$("headers-bg").assignStyles({
        boxShadow: force ? "" : "none",
      });
    },

    toggleFullScreen(force: boolean, animate: boolean) {
      self.toggleAttribute("header-peek-fullscreen", force);
      this.setHeight(self.props?.headerHeight, animate);
    },
  }))(this);

  /*
   APIs (Static Child)
   =============================================================================
  */

  // Synchronous tracking of pending static children to prevent race conditions.
  // DOM mutations are async via $.mutate(), but we need to know immediately
  // if an element has been scheduled for reveal to avoid creating duplicates.
  private staticChildPending = new Map<string, HTMLElement>();

  private resolveStaticAnchor(
    location: "header" | "body" | "footer",
  ): HTMLElement {
    if (location === "header") return this.$staticAnchorHeader;
    if (location === "footer") return this.$staticAnchorFooter;
    return this.$staticAnchorBody;
  }

  readonly staticChildrenHandle = ((self) => ({
    reveal(
      id: string,
      $e: HTMLElement,
      location: "header" | "body" | "footer",
      fillWidth: boolean,
    ) {
      const $anchor = self.resolveStaticAnchor(location);

      // Track this element synchronously to prevent duplicate reveals
      self.staticChildPending.set(id, $e);

      // Set attributes and lifecycle state synchronously
      $e.setAttribute("data-static-id", id);
      $e.setAttribute("data-static-state", "pending-append");
      $e.style.position = "absolute";
      if (fillWidth) {
        $e.style.width = "100%";
      }

      $$.mutate(() => {
        // Guard: if a newer reveal superseded this one (or dismissAll
        // cleared the pending map), abort to prevent stale appends
        if (self.staticChildPending.get(id) !== $e) return;

        // Re-query at mutation time for correct dedup (prevents race
        // when multiple reveals for the same ID are scheduled in one frame)
        const anchors = [
          self.$staticAnchorHeader,
          self.$staticAnchorBody,
          self.$staticAnchorFooter,
        ];
        for (const anchor of anchors) {
          const $existing = anchor.querySelector(
            `[data-static-id="${id}"]`,
          ) as Option<HTMLElement>;
          if ($existing && $existing !== $e) {
            DomUtils.removeFromDom($existing);
          }
        }

        // Append element and mark as active
        $anchor.appendChild($e);
        $e.setAttribute("data-static-state", "active");
      });
    },
    get(
      location: "header" | "body" | "footer",
      id: string,
    ): Option<HTMLElement> {
      // Check synchronous pending map first (handles race condition)
      const $pending = self.staticChildPending.get(id);
      if ($pending) {
        const state = $pending.getAttribute("data-static-state");
        if (state === "active" || state === "pending-append") {
          return $pending;
        }
      }

      const $anchor = self.resolveStaticAnchor(location);

      // Query for element with matching ID
      const $e = $anchor.querySelector(
        `[data-static-id="${id}"]`,
      ) as Option<HTMLElement>;
      if (!$e) return;

      const state = $e.getAttribute("data-static-state");
      if (state === "active" || state === "pending-append") {
        return $e;
      }
    },
    dismiss(location: "header" | "body" | "footer", id: string) {
      // Remove from pending map
      self.staticChildPending.delete(id);

      const $anchor = self.resolveStaticAnchor(location);

      // Query for element with matching ID
      const $e = $anchor.querySelector(
        `[data-static-id="${id}"]`,
      ) as Option<HTMLElement>;
      if (!$e) return;

      $e.setAttribute("data-static-state", "pending-remove");
      $$.mutate(() => {
        if ($e.getAttribute("data-static-state") === "pending-remove") {
          DomUtils.removeFromDom($e, false);
        }
      });
    },
    dismissAll(): HTMLElement[] {
      // Clear all pending entries
      self.staticChildPending.clear();

      const $children = this.getAll();
      for (const $e of $children) {
        $e.setAttribute("data-static-state", "pending-remove");
      }
      $$.mutate(() => {
        // Only remove elements that still have pending-remove state
        for (const $e of $children) {
          if ($e.getAttribute("data-static-state") === "pending-remove") {
            DomUtils.removeFromDom($e, false);
          }
        }
      });

      return [...$children];
    },
    getAll(): HTMLElement[] {
      const headerChildren = [
        ...self.$staticAnchorHeader.children,
      ] as HTMLElement[];
      const bodyChildren = [
        ...self.$staticAnchorBody.children,
      ] as HTMLElement[];
      const footerChildren = [
        ...self.$staticAnchorFooter.children,
      ] as HTMLElement[];

      // Filter to only include active or pending-append elements
      const allChildren = [
        ...headerChildren,
        ...bodyChildren,
        ...footerChildren,
      ];
      return allChildren.filter(($e) => {
        const state = $e.getAttribute("data-static-state");
        return state === "active" || state === "pending-append";
      });
    },
  }))(this);

  /*
   APIs (Fixed Child)
   =============================================================================
  */
  private _appendFixedChild(
    $e: HTMLElement,
    slot: "body" | "header" | "footer",
  ) {
    $e.slot = slot;
    $e.classList.add("fixed");
    $e.assignStyles({
      position: "absolute",
      top: "0",
      left: this.$scrollable.baseOffset + "px",
      "--y-from-row-index": "0px", // Fixed: contentY already includes absolute position, no header offset needed
      transform:
        "translate(calc(var(--x, 0px) + var(--additional-x, 0px)), calc(var(--y-from-row-index, 0px) + var(--y, 0px) + var(--additional-y, 0px)))",
      zIndex: String(Constants.MAX_Z_INDEX - 5),
      // marginTop: "0px",
    });
    $e.setAttribute("state", "revealed");
    if ($e.parentElement === this || this._pendingFixedChildAppends.has($e))
      return;
    this._pendingFixedChildAppends.add($e);
    $$.mutate(() => {
      if (!this._pendingFixedChildAppends.delete($e)) return;
      if ($e.getAttribute("state") !== "revealed") return;
      this.appendChild($e);
    });
  }

  appendFixedChild(
    $e: HTMLElement,
    position: Point<number, /* index */ LiveData<number> /* px */>,
    location: "body" | "header" | "footer",
    options?: Optional<{
      animate: boolean;
      offsetPx: Point;
      xPosition: () => Option<number>;
    }>,
  ) {
    const binding = {};
    this.fixedChildBindings.set($e, binding);
    const current = () => this.fixedChildBindings.get($e) === binding;
    this.scrollEngine.fixed.setFixedChildIndex($e, position.x, ($e, offset) => {
      $$.mutate(() => {
        if (!current()) return;
        $e.style.setProperty("--x", offset + "px");
        const xPos = options?.xPosition?.() ?? 0;
        const xOff = options?.offsetPx?.x ?? 0;
        $e.style.setProperty("--additional-x", xPos + xOff + "px");
      });
    });

    position.y.addListener($e, (newAdditionalY) => {
      if (!current()) return;
      const newValue = newAdditionalY + (options?.offsetPx?.y ?? 0);
      $e.style.setProperty("--additional-y", newValue + "px");
    });
    const newPosition = {
      additionalY: position.y.get() + (options?.offsetPx?.y ?? 0),
    };

    if (options?.animate && !$e.hasAttribute("rendered")) {
      $e.style.opacity = String(0);
    }
    $$.mutate(() => {
      if (!current()) return;
      $e.assignStyles({
        transition: options?.animate
          ? "transform 0.3s ease, opacity 0.3s ease"
          : "",
        "--additional-y": newPosition.additionalY + "px",
        "--y": 0 + "px",
      });
      if (options?.animate) {
        $$.deferMutate(() => {
          if (!current() || $e.getAttribute("state") !== "revealed") return;
          $e.style.opacity = String(1);
          $e.toggleAttribute("rendered", true);
        });
      } else {
        $e.style.opacity = String(1);
        $e.toggleAttribute("rendered", true);
      }
    });

    this._appendFixedChild($e, location);
  }

  appendLiveFixedChild(
    $e: HTMLElement,
    position: {
      x: LiveData<number>;
      y: LiveData<number>;
    },
    location: "body" | "header" | "footer",
    options?: Optional<{
      offsetPx: Point;
    }>,
  ) {
    position.x.addListener($e, (xPx) => {
      $e.style.setProperty("--x", xPx + "px");
      $e.style.setProperty(
        "--additional-x",
        (options?.offsetPx?.x ?? 0) + "px",
      );
    });
    position.y.addListener($e, (yPx) => {
      $e.style.setProperty(
        "--additional-y",
        yPx + (options?.offsetPx?.y ?? 0) + "px",
      );
    });
    $e.style.setProperty("--y", "0px");
    $e.style.opacity = "1";
    $e.toggleAttribute("rendered", true);
    this._appendFixedChild($e, location);
  }

  dismissFixedChild(id: string, animate: boolean, recycle: boolean) {
    const $c = this.findFixedChild(id);
    if (!$c) return;
    this.dismissFixedChildElement($c, animate, recycle);
  }

  /** Dismiss the registered instance, including a not-yet-mounted child. */
  dismissFixedChildElement($c: HTMLElement, animate: boolean, recycle: boolean): void {
    this.fixedChildBindings.delete($c);
    this._pendingFixedChildAppends.delete($c);
    // Without the fade the child leaves now: detach it before the mark, so the
    // `state` write lands on a detached node and invalidates no style.
    if (!animate) $c.parentElement?.removeChild($c);
    $c.setAttribute("state", "dismissed");
    // Unregister from the offset fan-out immediately — the map is iterated on
    // every window offset update and has no other pruning, so a dismissed
    // child left registered is a per-scroll-tick cost for the session's life.
    // A recycled element re-registers via setFixedChildIndex on its next use.
    this.scrollEngine.fixed.removeFixedChild($c);
    if (animate) {
      // TODO: this happens sync - async could potentially be problematic?
      $c.setAttribute("state", "dismissed");
      $c.style.opacity = String(0);
      setTimeout(() => {
        $$.mutate(() => {
          if ($c.getAttribute("state") !== "dismissed") return;
          DomUtils.removeFromDom($c, recycle);
        });
      }, 300 /* ms */);
    } else {
      DomUtils.removeFromDom($c, recycle);
    }
  }

  findFixedChild<T extends HTMLElement>(id: string): Option<T> {
    const mounted = $_maybe<T>(id, this);
    if (mounted != null) return mounted;
    for (const $element of this._pendingFixedChildAppends) {
      if ($element.id === id) return $element as T;
    }
    return null;
  }

  updateFixedChildIndex($e: HTMLElement, newIndex: number): Option<number> {
    return this.scrollEngine.fixed.updateFixedChildIndex($e, newIndex);
  }

  removeAllFixedBodySync() {
    // NOTE: query based off the light dom
    for (const $e of $qsa(".fixed", this)) {
      this.fixedChildBindings.delete($e);
      this.scrollEngine.fixed.removeFixedChild($e);
      DomUtils.removeFromDom($e, false);
    }
    // Cancel pending appends so $$.mutate callbacks don't re-append dismissed elements
    for (const $e of this._pendingFixedChildAppends) {
      this.fixedChildBindings.delete($e);
      this.scrollEngine.fixed.removeFixedChild($e);
      $e.setAttribute("state", "dismissed");
    }
    this._pendingFixedChildAppends.clear();
  }

  /*
   State
   =============================================================================
  */
  // Last KNOWN viewport scrollTop: written on every real set (post-write
  // readback, cheap because the write just forced layout) and kept truthful
  // by the passive scroll listener in initialize() — user scrolls and
  // browser clamping both fire scroll events. Null until first known.
  private _lastListScrollTop: Option<number> = null;

  set listScrollTop(top: number) {
    // A scrollTop write forces synchronous layout even when the value is
    // unchanged, and a view-config switch restores the same
    // initialScrollTop on every full bind pass — skip the known no-ops.
    if (this._lastListScrollTop === top) return;
    const $vp = this.$("content-viewport");
    $vp.scrollTop = top;
    this.$scrollable.forgetEventPosition();
    this._lastListScrollTop = $vp.scrollTop;
  }

  get listScrollTop(): number {
    return this.$("content-viewport").scrollTop;
  }

  getContentHeight(): number {
    return this.$("content-viewport").scrollHeight;
  }

  /** Fresh viewport position, without a scrollHeight read. */
  getScrollPosition(): { left: number; top: number } {
    return this.$scrollable.getScrollPosition();
  }

  /** The position the last scroll event reported, without a DOM read; null when unknown. */
  observedScrollPosition(): Option<{ left: number; top: number }> {
    return this.$scrollable.observedScrollPosition();
  }

  getScrollInfo(): Option<{
    left: number;
    top: number;
    scrollHeight: number;
  }> {
    return this.$scrollable.getScrollInfo();
  }

  static $styles = [
    css`
      :host {
        --max-z: 16777271;
        --max-width: 16777200px;
        --content-height: var(--std-scroll-content-height);
      }
      [no-transition] {
        transition: none !important;
      }

      :host([shadow-protection]) .shadow-protection {
        content: "";
        position: sticky;
        top: -1px;
        bottom: 0px;
        width: 0px;
        height: calc(100% + 2px);
        background: var(--header-bg, white);
        z-index: var(--max-z);
      }
      :host([shadow-protection]) .shadow-protection[left] {
        left: -1;
        box-shadow: 2px 0px 4px 4px var(--header-bg, white);
      }
      :host([shadow-protection]) .shadow-protection[right] {
        left: calc(100% + 1px);
        box-shadow: -2px 0px 4px 4px var(--header-bg, white);
        transform: translateY(-100%);
      }
    `,
    css`
      #content-viewport {
        background: var(
          --std-scroll-content-background-color,
          var(--bg)
        );
        overscroll-behavior: none;
      }
      #content-viewport:not([show-scrollbar]) {
        -ms-overflow-style: none;
        scrollbar-width: none;
      }
      #content-viewport:not([show-scrollbar])::-webkit-scrollbar {
        display: none;
      }
      /* Wheel-scroll hit-test shield (see onWheelActivity). A transparent
       * sticky overlay pinned to the visible corner of the scrollport; while
       * a wheel burst is active it sits on top of the paint order, so the
       * browser's hover re-hit-tests terminate here instead of walking the
       * column subtree. Chosen over "pointer-events: none" on #content:
       * pointer-events INHERITS, so toggling it restyles the whole ~8k-node
       * subtree at every burst boundary (a ~160ms recalc, run31), while this
       * toggle restyles two boxes. Wheel events target the shield but the
       * viewport is still their nearest scrollable ancestor, so native
       * scrolling and the viewport's wheel listener are unaffected. The
       * ::after is exactly the scrollport's size (set by onSizeChange): it
       * is scrollable overflow of #content-viewport, so anything larger -
       * it was 200vw x 200vh - grew the scroll extent for the length of a
       * burst, and a sheet shorter than twice the window wheel-scrolled into
       * blank space that snapped back when the burst ended. */
      #wheel-shield {
        display: none;
        position: sticky;
        top: 0;
        left: 0;
        width: 0;
        height: 0;
        overflow: visible;
        z-index: calc(var(--max-z) + 1);
      }
      #wheel-shield[active] {
        display: block;
      }
      #wheel-shield::after {
        content: "";
        position: absolute;
        top: 0;
        left: 0;
        width: var(--wheel-shield-width, 0px);
        height: var(--wheel-shield-height, 0px);
      }
      :host([scroll-cell-transitions]) slot[name="header"]::slotted(*),
      :host([scroll-cell-transitions]) slot[name="body"]::slotted(*) {
        transition: transform 0.3s ease;
      }
      slot[name="header"]::slotted(*),
      slot[name="body"]::slotted(*) {
        transition: none;
      }
      #headers,
      #sidebar {
        transition: opacity 0.3s ease;
      }
    `,
    css`
      #headers-bg {
        position: absolute;
        top: -6px;
        left: -4px;
        height: calc(100% + 8px + 6px);
        width: calc(100% + 8px);
        transition: transform 0.3s ease, box-shadow 0.3s ease;
        transform: translateY(
          calc(
            -100% + var(--headers-bg-peek, 0px)
          )
        );
        box-shadow: 0px 0px 6px 3px rgb(0 0 0 / 12%);
        background: var(--header-bg, white);
        border-radius: 4px;
        border-top-left-radius: 0px;
        border-top-right-radius: 0px;
        z-index: var(--max-z);
        user-select: none;
      }
      :host([header-shadow-hidden]) #headers-bg {
        box-shadow: none;
      }
      :host([header-peek-fullscreen]) #footers-bg {
        transform: translateY(calc(100% + 8px));
      }
    `,
    css`
      slot::slotted(*) {
        position: absolute;
      }
      :host {
        overflow: hidden;
      }
      #root {
        height: 100%;
        width: 100%;
        position: relative;
      }
      #content-viewport {
        height: 100%;
        width: 100%;
        overflow: scroll;
        box-sizing: border-box;
        /* The co-hide contract (gap G3): toggleContentVisibility(false)
         * blanks the whole scroll viewport (headers + bodies + sidebar)
         * for the full-rebind window so stale old-sheet content is never
         * visible next to the hidden legend; the sheet bind path reveals
         * both together (legend-ready + toggleContentVisibility(true)).
         * Also the fullscreen/null-state hide (app main-reconciler).
         * Specified opacity 1 creates no stacking context, so z-order is
         * untouched whenever content is visible. */
        opacity: 1;
      }
      #content {
        /* inline-table is LOAD-BEARING on Blink: #content has an explicit
         * height (bodyHeightPx, set inline in bindScroll) and the table
         * redistributes it across its anonymous rows — the zero-height #bodies
         * row (its cells are position:absolute) stretches to absorb the slack,
         * which pushes #footers down and reserves the footer's bottom space so
         * the last body row doesn't overlap it. Do NOT switch this to a block
         * box globally: block flow has no redistribution, #bodies reserves
         * nothing, and the bottom-pinned footer overlaps the last row.
         *
         * Firefox applies the strict CSS table model and breaks this twice — %
         * heights don't resolve against a table box (#sidebar collapses to
         * fit-content) and position:sticky children resolve their sticky rect
         * against the anonymous table cell rather than the #content-viewport
         * scrollport (#footers' bottom:0 won't pin). The Firefox-only
         * :host([engine="gecko"]) block below rebuilds the layout with
         * inline-block + a taller #content, leaving this Blink path untouched. */
        display: inline-table;
        position: relative;
        /* height is bodyHeightPx, set by bindScroll via --content-body-height;
         * falls back to the legacy var / 100% before the first bind. */
        height: var(--content-body-height, var(--content-height, 100%));
        width: var(--max-width);
        min-height: 100%;
      }
      /* Firefox (Gecko) only — see #content comment above. inline-block so the
       * sticky children resolve against the #content-viewport scrollport and
       * #sidebar's %-height resolves against a real box. */
      :host([engine="gecko"]) #content {
        display: inline-block;
      }
      /* With a footer, Blink's table row-redistribution (which reserved the
       * footer's bottom space) is gone in block flow, so the bottom-pinned
       * footer would overlap the last body row. Grow #content past the body's
       * rendered extent — bodyHeight + --body-margin-top (the body column's top
       * shift) + --footer-height — so the sticky footer is bounded BELOW the
       * last row. #sidebar's calc(100% − …) then fills exactly to the footer
       * top on its own. Measured in real Firefox (geckodriver): overlap 0. */
      :host([engine="gecko"][has-footer]) #content {
        height: calc(
          var(--content-body-height, 0px) + var(--body-margin-top, 0px) +
            var(--footer-height, 0px)
        );
      }
      #headers {
        position: sticky;
        top: 0px;
        z-index: var(--max-z);
        background: var(--header-bg, white);
        max-height: calc(100vh - 120px);
      }
      #header-sidebar {
        position: absolute;
        top: 0px;
        left: 0px;
        z-index: calc(var(--max-z) - 0);
        /* Backing background like #headers / #footer-sidebar: the header
         * legend occludes the leftmost header cells by design, so when
         * its content hides (legend-ready=false during a switch) this box
         * must keep occluding — without it, stale old-sheet header cells
         * showed through for the whole rebind window (gap G3). */
        background: var(--header-bg, white);
      }
      #footer-sidebar {
        position: absolute;
        bottom: 0px;
        left: 0px;
        z-index: calc(var(--max-z) - 1);
        background: var(--header-bg, white);
      }
      #sidebar {
        position: sticky;
        left: 0px;
        z-index: calc(var(--max-z) - 3);
        background: var(--bg, white);
        width: fit-content;
        height: calc(100% - var(--body-top-offset, 0px) - var(--footer-height, 0px));
        min-height: calc(100% - var(--body-top-offset, 0px) - var(--footer-height, 0px));
      }

      #footers {
        position: sticky;
        bottom: 0px;
        z-index: calc(var(--max-z) - 2);
      }

      #footers-bg {
        display: none;
        position: absolute;
        bottom: -6px;
        left: -4px;
        height: calc(100% + 8px + 6px);
        width: calc(100% + 8px);
        box-shadow: 0px 0px 6px 3px rgb(0 0 0 / 12%);
        background: var(--header-bg, white);
        border-radius: 4px;
        border-bottom-left-radius: 0px;
        border-bottom-right-radius: 0px;
        z-index: -1;
        pointer-events: none;
        transform: translateY(calc(100% - var(--footer-height, 0px) - 2px - 5px));
        z-index: calc(var(--max-z) - 2);
        /* No transform transition: the footer bg appears in place. Unlike
           #headers-bg (whose peek is animated deliberately via setHeight), the
           footer bg has no reveal gesture — its transform is moved both by
           --footer-height and by the header-peek-fullscreen rule below, and on
           sheet/template load that toggle would otherwise slide it in. */
        transition: box-shadow 0.3s ease;
      }
      :host([footer-bg-visible]) #footers-bg {
        display: block;
      }

      #sticky-header,
      #sticky-body,
      #sticky-footer {
        height: 0px;
        position: relative;
      }

      #sticky-header {
        z-index: calc(var(--max-z));
      }
      #sticky-body {
        z-index: calc(var(--max-z) - 6);
      }
      #sticky-footer {
        z-index: calc(var(--max-z) - 3);
      }

      slot[name="sticky-header"]::slotted(*),
      slot[name="sticky-body"]::slotted(*),
      slot[name="sticky-footer"]::slotted(*) {
        position: sticky;
        display: block;
      }

      #alias-protection {
        position: fixed;
        left: -1px;
        width: 2px;
        background: var(--bg, white);
        height: 100%;
        top: 0px;
        z-index: calc(var(--max-z) - 1);
        pointer-events: none;
      }
      :host([disable-alias-protection]) #alias-protection {
        display: none;
      }

      #static-anchor-header,
      #static-anchor-body,
      #static-anchor-footer {
        height: 0px;
        position: sticky;
        display: block;
        left: calc(var(--sidebar-width));
        /* The anchor is a positioning CONTAINER: its real children (static
         * children — month view, etc. — appended via staticChildrenHandle) are
         * interactive, but the anchor's OWN empty area is just a reference box
         * and must be pointer-transparent. The footer anchor is full-height
         * (below) to span the sticky footer region as a bottom-anchored
         * reference, so its empty area paints OVER the footer cells; without
         * this it blankets the footer timeline and swallows every pointerdown —
         * breaking drag-create / event-details in a footer-region calendar.
         * Header/body anchors are 0px, so this was a latent no-op there. */
        pointer-events: none;
      }
      /* ...but keep the interactive static children (month view, etc.) clickable. */
      #static-anchor-header > *,
      #static-anchor-body > *,
      #static-anchor-footer > * {
        pointer-events: auto;
      }
      #static-anchor-footer {
        height: var(--footer-height, 0px);
      }

      slot[name="header"]::slotted(*),
      slot[name="body"]::slotted(*),
      slot[name="footer"]::slotted(*) {
        top: 0px;
        z-index: calc(8388635 + var(--idx) + var(--z, 0));
        transform: translateX(calc(var(--offset) + var(--base-offset)));
        /* width is inline per column (bindColumnComponent); see bindLayout for
         * why it is not a host custom property. */
      }

      slot[name="header"]::slotted([recycled]),
      slot[name="body"]::slotted([recycled]),
      slot[name="footer"]::slotted([recycled]) {
        opacity: 0;
        pointer-events: none;
      }
      /* Host-only park marks (scroll-park-host-only): pointer-events is
       * inherited, so toggling the mark above changed every descendant's
       * computed style and restyled the column's whole subtree. Here the mark
       * leaves pointer-events as the column has it unmarked (inherit) and
       * hides with non-inherited properties only, so a toggle restyles the
       * column host alone; the full clip removes the column from hit-testing
       * as pointer-events did. */
      :host([park-host-only]) slot[name="header"]::slotted([recycled]),
      :host([park-host-only]) slot[name="body"]::slotted([recycled]),
      :host([park-host-only]) slot[name="footer"]::slotted([recycled]) {
        pointer-events: inherit;
        clip-path: inset(100%);
      }
      /* ...and a recycled column showing a placeholder (the placeholder rule
       * below) shows it and stays non-interactive, as without the flag: only
       * placeholder columns pay the inherited toggle. */
      :host([park-host-only]) slot[name="header"]::slotted([recycled][column-placeholder]),
      :host([park-host-only]) slot[name="body"]::slotted([recycled][column-placeholder]),
      :host([park-host-only]) slot[name="footer"]::slotted([recycled][column-placeholder]) {
        opacity: 1;
        clip-path: none;
        pointer-events: none;
      }

      /* Pool park. A column handed back to the pool keeps no live geometry: its
       * --offset still names the index (and the column width) it was recycled
       * FROM, so leaving it where it was parks an unbindable ghost inside the
       * viewport — one no reconcile window covers and no per-index bind can
       * reach, which is exactly the cohort the header-invariant sweep escalates
       * as a stranded flank. translateX(0) puts it at content x 0, which is
       * --base-offset (~8.4M px) to the LEFT of any real scroll position, so it
       * is provably outside the scrollport. transition:none so the return trip
       * on the next bind can never animate across that distance. Set by the
       * onRecycle path; cleared in the same write that restores --offset.
       * (No backticks in this block: they terminate the css template literal.)
       */
      slot[name="header"]::slotted([pooled]),
      slot[name="body"]::slotted([pooled]),
      slot[name="footer"]::slotted([pooled]) {
        transform: translateX(0);
        transition: none;
      }

      /* Structural-rebind co-hide (gap G4): a marked column keeps its geometry
       * (visibility, NOT display — layout must not collapse) but hides its stale
       * content until the per-column bind clears the mark. Set/cleared by
       * markRenderedColumnsPendingLayout + the onBind finally. A column that
       * marks itself [paints-skeleton] stays visible: it paints its skeleton
       * and hides its own stale content, so the viewport never shows nothing.
       * A column showing a placeholder (a header's label for its range, a
       * body's preview) is exempt too: it hides only its stale cells. */
      slot[name="header"]::slotted([pending-layout]:not([paints-skeleton]):not([column-placeholder])),
      slot[name="body"]::slotted([pending-layout]:not([paints-skeleton]):not([column-placeholder])),
      slot[name="footer"]::slotted([pending-layout]:not([paints-skeleton]):not([column-placeholder])) {
        visibility: hidden;
      }
      /* A column placed at an index other than the one its content is bound
       * to: keep the geometry, hide the content until the full bind lands
       * (continuity rule: no stale content during motion). Set/cleared by
       * onPlace and the bind.
       * clip-path, not visibility: visibility inherits, so toggling it on a
       * column host restyles the column's whole subtree - 11 ms for a
       * 1,435-element body column, paid once per column placed during a
       * gesture (measured 2026-09-12, Chrome 131). clip-path is not inherited
       * and the same toggle costs 0.0 ms; a fully inset clip hides the paint
       * and removes the column from hit-testing, which is what the hidden
       * visibility did. Layout is untouched either way. A column that paints
       * its own skeleton is exempt, as for pending-layout: it clips only its
       * stale content, so a re-anchor placed ahead of the bind never leaves
       * the viewport blank. A column showing a placeholder is exempt for the
       * same reason: a placed header carries its new range's label. */
      slot[name="header"]::slotted([placed-stale]:not([paints-skeleton]):not([column-placeholder])),
      slot[name="body"]::slotted([placed-stale]:not([paints-skeleton]):not([column-placeholder])),
      slot[name="footer"]::slotted([placed-stale]:not([paints-skeleton]):not([column-placeholder])) {
        clip-path: inset(100%);
      }

      /* A spare placed out of the pool ahead of its bind (a re-anchor's
       * installation under column retention) still carries its park mark
       * [recycled]. If it paints its own skeleton it shows it, as a placed
       * column does (its painter hides the stale content), and stays
       * non-interactive until the bind: skeleton first, never a blank frame
       * (browser spec skeleton-always-painted). */
      slot[name="header"]::slotted([recycled][placed-stale][paints-skeleton]),
      slot[name="body"]::slotted([recycled][placed-stale][paints-skeleton]),
      slot[name="footer"]::slotted([recycled][placed-stale][paints-skeleton]),
      :host([park-host-only]) slot[name="header"]::slotted([recycled][placed-stale][paints-skeleton]),
      :host([park-host-only]) slot[name="body"]::slotted([recycled][placed-stale][paints-skeleton]),
      :host([park-host-only]) slot[name="footer"]::slotted([recycled][placed-stale][paints-skeleton]) {
        opacity: 1;
        clip-path: none;
        pointer-events: none;
      }

      /* The adapter replaces stale cells with a decorative, non-interactive
         preview. Bound identity and pending debt stay untouched. */
      slot[name="header"]::slotted([column-placeholder]),
      slot[name="body"]::slotted([column-placeholder]),
      slot[name="footer"]::slotted([column-placeholder]) {
        opacity: 1;
        clip-path: none;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <div id="headers-bg"></div>
      <div id="footers-bg"></div>
      <div id="content-viewport">
        <div id="wheel-shield"></div>
        <div id=dbg></div>
        <div id="content">
          <div id="headers">
            <slot name="header"></slot>
            <div id="sticky-header">
              <div id=static-anchor-header></div>
              <slot name="sticky-header"></slot>
            </div>
            <div class="shadow-protection" left></div>
            <div class="shadow-protection" right></div>
          </div>
          <div id="bodies">
            <slot name="body"></slot>
            <div id="sticky-body">
              <div id=static-anchor-body></div>
              <slot name="sticky-body"></slot>
            </div>
          </div>
          <div id="sidebar">
            <slot name="sidebar"></slot>
          </div>
          <div id="footers">
            <slot name="footer"></slot>
            <div id="sticky-footer">
              <div id=static-anchor-footer></div>
              <slot name="sticky-footer"></slot>
            </div>
          </div>
        </div>
        <div id="header-sidebar">
          <slot name="header-sidebar"></slot>
          <div
            id="alias-protection"
            style="height:var(--headers-bg-peek)"
          ></div>
        </div>
        <div id="footer-sidebar">
          <slot name="footer-sidebar"></slot>
        </div>
      </div>
    </div>
  `;
}

export namespace ScrollHorizontal {
  export type Props = {
    headerHeight: number;
    scrollContentHeight: Option<number>;
    footerHeight?: Option<number>;
    canShowDebugPopover?: Option<LiveData.Readable<boolean>>;
  };

  export type ColumnSet<
    Header extends HTMLElement,
    Body extends HTMLElement,
    Footer extends HTMLElement = Header,
  > = { $header: Header; $body: Body; $footer?: Option<Footer> };

  export type Delegate<
    Header extends HTMLElement,
    Body extends HTMLElement,
    Footer extends HTMLElement = Header,
  > = {
    onCreate: () => ColumnSet<Header, Body, Footer>;
    onBind: (
      $e: ColumnSet<Header, Body, Footer>,
      index: number,
      widthPx: number,
      resizeOnly: boolean,
      isOffscreen: boolean,
    ) => void;
    onRecycle?: ($e: ColumnSet<Header, Body, Footer>) => void;
    /** Synchronous notification for consumers that need position only. */
    onScrollPosition?: Option<(position: { left: number; top: number }) => void>;
    onScroll?: Option<
      (info: { left: number; top: number; scrollHeight: number }) => void
    >;
    options?: ScrollEngine.OptionalCallbacks<ColumnSet<Header, Body, Footer>>;
  };
}
