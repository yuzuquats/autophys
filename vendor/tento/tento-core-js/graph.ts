export class Graph<T> {
  v: Set<T>;
  edges: Map<T, T[]> = new Map();

  constructor(v: T[] = []) {
    this.v = new Set(v);
  }

  addVertex(n: T) {
    this.v.add(n);
  }

  addEdge(from: T, to: T) {
    let edges = this.edges.get(from);
    if (!edges) {
      edges = [];
      this.edges.set(from, edges);
    }
    edges.push(to);
  }

  getEdgesForNode(n: T): T[] {
    return this.edges.get(n) ?? [];
  }

  dfs(v: T, visit: (v: T) => void, visited = new Set<T>()) {
    visited.add(v);
    visit(v);
    for (const n of this.edges.get(v) ?? []) {
      if (visited.has(n)) continue;
      this.dfs(n, visit, visited);
    }
  }

  topsort(visit: (v: T) => void) {
    const s: T[] = [];
    const visited = new Set<T>();
    const dfsNode = (p: T) => {
      visited.add(p);
      for (const n of this.edges.get(p) ?? []) {
        if (visited.has(n)) continue;
        dfsNode(n);
      }
      s.push(p);
    };

    for (const n of this.v.values()) {
      if (visited.has(n)) continue;
      dfsNode(n);
    }
    s.reverse().forEach(visit);
  }
}
