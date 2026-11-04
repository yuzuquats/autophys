/**
 * The **row-identity ledger** core — the generic dependency-tree + version
 * substrate for slice L1 of the row-identity ledger design
 * (`lona/lona-console/projects/sdk-2.0-performance.project.docs/content/row-identity-ledger.md`
 * §3). It composes a `DirectedGraph`-based edge structure with a monotonic
 * version store so that *one* number answers every freshness question
 * (recompute? repaint? refetch?) and *one* facet-filtered walk answers "who
 * might care".
 *
 * ## Write-side / consumer-side asymmetry (§3.4 — the design's core discipline)
 *
 * Writers know nothing about consumers. A write's entire contribution is one
 * integer increment on one `(key, facet)` slot — no event, no payload, no edge
 * knowledge (`bump`). Everything else is *pull*: edges say *who might care*
 * (`walk`), versions say *whether anything actually changed* (`version`), and
 * generations — a purely consumer-side concept — say *which declarations are
 * current* (`declareEdges`). Ledger = graph (nodes + edge records) + version
 * store; neither half works alone.
 *
 * ## OQ6 — where the concrete keys live
 *
 * This module is the **generic machinery only**. `Ledger.Key` is an opaque
 * branded string; the concrete `LedgerKey` union (`data:<Address>` / `pref:` /
 * `feed:` / `attr:<stableId>` / `range` / `tz`, design §3.1) is constructed
 * **sheets-side at slice L3**, where `DataRef`/`addressOf` live
 * (`tento/tento-lona-js/sheets/src`). Core stays free of sheets imports so the
 * dependency direction (`tento-core` ← `tento-lona` ← `sheets`) is preserved:
 * the ledger cannot name a `data:` address without importing a sheets concept,
 * so it never tries — it stores opaque keys and never parses them (scope
 * relationships are computed structurally, never by string-splitting, §3.4).
 *
 * ## Scope is a generic type parameter (the L1 decision)
 *
 * `tento-core` already depends on `@tento-chrono` (`range.ts`,
 * `subtree-spec.ts`), so a `NaiveDate.Range` scope *would* type-check here.
 * Scope is nonetheless left as a type parameter `S` because:
 *  - the design's scope is a **union** — `Option<NaiveDate.Range>` *and/or a
 *    registered subtree* (§3.4) — and a subtree scope references sheet row
 *    keys, a sheets concept `tento-core` must not import;
 *  - L1 **never interprets** scope — it is stored verbatim on the edge record
 *    and read back by consumers; the facet-filtered `walk` does not compare it.
 * So parameterising keeps core uncommitted and lets sheets-side bind the
 * concrete `NaiveDate.Range | SubtreeSpec` union at L3/L4. (Tradeoff: callers
 * must name the scope type; there is no ambient default — deliberately, to
 * avoid an accidental `unknown` scope.)
 *
 * ## Invariants enforced *by API absence* (LI1 / LI4, design §8)
 *
 * There is **no** decrement, **no** reset, and **no** bulk clear-all anywhere
 * on this class: versions are monotonic (LI4) and the ledger is never
 * bulk-cleared (LI1). `DirectedGraph.clearDependencies` is *per-node* edge
 * retirement (used internally by `declareEdges`), not a wipe. This is enforced
 * by the absence of such methods — asserted in the L1 suite.
 *
 * In-memory only: nothing here is persisted, so `stableId`-bearing keys never
 * cross the process boundary (OQ1). No call sites outside tests yet (L1).
 */

import type { DependencyAspect } from "./dependency-graph";
import { DirectedGraph } from "./directed-graph";

/**
 * The **read-only** projection of a `Ledger<S>` — every introspection method a
 * consumer needs to answer "did anything change?" (`version`) and "who might
 * care?" (`walk` / `directConsumers` / …), with **none** of the write surface
 * (`bump` / `declareEdges` / `retireNode`). The row-identity ledger's core
 * discipline is write-side / consumer-side asymmetry (§3.4); this interface
 * makes "consumers see a read-only view" a *type*, so a consumer that only
 * reads cannot accidentally mutate the ledger (engine-spec §11, REQ-DRT). No
 * production consumers exist yet, so introducing it breaks nothing — TX0's
 * additive half.
 *
 * `assertNoOrphans` is deliberately **off** the reader: it is a test-only
 * invariant probe, not a steady-state read.
 */
export interface LedgerReader<S> {
  version(key: Ledger.Key, facet: DependencyAspect): number;
  walk(key: Ledger.Key, facet: DependencyAspect): Set<Ledger.Key>;
  directConsumers(key: Ledger.Key, facet: DependencyAspect): Set<Ledger.Key>;
  producersOf(consumer: Ledger.Key): Ledger.Key[];
  edgeFacets(
    consumer: Ledger.Key,
    producer: Ledger.Key,
  ): Option<Set<DependencyAspect>>;
  edgeScope(consumer: Ledger.Key, producer: Ledger.Key): Option<S>;
  generationOf(consumer: Ledger.Key): Option<number>;
  orphans(): Ledger.Key[];
}

