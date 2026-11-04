import { Tracing } from "@tento-core/tracing";

/**
 * Minimal identity contract for a reconcilable render unit.
 *
 * `key` is the unit's stable identity (e.g. an event id + segment
 * ordinal). `contentSig` encodes everything *visible* about the unit
 * **except its position** — producers MUST exclude position (and the
 * decorative `isDragging` flag) from it. That exclusion is what makes
 * promotion atomic: a unit that only moves keeps the same `key` + `sig`,
 * so the reconciler reuses its DOM element in place rather than tearing
 * it down and rebuilding.
 */
export interface Keyed {
  key: string;
  contentSig: string;
  /**
   * Decorative "being dragged" flag. Out of `contentSig`; routed to
   * `dim()` as a side-channel so flipping it never triggers a recreate.
   */
  isDragging?: boolean;
}

/** Inline-style bag applied to a unit's element on every reconcile pass. */
export type StyleBag = CSSStyleWithVariables;

/**
 * A mutable cell threaded through a unit's event closures. The reconciler
 * bumps `.current` to the fresh unit on every reuse, so listeners wired
 * in `create` read live data without being re-registered.
 */
export interface UnitRef<S> {
  current: S;
}

export interface ReconcileOps<S extends Keyed, $E extends HTMLElement> {
  /**
   * Stable per-pass key for a unit. Duplicate keys within one pass are
   * auto-suffixed (and traced) so a misbehaving producer can't collapse
   * two units onto one element.
   */
  keyOf: (unit: S, index: number) => string;
  /**
   * Position styles, applied to the element on BOTH create and reuse.
   * Kept out of `contentSig` so position changes never recreate.
   */
  position: (unit: S, index: number) => StyleBag;
  /**
   * Build the DOM element for a freshly-seen (or sig-changed) unit. Wire
   * any event listeners to read `ref.current` — NOT the captured `unit` —
   * so they observe the fresh unit after a reuse-bump. The callback owns
   * mounting the element into its container; the reconciler only applies
   * `position` + `dim` afterward.
   */
  create: (unit: S, ref: UnitRef<S>) => $E;
  /** Toggle the decorative dragging visual (side-channel, out of sig). */
  dim: ($el: $E, isDragging: boolean) => void;
}

/**
 * Keyed DOM reconciliation with atomic element promotion.
 *
 * Each render pass feeds the reconciler a list of units in render order.
 * For each unit it decides — by `key` + `contentSig` — whether to reuse
 * the existing element (position re-applied, `ref` bumped, dim refreshed)
 * or rebuild it; any element whose key isn't produced this pass is
 * removed. Position is never part of the signature, so a unit that drags,
 * drops, or shifts lanes moves the *same* DOM node. The same render path
 * absorbs gesture overlays and canonical data updates — to the reconciler
 * they are the same thing.
 *
 * Generic over the unit shape `S` and its element type `$E`; the caller's
 * `ReconcileOps` supply all layout-specific geometry and DOM construction.
 */
export class SpanReconciler<S extends Keyed, $E extends HTMLElement> {
  private els = new Map<string, { $el: $E; sig: string; ref: UnitRef<S> }>();

  /**
   * Reconcile one render pass against `units` (in render order). Returns
   * the set of keys produced this pass (post-dedup).
   */
  reconcile(units: readonly S[], ops: ReconcileOps<S, $E>): Set<string> {
    const seen = new Set<string>();

    for (let index = 0; index < units.length; index++) {
      const unit = units[index];

      // Resolve a unique key for this pass. Duplicates shouldn't happen;
      // guard so one bad producer can't fold two units onto one element.
      let key = ops.keyOf(unit, index);
      if (seen.has(key)) {
        Tracing.log("span-reconciler/duplicate-key", { key });
        let n = 2;
        while (seen.has(`${key}~${n}`)) n++;
        key = `${key}~${n}`;
      }
      seen.add(key);

      const sig = unit.contentSig;
      const existing = this.els.get(key);

      if (existing && existing.sig === sig) {
        // Reuse: bump the ref so the unit's closures fire against fresh
        // data, re-apply position (out of sig), refresh the dim
        // side-channel. The element is never torn down.
        existing.ref.current = unit;
        existing.$el.assignStyles(ops.position(unit, index));
        ops.dim(existing.$el, unit.isDragging === true);
        continue;
      }

      // First sight, or the signature changed: drop the stale element
      // (if any) and build anew.
      if (existing) {
        existing.$el.remove();
      }

      const ref: UnitRef<S> = { current: unit };
      const $el = ops.create(unit, ref);
      $el.assignStyles(ops.position(unit, index));
      ops.dim($el, unit.isDragging === true);
      this.els.set(key, { $el, sig, ref });
    }

    // Exit: remove any element whose key wasn't produced this pass.
    for (const [key, { $el }] of this.els) {
      if (seen.has(key)) continue;
      $el.remove();
      this.els.delete(key);
    }

    return seen;
  }

  /** Remove every tracked element. Use on teardown / full reset. */
  clear(): void {
    for (const [, { $el }] of this.els) $el.remove();
    this.els.clear();
  }
}
