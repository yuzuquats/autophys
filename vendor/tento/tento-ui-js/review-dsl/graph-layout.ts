// First-party layered DAG layout (sugiyama-lite) for review-note diagrams.
// Scope-matched to review-sized graphs (≤25 nodes): longest-path layering,
// dummy cells for long edges, a few barycenter ordering sweeps. Deterministic
// for a given input (stable sorts keyed by declaration order) — no
// randomness, no DOM, and no text measurement: the output is a **grid** —
// (col, row) cells — and the DOM does all sizing. Renderers place real
// elements in a CSS grid and route connector paths from measured boxes
// (see components/review-notes/graph-grid.ts). The NP-hard refinements
// (optimal crossing minimization, Brandes-Köpf) only pay off far above this
// size class.

export namespace GraphLayout {
  export type EdgeIn = { from: string; to: string };
  export type Cell = { col: number; row: number };
  export type Out = {
    cols: number;
    rows: number;
    /** Grid cells for real nodes, keyed by node id. */
    cells: Map<string, Cell>;
    /** Edges in the author's orientation; `via` lists the empty cells a
     * long edge routes through (one per skipped rank). */
    edges: { from: string; to: string; via: Cell[] }[];
  };

  type V = {
    id: string;
    rank: number;
    pos: number; // order within rank
    coord: number; // continuous cross-axis center, quantized to a row at exit
    dummy: boolean;
  };

  /**
   * `maxCross` is the container's horizontal budget: how many node boxes fit
   * side by side. A rank with more members than that tiles into extra lines
   * *inside its own band* — the diagram grows downward instead of overflowing
   * a narrow column — and the ranks below shift down to keep every cell
   * collision-free. `null` = unbounded (the natural layout).
   *
   * The budget only bites in TD, where the cross axis is the horizontal one.
   * An LR diagram's width is its rank count, which cannot wrap without
   * breaking reading order, so the renderer flips LR→TD first and spends the
   * budget there (see graph-grid's `fit`).
   */
  export function layout(
    ids: string[],
    edgesIn: EdgeIn[],
    dir: "LR" | "TD",
    maxCross: Option<number>,
  ): Out {
    const vs = new Map<string, V>();
    ids.forEach((id, i) => {
      vs.set(id, { id, rank: 0, pos: i, coord: 0, dummy: false });
    });
    const edges = edgesIn
      .filter((e) => vs.has(e.from) && vs.has(e.to) && e.from !== e.to)
      .map((e) => ({ from: e.from, to: e.to, reversed: false }));

    breakCycles(vs, edges);
    assignRanks(vs, edges);

    // Split long edges through per-rank dummy vertices.
    type Chain = { from: string; to: string; reversed: boolean; via: string[] };
    const chains: Chain[] = [];
    let dummyN = 0;
    for (const e of edges) {
      const a = vs.get(e.from)!;
      const b = vs.get(e.to)!;
      const via: string[] = [];
      for (let r = a.rank + 1; r < b.rank; r++) {
        const id = ` dummy${dummyN++}`;
        vs.set(id, { id, rank: r, pos: vs.size, coord: 0, dummy: true });
        via.push(id);
      }
      chains.push({ ...e, via });
    }

    orderRanks(vs, chains);
    settleCoords(vs, chains);

    // Quantize continuous cross coordinates to distinct integer lanes per
    // rank (rank order preserved), then transpose for TD.
    const ranks: V[][] = [];
    for (const v of vs.values()) {
      (ranks[v.rank] ?? (ranks[v.rank] = [])).push(v);
    }
    const rankCount = ranks.length;
    const budget = dir === "TD" ? maxCross : null;
    /** Lane on the cross axis. */
    const crossOf = new Map<string, number>();
    /** Which line *within* the rank's band — non-zero only where it tiled. */
    const lineOf = new Map<string, number>();
    /** Lines each rank's band occupies; the bands stack in rank order. */
    const bandLines: number[] = [];
    let maxCrossUsed = 0;
    for (let r = 0; r < rankCount; r++) {
      const rank = ranks[r];
      if (rank == null) {
        bandLines[r] = 0; // ranks may be sparse after tightening
        continue;
      }
      rank.sort((a, b) => a.pos - b.pos);
      // The natural lanes: coord-quantized, so a lone node stays centered
      // against its neighbors and gaps are allowed.
      const natural: number[] = [];
      let prev = -1;
      for (const v of rank) {
        const lane = Math.max(Math.round(v.coord), prev + 1);
        natural.push(lane);
        prev = lane;
      }
      if (budget == null || prev < budget) {
        rank.forEach((v, i) => {
          crossOf.set(v.id, natural[i]);
          lineOf.set(v.id, 0);
        });
        bandLines[r] = 1;
        maxCrossUsed = Math.max(maxCrossUsed, prev);
        continue;
      }
      // Over budget: pack the rank edge-to-edge and tile the overflow onto
      // further lines of the same band. Gaps are the first thing to go — a
      // diagram that fits beats a diagram that is prettily centered.
      rank.forEach((v, i) => {
        crossOf.set(v.id, i % budget);
        lineOf.set(v.id, Math.floor(i / budget));
      });
      bandLines[r] = Math.ceil(rank.length / budget);
      maxCrossUsed = Math.max(maxCrossUsed, Math.min(rank.length, budget) - 1);
    }
    // Bands are row-disjoint, so (lane, line) staying unique inside a rank is
    // enough to keep the whole grid collision-free.
    const bandStart: number[] = [];
    let lineTotal = 0;
    for (let r = 0; r < rankCount; r++) {
      bandStart[r] = lineTotal;
      lineTotal += bandLines[r] ?? 0;
    }
    const at = (id: string): Cell => {
      const v = vs.get(id)!;
      return dir === "TD"
        ? { col: crossOf.get(id)!, row: bandStart[v.rank] + lineOf.get(id)! }
        : { col: v.rank, row: crossOf.get(id)! };
    };

    const cells = new Map<string, Cell>();
    for (const v of vs.values()) {
      if (!v.dummy) cells.set(v.id, at(v.id));
    }
    const outEdges = chains.map((c) => {
      const via = c.via.map(at);
      return c.reversed
        ? { from: c.to, to: c.from, via: [...via].reverse() }
        : { from: c.from, to: c.to, via };
    });

    return {
      cols: dir === "TD" ? maxCrossUsed + 1 : rankCount,
      rows: dir === "TD" ? lineTotal : maxCrossUsed + 1,
      cells,
      edges: outEdges,
    };
  }

