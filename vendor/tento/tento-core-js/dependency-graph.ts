/**
 * Generic formula/row dependency graph with secondary indices for
 * label and lookup-key resolution. Parameterized over the node ID
 * type so each consumer (lona-js uses `RowLocalId`, tento/tento-lona-js/sheets
 * uses `RowLocalId`, SDKs may use `RowId`) plugs in its own identity.
 *
 * Builds on `@tento-core/directed-graph`: `DependencyGraph<T>` extends
 * `DirectedGraph<T>` and adds the secondary indices +
 * `addDependencyEdge` write path. Consumer-specific graph-building
 * helpers (regex extraction, AST walking, etc.) stay outside this
 * file.
 */

import {
  DirectedGraph,
  computeDependentsOnly,
  computeInvalidationSet,
  hasCycle,
  visitInvalidates,
} from "./directed-graph";
import { readonlySetView } from "./readonly-set-view";

/** How a formula references another row. */
export enum ReferenceType {
  ID = "id",
  LABEL = "label",
  LOOKUP_KEY = "lookup_key",
}

/**
 * What aspect of a producer node a consumer depends on.
 *
 * `VALUES` / `TITLE` / `EXISTENCE` are the formula-graph facets. `COVERAGE`
 * and `GEOMETRY` extend the vocabulary for the row-identity ledger (design:
 * `lona/lona-console/projects/sdk-2.0-performance.project.docs/content/row-identity-ledger.md`
 * §3.2) — `COVERAGE` = "is this range fetched" (fetch plane), `GEOMETRY` =
 * "does layout depend on it" (render plane). Crosswalk to the reconciliation
 * north-star `Facet`: `content = VALUES`, `structure = EXISTENCE`,
 * `geometry = GEOMETRY`. One vocabulary shared across the formula graph and the
 * ledger — no fork.
 */
export enum DependencyAspect {
  VALUES = "values",
  TITLE = "title",
  EXISTENCE = "existence",
  COVERAGE = "coverage",
  GEOMETRY = "geometry",
}

/** A dependency edge with metadata about how and why. */
export interface DependencyEdge<T> {
  targetRowId: T;
  referenceType: ReferenceType;
  referenceLiteral: Option<string>;
  aspects: Set<DependencyAspect>;
}

/**
 * Formula dependency graph. Secondary indexes allow the
 * invalidation path to ask "which rows reference this label /
 * lookup key?" in O(1) without scanning edges.
 */
export class DependencyGraph<T> extends DirectedGraph<T> {
  /** This graph's read face, built on first `DependencyGraph.readsOf`. */
  #reads: Option<DependencyGraphReads<T>> = null;