export class Ledger<S> extends DirectedGraph<Ledger.Key> implements LedgerReader<S> {
  /**
   * Monotonic version per `(key, facet)`. Nested map (not a delimiter-joined
   * composite string) because keys are opaque and may contain any byte, so no
   * printable delimiter is guaranteed absent from a key.
   */
  private readonly versionStore = new Map<
    Ledger.Key,
    Map<DependencyAspect, number>
  >();

  /**
   * The authoritative per-consumer edge declaration: its recompute generation
   * plus its full producer→edge set. `declareEdges` replaces this atomically;
   * the base `DirectedGraph` (`nodes` / `dependsOn` / `invalidates`) is kept in
   * lock-step for reachability and cheap reverse lookup.
   */
  private readonly consumerDeclarations = new Map<
    Ledger.Key,
    Ledger.Declaration<S>
  >();

  // ── LR1: versions ────────────────────────────────────────────────────────

  /**
   * Bump the monotonic version of `(key, facet)` — O(1), synchronous, the
   * *entire* write-side contribution (no payload). Returns the new version.
   * Ensures the node exists so introspection stays coherent (a pure input like
   * `range` / `tz` / an unconsumed `feed:` becomes a first-class node). LI4.
   */
  bump(key: Ledger.Key, facet: DependencyAspect): number {
    this.addNode(key);
    let facets = this.versionStore.get(key);
    if (facets == null) {
      facets = new Map();
      this.versionStore.set(key, facets);
    }
    const next = (facets.get(facet) ?? 0) + 1;
    facets.set(facet, next);
    return next;
  }

  /** The current version of `(key, facet)`; **0** when never bumped. */
  version(key: Ledger.Key, facet: DependencyAspect): number {
    return this.versionStore.get(key)?.get(facet) ?? 0;
  }

  // ── LR5: edges (declared at consumption, generation-collected) ────────────

  /**
   * Atomically replace **all** of `consumer`'s edges with `edges`, tagged at
   * `generation`. The prior generation's edges are dropped entirely — no edge
   * outlives its consumer's last declaration by more than one generation (LI7).
   *
   * Generations are monotonic per consumer: a declaration whose `generation` is
   * **older** than the stored one is a stale/out-of-order call and is ignored.
   * Re-declaring the same generation is idempotent (it re-installs the same
   * edge set); passing a different edge set at the same generation is a
   * last-write-wins replacement (a caller error, but harmless).
   */
  declareEdges(
    consumer: Ledger.Key,
    generation: number,
    edges: Iterable<Ledger.EdgeInput<S>>,
  ): void {
    const existing = this.consumerDeclarations.get(consumer);
    if (existing != null && generation < existing.generation) return;

    // Retire the whole prior generation from the base graph, then rebuild.
    this.addNode(consumer);
    this.clearDependencies(consumer);

    const declared = new Map<Ledger.Key, Ledger.Edge<S>>();
    for (const edge of edges) {
      this.addNode(edge.producer);
      this.addDependency(consumer, edge.producer);
      // Merge facets when a consumer declares the same producer twice in one
      // generation (e.g. VALUES on one clause, GEOMETRY on another).
      const prior = declared.get(edge.producer);
      const facets = prior?.facets ?? new Set<DependencyAspect>();
      for (const facet of edge.facets) facets.add(facet);
      declared.set(edge.producer, { facets, scope: edge.scope });
    }
    this.consumerDeclarations.set(consumer, { generation, edges: declared });
  }

  /** The generation of `consumer`'s current declaration, or `null`. */
  generationOf(consumer: Ledger.Key): Option<number> {
    return this.consumerDeclarations.get(consumer)?.generation ?? null;
  }

  /** The producers `consumer` currently depends on (introspection). */
  producersOf(consumer: Ledger.Key): Ledger.Key[] {
    const decl = this.consumerDeclarations.get(consumer);
    return decl == null ? [] : [...decl.edges.keys()];
  }

  /** The facets on `consumer`'s edge to `producer`, or `null` if no such edge. */
  edgeFacets(
    consumer: Ledger.Key,
    producer: Ledger.Key,
  ): Option<Set<DependencyAspect>> {
    return this.consumerDeclarations.get(consumer)?.edges.get(producer)?.facets;
  }

  /** The scope on `consumer`'s edge to `producer`, or `null` if no such edge. */
  edgeScope(consumer: Ledger.Key, producer: Ledger.Key): Option<S> {
    const edge = this.consumerDeclarations.get(consumer)?.edges.get(producer);
    return edge == null ? null : edge.scope;
  }

  // ── LR2: facet-filtered walk (only consumers that depend on this facet) ────