  type E = { from: string; to: string; reversed: boolean };

  /** DFS from declaration order; back edges get flipped (rendering restores
   * the author's direction via the `reversed` flag). */
  function breakCycles(vs: Map<string, V>, edges: E[]): void {
    const state = new Map<string, "active" | "done">();
    const out = new Map<string, E[]>();
    for (const e of edges) {
      const list = out.get(e.from) ?? [];
      list.push(e);
      out.set(e.from, list);
    }
    const visit = (id: string): void => {
      state.set(id, "active");
      for (const e of out.get(id) ?? []) {
        const s = state.get(e.to);
        if (s === "active") {
          const from = e.from;
          e.from = e.to;
          e.to = from;
          e.reversed = !e.reversed;
        } else if (s == null) {
          visit(e.to);
        }
      }
      state.set(id, "done");
    };
    for (const id of vs.keys()) if (!state.has(id)) visit(id);
  }

  /** Longest-path layering; then pull single-parent sources next to their
   * children so lone entry points don't all pile into rank 0. */
  function assignRanks(vs: Map<string, V>, edges: E[]): void {
    const incoming = new Map<string, E[]>();
    for (const e of edges) {
      const list = incoming.get(e.to) ?? [];
      list.push(e);
      incoming.set(e.to, list);
    }
    const memo = new Map<string, number>();
    const rankOf = (id: string): number => {
      const known = memo.get(id);
      if (known != null) return known;
      memo.set(id, 0); // cycle guard (cycles already broken; belt+suspenders)
      let r = 0;
      for (const e of incoming.get(id) ?? []) {
        r = Math.max(r, rankOf(e.from) + 1);
      }
      memo.set(id, r);
      return r;
    };
    for (const v of vs.values()) v.rank = rankOf(v.id);
    // Tighten: a node with outgoing edges only sits just before its nearest
    // successor (keeps side-inputs visually near their consumers).
    const outgoing = new Map<string, E[]>();
    for (const e of edges) {
      const list = outgoing.get(e.from) ?? [];
      list.push(e);
      outgoing.set(e.from, list);
    }
    for (const v of vs.values()) {
      const outs = outgoing.get(v.id) ?? [];
      if (outs.length === 0 || (incoming.get(v.id) ?? []).length > 0) continue;
      v.rank = Math.min(...outs.map((e) => vs.get(e.to)!.rank)) - 1;
    }
  }