  /**
   * `graph`'s read face (`DependencyGraphReads`): a frozen object forwarding
   * the reads to the live graph — every set it answers (`nodes`, a row's
   * dependencies and dependents) a refusing live view (`readonlySetView`);
   * `edgesOf` a frozen copy of the row's edge list, each edge a frozen record
   * (`DependencyEdgeReads`, one per graph edge) whose `aspects` is a refusing
   * view — and nothing else, so `instanceof DependencyGraph`
   * is false and no cast reaches `addDependencyEdge` / `removeNode`. What an
   * owner that maintains its own edges hands out (`Sheet.graph`,
   * `SheetHandle.graph`); built once per graph, the same object on every read.
   */
  static readsOf<T>(graph: DependencyGraph<T>): DependencyGraphReads<T> {
    if (graph.#reads != null) return graph.#reads;
    const nodes = readonlySetView(graph.nodes);
    // One read record per graph edge, so repeated reads hand out the same one.
    const records = new WeakMap<DependencyEdge<T>, DependencyEdgeReads<T>>();
    const recordOf = (edge: DependencyEdge<T>): DependencyEdgeReads<T> => {
      const cached = records.get(edge);
      if (cached != null) return cached;
      const record: DependencyEdgeReads<T> = Object.freeze({
        targetRowId: edge.targetRowId,
        referenceType: edge.referenceType,
        referenceLiteral: edge.referenceLiteral,
        aspects: readonlySetView(edge.aspects),
      });
      records.set(edge, record);
      return record;
    };
    const face: DependencyGraphReads<T> = Object.freeze({
      get nodes() {
        return nodes;
      },
      hasNode: (id: T) => graph.hasNode(id),
      getDependencies: (id: T) => readonlySetView(graph.getDependencies(id)),
      getDirectDependents: (id: T) => readonlySetView(graph.getDirectDependents(id)),
      edgesOf: (id: T) => {
        const edges = graph.edgesOf(id);
        return edges.length === 0 ? NO_EDGES : Object.freeze(edges.map(recordOf));
      },
    });
    graph.#reads = face;
    return face;
  }

  readonly edges: Map<T, DependencyEdge<T>[]> = new Map();
  readonly labelToDependers: Map<string, Set<T>> = new Map();
  readonly lookupKeyToDependers: Map<string, Set<T>> = new Map();
  readonly unresolvedNames: Map<string, Set<T>> = new Map();

  addDependencyEdge(fromId: T, edge: DependencyEdge<T>): void {
    this.addDependency(fromId, edge.targetRowId);

    let edgeList = this.edges.get(fromId);
    if (!edgeList) {
      edgeList = [];
      this.edges.set(fromId, edgeList);
    }
    const isDuplicate = edgeList.some(
      (e) =>
        e.targetRowId === edge.targetRowId &&
        e.referenceType === edge.referenceType &&
        e.referenceLiteral === edge.referenceLiteral,
    );
    if (isDuplicate) return;
    edgeList.push(edge);

    if (edge.referenceType === ReferenceType.LABEL && edge.referenceLiteral) {
      addToSetIndex(this.labelToDependers, edge.referenceLiteral, fromId);
    }
    if (
      edge.referenceType === ReferenceType.LOOKUP_KEY &&
      edge.referenceLiteral
    ) {
      addToSetIndex(this.lookupKeyToDependers, edge.referenceLiteral, fromId);
    }
  }

  trackUnresolved(name: string, formulaRowId: T): void {
    addToSetIndex(this.unresolvedNames, name, formulaRowId);
  }

  /**
   * The dependency edges declared by `id` (empty array when none): the
   * graph's own list, typed read-only — the owner's read. A reader holds
   * `DependencyGraph.readsOf(graph).edgesOf`, which answers frozen copies.
   */
  edgesOf(id: T): readonly DependencyEdge<T>[] {
    return this.edges.get(id) ?? [];
  }

  protected override onEdgesCleared(id: T): void {
    const edgeList = this.edges.get(id);
    if (edgeList) {
      for (const edge of edgeList) {
        if (
          edge.referenceType === ReferenceType.LABEL &&
          edge.referenceLiteral
        ) {
          removeFromSetIndex(this.labelToDependers, edge.referenceLiteral, id);
        }
        if (
          edge.referenceType === ReferenceType.LOOKUP_KEY &&
          edge.referenceLiteral
        ) {
          removeFromSetIndex(
            this.lookupKeyToDependers,
            edge.referenceLiteral,
            id,
          );
        }
      }
      this.edges.delete(id);
    }

    for (const [name, set] of this.unresolvedNames) {
      set.delete(id);
      if (set.size === 0) this.unresolvedNames.delete(name);
    }
  }
}

/**
 * A dependency graph as a reader sees it: nodes and edges, no writes. What an
 * owner that maintains its own edges hands out (`Sheet.graph`,
 * `SheetHandle.graph`); `DependencyGraph` satisfies it.
 */
export interface DependencyGraphReads<T> {
  readonly nodes: ReadonlySet<T>;
  hasNode(id: T): boolean;
  /** Rows `id` reads from. */
  getDependencies(id: T): ReadonlySet<T>;
  /** Rows that read from `id` directly. */
  getDirectDependents(id: T): ReadonlySet<T>;
  /** The dependency edges `id` declares. */
  edgesOf(id: T): ReadonlyArray<DependencyEdgeReads<T>>;
}

/**
 * A dependency edge as a reader sees it (`DependencyGraphReads.edgesOf`):
 * every field read-only, `aspects` a `ReadonlySet`. `DependencyEdge`
 * satisfies it.
 */
export interface DependencyEdgeReads<T> {
  readonly targetRowId: T;
  readonly referenceType: ReferenceType;
  readonly referenceLiteral: Option<string>;
  readonly aspects: ReadonlySet<DependencyAspect>;
}

/** The read face's edge list for a row that declares none. */
const NO_EDGES: ReadonlyArray<never> = Object.freeze([]);

export namespace DependencyGraph {
  export function visit<T>(
    graph: DependencyGraph<T>,
    id: T,
    fn: (id: T) => void,
    visited?: Set<T>,
  ): void {
    visitInvalidates(graph, id, fn, visited);
  }

  export function invalidationSet<T>(
    graph: DependencyGraph<T>,
    id: T,
  ): Set<T> {
    return computeInvalidationSet(graph, id);
  }

  export function dependentsOnly<T>(
    graph: DependencyGraph<T>,
    id: T,
  ): Set<T> {
    return computeDependentsOnly(graph, id);
  }

  export function cycleCheck<T>(
    graph: DependencyGraph<T>,
    startId: T,
  ): boolean {
    return hasCycle(graph, startId);
  }
}

function addToSetIndex<T>(
  index: Map<string, Set<T>>,
  key: string,
  value: T,
): void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(value);
}

function removeFromSetIndex<T>(
  index: Map<string, Set<T>>,
  key: string,
  value: T,
): void {
  const set = index.get(key);
  if (set) {
    set.delete(value);
    if (set.size === 0) index.delete(key);
  }
}