  /**
   * The **direct** (one-hop) consumers whose edge to `key` includes `facet`.
   * This is the capability the base `DirectedGraph`
   * `getDirectDependents`/`invalidationSet` walks lack — they ignore the edge
   * facets. Built facet-aware from the start (LR2).
   */
  directConsumers(key: Ledger.Key, facet: DependencyAspect): Set<Ledger.Key> {
    const out = new Set<Ledger.Key>();
    for (const consumer of this.getDirectDependents(key)) {
      const edge = this.consumerDeclarations.get(consumer)?.edges.get(key);
      if (edge != null && edge.facets.has(facet)) out.add(consumer);
    }
    return out;
  }

  /**
   * The **transitive** facet-filtered consumer set reachable from `key`,
   * excluding `key` itself (LR2). A single facet propagates uniformly: each hop
   * follows only edges that include `facet`, so a VALUES bump on a data node
   * reaches every downstream VALUES consumer but not a purely GEOMETRY edge on
   * the same node. Mirrors `computeDependentsOnly`, gated on the facet.
   */
  walk(key: Ledger.Key, facet: DependencyAspect): Set<Ledger.Key> {
    const out = new Set<Ledger.Key>();
    const seen = new Set<Ledger.Key>([key]);
    const stack: Ledger.Key[] = [key];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node == null) break;
      for (const consumer of this.directConsumers(node, facet)) {
        if (seen.has(consumer)) continue;
        seen.add(consumer);
        out.add(consumer);
        stack.push(consumer);
      }
    }
    return out;
  }

  // ── LR8: node retirement + orphan scan ────────────────────────────────────

  /**
   * Retire `key`: remove the node, every edge touching it (both as a consumer
   * and as a producer), and its version entries. Replaces the formula wipe's GC
   * role (LR8) — targeted, not a bulk clear. Idempotent for an unknown key.
   */
  retireNode(key: Ledger.Key): void {
    // Drop `key` as a producer from each consumer that pointed at it.
    for (const consumer of this.getDirectDependents(key)) {
      this.consumerDeclarations.get(consumer)?.edges.delete(key);
    }
    // Drop `key`'s own declaration (as a consumer) and its versions.
    this.consumerDeclarations.delete(key);
    this.versionStore.delete(key);
    // Base graph: node + all dependsOn/invalidates edges touching `key`.
    this.removeNode(key);
  }

  /**
   * Every key referenced by an edge, reverse index, or version entry that is
   * **not** in `nodes` — a dangling reference. Steady-state operation keeps
   * this empty (`declareEdges`/`bump` add their nodes; `retireNode` removes all
   * references atomically); a non-empty result is a retirement/declaration bug.
   * Introspection surface for the L1 suite (LR8 orphan-scan).
   */
  orphans(): Ledger.Key[] {
    const dangling = new Set<Ledger.Key>();
    const check = (k: Ledger.Key): void => {
      if (!this.nodes.has(k)) dangling.add(k);
    };
    for (const [consumer, decl] of this.consumerDeclarations) {
      check(consumer);
      for (const producer of decl.edges.keys()) check(producer);
    }
    for (const [producer, consumers] of this.invalidates) {
      check(producer);
      for (const consumer of consumers) check(consumer);
    }
    for (const [consumer, producers] of this.dependsOn) {
      check(consumer);
      for (const producer of producers) check(producer);
    }
    for (const key of this.versionStore.keys()) check(key);
    return [...dangling];
  }

  /** Throw if any dangling reference survives (LR8 assert for tests). */
  assertNoOrphans(): void {
    const orphans = this.orphans();
    if (orphans.length > 0) {
      throw new Error(`ledger orphans (referenced but not a node): ${orphans.join(", ")}`);
    }
  }
}

export namespace Ledger {
  /**
   * An opaque, branded node key. Concrete construction (the `data:` / `pref:` /
   * `feed:` / `attr:` / `range` / `tz` union, design §3.1) happens sheets-side
   * at L3 via `key(...)`; the ledger never parses one (§3.4). Branded (`string &
   * { unique symbol }`) so it is non-interchangeable at compile time with the
   * raw strings it is minted from — mirrors the `Address` brand
   * (`sheets/src/ids/address-of.ts`).
   */
  export type Key = string & { readonly __ledgerKeyBrand: unique symbol };

  /** A consumer's declared edge to a producer, with the aspects + scope it depends on. */
  export interface EdgeInput<S> {
    readonly producer: Key;
    readonly facets: Iterable<DependencyAspect>;
    readonly scope: Option<S>;
  }

  /** The stored form of a declared edge (facets copied into an owned Set). */
  export interface Edge<S> {
    readonly facets: Set<DependencyAspect>;
    readonly scope: Option<S>;
  }

  /** A consumer's full generation-tagged edge set. */
  export interface Declaration<S> {
    readonly generation: number;
    readonly edges: Map<Key, Edge<S>>;
  }

  /**
   * The single brand-cast site — mint a `Key` from a raw string. Sheets-side
   * key construction (L3) routes through here; the accepted branded-string
   * pattern (a cast *to* the brand, never `any`).
   */
  export function key(raw: string): Key {
    return raw as Key;
  }
}