  /** Barycenter ordering sweeps over adjacency built from the dummy-expanded
   * chains (each chain contributes rank-adjacent hops only). */
  function orderRanks(
    vs: Map<string, V>,
    chains: { from: string; to: string; via: string[] }[],
  ): void {
    const hops: [string, string][] = [];
    for (const c of chains) {
      const path = [c.from, ...c.via, c.to];
      for (let i = 0; i + 1 < path.length; i++) hops.push([path[i], path[i + 1]]);
    }
    const prev = new Map<string, string[]>();
    const next = new Map<string, string[]>();
    for (const [a, b] of hops) {
      (next.get(a) ?? next.set(a, []).get(a)!).push(b);
      (prev.get(b) ?? prev.set(b, []).get(b)!).push(a);
    }
    const ranks: V[][] = [];
    for (const v of vs.values()) {
      (ranks[v.rank] ?? (ranks[v.rank] = [])).push(v);
    }
    for (const rank of ranks) rank?.sort((a, b) => a.pos - b.pos);
    const reindex = (): void => {
      for (const rank of ranks) rank?.forEach((v, i) => (v.pos = i));
    };
    reindex();
    const sweep = (adj: Map<string, string[]>, order: number[]): void => {
      for (const r of order) {
        const rank = ranks[r];
        if (rank == null) continue;
        const bary = new Map<string, number>();
        for (const v of rank) {
          const ns = adj.get(v.id) ?? [];
          bary.set(
            v.id,
            ns.length === 0
              ? v.pos
              : ns.reduce((sum, id) => sum + vs.get(id)!.pos, 0) / ns.length,
          );
        }
        rank.sort((a, b) => bary.get(a.id)! - bary.get(b.id)! || a.pos - b.pos);
        rank.forEach((v, i) => (v.pos = i));
      }
    };
    const down = ranks.map((_, i) => i).slice(1);
    const up = ranks.map((_, i) => i).slice(0, -1).reverse();
    sweep(prev, down);
    sweep(next, up);
    sweep(prev, down);
  }

  /** Continuous cross-axis positions (unit cells): pack each rank, then relax
   * toward neighbor averages with push-apart, so a lone node settles centered
   * against its neighbors before row quantization. */
  function settleCoords(
    vs: Map<string, V>,
    chains: { from: string; to: string; via: string[] }[],
  ): void {
    const ranks: V[][] = [];
    for (const v of vs.values()) {
      (ranks[v.rank] ?? (ranks[v.rank] = [])).push(v);
    }
    for (const rank of ranks) rank?.sort((a, b) => a.pos - b.pos);
    for (const rank of ranks) {
      if (rank == null) continue;
      rank.forEach((v, i) => (v.coord = i));
    }
    const neighbors = new Map<string, string[]>();
    for (const c of chains) {
      const path = [c.from, ...c.via, c.to];
      for (let i = 0; i + 1 < path.length; i++) {
        (neighbors.get(path[i]) ?? neighbors.set(path[i], []).get(path[i])!).push(path[i + 1]);
        (neighbors.get(path[i + 1]) ?? neighbors.set(path[i + 1], []).get(path[i + 1])!).push(path[i]);
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const rank of ranks) {
        if (rank == null) continue;
        for (const v of rank) {
          const ns = neighbors.get(v.id) ?? [];
          if (ns.length === 0) continue;
          v.coord = ns.reduce((sum, id) => sum + vs.get(id)!.coord, 0) / ns.length;
        }
        for (let i = 1; i < rank.length; i++) {
          const a = rank[i - 1];
          const b = rank[i];
          if (b.coord - a.coord < 1) b.coord = a.coord + 1;
        }
      }
    }
    let min = Infinity;
    for (const v of vs.values()) min = Math.min(min, v.coord);
    for (const v of vs.values()) v.coord -= min;
  }
}
