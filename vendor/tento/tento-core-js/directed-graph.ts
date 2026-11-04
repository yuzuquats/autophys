/**
 * Generic directed dependency graph with invalidation traversal.
 *
 * Structure:
 *   dependsOn:    from → Set<to>   (forward edges: "I depend on these")
 *   invalidates:  to   → Set<from> (reverse edges: "these depend on me")
 *
 * Always kept in sync by addDependency/removeNode/clearDependencies.
 */
export class DirectedGraph<T> {
  readonly nodes: Set<T> = new Set();
  readonly dependsOn: Map<T, Set<T>> = new Map();
  readonly invalidates: Map<T, Set<T>> = new Map();

  addNode(id: T): void {
    this.nodes.add(id);
  }

  hasNode(id: T): boolean {
    return this.nodes.has(id);
  }

  addDependency(from: T, to: T): void {
    const deps =
      this.dependsOn.get(from) ??
      this.dependsOn.set(from, new Set()).get(from)!;
    deps.add(to);

    const inv =
      this.invalidates.get(to) ??
      this.invalidates.set(to, new Set()).get(to)!;
    inv.add(from);
  }

  getDirectDependents(id: T): Set<T> {
    return this.invalidates.get(id) ?? new Set();
  }

  getDependencies(id: T): Set<T> {
    return this.dependsOn.get(id) ?? new Set();
  }

  /**
   * Clear all outgoing dependency edges for a node, keeping the node itself.
   * Removes from both forward (dependsOn) and reverse (invalidates) maps.
   * Calls onEdgesCleared() so subclasses can clean secondary indexes.
   */
  clearDependencies(id: T): void {
    const deps = this.dependsOn.get(id);
    if (deps) {
      for (const target of deps) {
        const inv = this.invalidates.get(target);
        if (inv) {
          inv.delete(id);
          if (inv.size === 0) this.invalidates.delete(target);
        }
      }
      this.dependsOn.delete(id);
    }
    this.onEdgesCleared(id);
  }

  /**
   * Remove a node from the graph entirely.
   * Cleans up all edges involving this node.
   */
  removeNode(id: T): void {
    this.clearDependencies(id);
    this.nodes.delete(id);
    this.invalidates.delete(id);
    for (const invalidatesSet of this.invalidates.values()) {
      invalidatesSet.delete(id);
    }
    // Symmetric cleanup of outbound edges that other nodes hold
    // pointing to `id`. Without this, `getDependencies(otherId)`
    // keeps returning the now-deleted id and downstream consumers
    // (e.g. fuzz soundness checks comparing graph edges to live
    // expression refs) see a dangling reference.
    for (const dependsOnSet of this.dependsOn.values()) {
      dependsOnSet.delete(id);
    }
  }

  /** Override in subclasses to clean secondary indexes after edges are cleared. */
  protected onEdgesCleared(_id: T): void {}
}

export function visitInvalidates<T>(
  graph: DirectedGraph<T>,
  id: T,
  visit: (id: T) => void,
  visited: Set<T> = new Set(),
): void {
  if (visited.has(id)) return;
  visit(id);
  visited.add(id);

  const invalidates = graph.invalidates.get(id);
  if (!invalidates) return;
  for (const dep of invalidates) {
    visitInvalidates(graph, dep, visit, visited);
  }
}

export function computeInvalidationSet<T>(
  graph: DirectedGraph<T>,
  id: T,
): Set<T> {
  const result = new Set<T>();
  visitInvalidates(graph, id, (r) => result.add(r));
  return result;
}

export function computeDependentsOnly<T>(
  graph: DirectedGraph<T>,
  id: T,
): Set<T> {
  const result = new Set<T>();
  visitInvalidates(graph, id, (r) => {
    if (r !== id) result.add(r);
  });
  return result;
}

export function hasCycle<T>(
  graph: DirectedGraph<T>,
  startId: T,
): boolean {
  const visited = new Set<T>();
  const stack = new Set<T>();

  function dfs(id: T): boolean {
    if (stack.has(id)) return true;
    if (visited.has(id)) return false;

    visited.add(id);
    stack.add(id);

    const deps = graph.dependsOn.get(id);
    if (deps) {
      for (const dep of deps) {
        if (dfs(dep)) return true;
      }
    }

    stack.delete(id);
    return false;
  }

  return dfs(startId);
}
