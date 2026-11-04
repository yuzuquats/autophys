// The branch graph's geometry, with no DOM in it: which lane each row sits
// on, and which lines cross each row and each gap between rows. The component
// (`branch-graph.ts`) only draws what this returns, so every decision about a
// git tree's SHAPE is pinned by a deno test here rather than by a screenshot.
//
// Two entry points, one vocabulary:
//
//   `route(rows)`    rows that already carry a lane, and their edges by id →
//                    the lines to draw. This is what the component calls.
//
//   `fromDag(nodes)` a DAG in no particular layout → rows with lanes and with
//                    every edge's lane decided, ready for `route`. This is the
//                    `git log --graph` part, for a caller that has a graph and
//                    no opinion about lanes (the onboarding canvas's journey,
//                    a fleet of hosts' stacks).
//
// THE MODEL. Rows run top to bottom and edges always point DOWN the list. A
// row sits on one lane. An edge from row i (lane a) to row j (lane b) travels
// on ONE lane, its `via`, through the rows strictly between them:
//
//   via == a   it leaves on its source's lane and curves into b in the gap
//              just above row j — a merge, or a branch that splits off the
//              trunk late ("lazy" fork).
//   via == b   it curves out of a in the gap just below row i and runs down
//              b — a fork, the way `git log --graph` draws one.
//   otherwise  both: out of a below row i, down `via`, into b above row j.
//
// Curves only ever happen in a GAP between two rows, never inside a row; a
// gap that holds one is drawn as a short strip (the stack log's fork row),
// and a gap that holds none is not drawn at all — the rows' own full-height
// segments meet at the row boundary. That is the property that keeps rows
// real DOM sized by their text: nothing here needs to know a row's height.

export namespace BranchLayout {
  /** solid = history; dashed = a discontinuity or a skip; dotted = not
   * history yet (the stack log's pre-commit region) or elsewhere. */
  export type LineStyle = "solid" | "dashed" | "dotted";

  /** An edge out of a row, by the target row's id. */
  export type Edge = {
    to: string;
    style?: LineStyle;
    /** Part of the path the reader actually took — drawn stronger. */
    walked?: boolean;
    /** The lane it travels between its two rows (see the top of this file).
     * Omitted: the target's lane when that lane is clear between them (a
     * fork), else the source's (a merge). `fromDag` always decides it. */
    via?: number;
    /** Shown in the strip where the edge first curves; nowhere when it
     * never curves. */
    label?: string;
  };

  export type RowInput = {
    id: string;
    lane: number;
    next: readonly Edge[];
    /** The lane arrives from above the list — history the list does not
     * show. Null: the lane starts at this row (or an edge brings it). */
    enter?: Option<LineStyle>;
    /** The lane carries on past the bottom of the list. */
    exit?: Option<LineStyle>;
  };

  /** A vertical run on one lane. */
  export type Line = { lane: number; style: LineStyle; walked: boolean };

  /** A connection across a gap: straight when `from == to`, else a curve. */
  export type Link = { from: number; to: number; style: LineStyle; walked: boolean };

  export type RowLayout = {
    lane: number;
    /** Into this row's mark from the top of the row. */
    above: Option<Line>;
    /** Out of this row's mark to the bottom of the row. */
    below: Option<Line>;
    /** Lanes that pass the row by, top to bottom, without touching it. */
    through: Line[];
  };

  /** The gap after row `i` (so `gaps.length == rows.length - 1`). */
  export type Gap = {
    links: Link[];
    /** Any link changes lane: the gap is drawn as a strip. */
    curved: boolean;
    /** Lanes a curve ENTERS here (a lane opening, or a merge target). */
    opens: number[];
    /** Edge labels whose first curve is in this gap, by the lane the
     * curve heads for. */
    labels: { lane: number; text: string }[];
  };

  export type Layout = {
    /** Lanes in use: one more than the highest lane anything touches. */
    lanes: number;
    rows: RowLayout[];
    gaps: Gap[];
    /** Edges that could not be drawn (unknown target, pointing up). */
    errors: string[];
  };

  /** Two edges on the same stretch of lane are one line. The walked one
   * wins (it is the stronger stroke), then the more solid style. */
  function stronger<T extends { style: LineStyle; walked: boolean }>(a: Option<T>, b: T): T {
    if (a == null) return b;
    if (a.walked !== b.walked) return a.walked ? a : b;
    const rank: Record<LineStyle, number> = { solid: 0, dashed: 1, dotted: 2 };
    return rank[b.style] < rank[a.style] ? b : a;
  }

  /** The lines to draw for rows that already have lanes. Pure: same rows,
   * same lines. */
  export function route(rows: readonly RowInput[]): Layout {
    const n = rows.length;
    const at = new Map<string, number>();
    rows.forEach((r, i) => at.set(r.id, i));
    const errors: string[] = [];
    let maxLane = rows.reduce((m, r) => Math.max(m, r.lane), -1);

    const above: Option<Line>[] = rows.map(() => null);
    const below: Option<Line>[] = rows.map(() => null);
    const through: Map<number, Line>[] = rows.map(() => new Map());
    const links: Map<string, Link>[] = rows.slice(1).map(() => new Map());
    const labels: Gap["labels"][] = rows.slice(1).map(() => []);

    const addThrough = (r: number, lane: number, style: LineStyle, walked: boolean) => {
      const line = { lane, style, walked };
      through[r].set(lane, stronger(through[r].get(lane), line));
    };
    const addLink = (g: number, from: number, to: number, style: LineStyle, walked: boolean) => {
      const key = `${from}>${to}`;
      links[g].set(key, stronger(links[g].get(key), { from, to, style, walked }));
    };

    // A lane is clear between two rows when no row in between sits on it.
    const clear = (lane: number, i: number, j: number) => {
      for (let r = i + 1; r < j; r++) if (rows[r].lane === lane) return false;
      return true;
    };

    rows.forEach((row, i) => {
      for (const e of row.next) {
        const j = at.get(e.to);
        if (j == null) {
          errors.push(`${row.id} → ${e.to}: no such row`);
          continue;
        }
        if (j <= i) {
          errors.push(`${row.id} → ${e.to}: points up the list`);
          continue;
        }
        const a = row.lane;
        const b = rows[j].lane;
        const style = e.style ?? "solid";
        const walked = e.walked === true;
        const via = e.via ?? (a === b ? a : clear(b, i, j) ? b : clear(a, i, j) ? a : b);
        maxLane = Math.max(maxLane, via);
        below[i] = stronger(below[i], { lane: a, style, walked });
        above[j] = stronger(above[j], { lane: b, style, walked });
        let firstCurve: Option<{ gap: number; lane: number }> = null;
        if (j === i + 1) {
          addLink(i, a, b, style, walked);
          if (a !== b) firstCurve = { gap: i, lane: b };
        } else {
          addLink(i, a, via, style, walked);
          for (let r = i + 1; r < j; r++) addThrough(r, via, style, walked);
          for (let g = i + 1; g < j - 1; g++) addLink(g, via, via, style, walked);
          addLink(j - 1, via, b, style, walked);
          if (a !== via) firstCurve = { gap: i, lane: via };
          else if (via !== b) firstCurve = { gap: j - 1, lane: b };
        }
        if (e.label && firstCurve != null) {
          labels[firstCurve.gap].push({ lane: firstCurve.lane, text: e.label });
        }
      }
    });

    // History above and below the list: the lane runs to the edge of it.
    rows.forEach((row, i) => {
      if (row.enter != null) {
        above[i] = stronger(above[i], { lane: row.lane, style: row.enter, walked: false });
        for (let r = 0; r < i; r++) addThrough(r, row.lane, row.enter, false);
        for (let g = 0; g < i; g++) addLink(g, row.lane, row.lane, row.enter, false);
      }
      if (row.exit != null) {
        below[i] = stronger(below[i], { lane: row.lane, style: row.exit, walked: false });
        for (let r = i + 1; r < n; r++) addThrough(r, row.lane, row.exit, false);
        for (let g = i; g < n - 1; g++) addLink(g, row.lane, row.lane, row.exit, false);
      }
    });

    // A lane passing a row ON the row's own lane is drawn by the row's
    // above/below halves instead — the mark sits on it, and a line drawn
    // straight through would cross the mark.
    rows.forEach((row, i) => {
      const t = through[i].get(row.lane);
      if (t == null) return;
      through[i].delete(row.lane);
      above[i] = stronger(above[i], t);
      below[i] = stronger(below[i], t);
    });

    const sortLines = (ls: Line[]) => ls.sort((x, y) => x.lane - y.lane || Number(x.walked) - Number(y.walked));
    return {
      lanes: maxLane + 1,
      rows: rows.map((row, i) => ({
        lane: row.lane,
        above: above[i],
        below: below[i],
        through: sortLines([...through[i].values()]),
      })),
      gaps: links.map((m, g) => {
        // Straight first, walked last: a curve sits over the line it leaves,
        // and the walked path sits over everything.
        const ls = [...m.values()].sort((x, y) =>
          Number(x.from !== x.to) - Number(y.from !== y.to) || Number(x.walked) - Number(y.walked) || x.from - y.from || x.to - y.to
        );
        const opens = [...new Set(ls.filter((l) => l.from !== l.to).map((l) => l.to))].sort((x, y) => x - y);
        return { links: ls, curved: opens.length > 0, opens, labels: labels[g] };
      }),
      errors,
    };
  }

  // --- lanes from a DAG -----------------------------------------------------

  /** A node of a DAG, with its edges out. The FIRST edge is the node's
   * continuation: its target keeps the node's lane when it can (git's first
   * parent, turned the other way up). */
  export type DagNode = {
    id: string;
    next: readonly Omit<Edge, "via">[];
  };

  /** How `fromDag` orders the rows.
   *
   *   given        as passed (it must already be topological; an edge that
   *                points up is dropped and reported).
   *   side-first   topological, and at every fork the side branches come
   *                BEFORE the continuation, each run kept together. A side
   *                branch that ends (or rejoins soon) is drawn and closed
   *                right under its fork, so lanes stay short and the trunk
   *                stays on lane 0 from top to bottom. The reading order of
   *                a funnel: "here some leave; the rest go on". Side
   *                branches that never rejoin the continuation come before
   *                those that do, so a rejoining lane is the last one opened
   *                and closes straight into its merge instead of running
   *                alongside a branch that ends.
   *   trunk-first  topological, continuation first and the side branches
   *                after it — `git log --graph --topo-order` turned over.
   *                Branch lanes run alongside the whole trunk until their
   *                rows come up. */
  export type Order = "given" | "side-first" | "trunk-first";

  /** When a side edge leaves its source's lane.
   *
   *   eager   in the gap right under the source, onto a lane of its own
   *           (git's `|\`).
   *   lazy    the edges out of a row ride its lane together and each one
   *           splits off in the gap right above its target — no lane is
   *           held open for a branch that has not started yet.
   *
   * Default: lazy for side-first (the branch's rows follow its fork at
   * once, so the two read the same and lazy holds fewer lanes), eager
   * otherwise. */
  export type Forks = "eager" | "lazy";

  export type DagLayout = { rows: (RowInput & { next: Edge[] })[]; errors: string[] };

  /** Lanes for a DAG, git-log style: rows in topological order; a row takes
   * the lane of the edge that reaches it (the leftmost, when several do —
   * the others MERGE into it); the first edge out of a row continues that
   * row's lane; every other edge opens a lane of its own; a lane is free
   * again once nothing is travelling on it, after a merge or at a row with
   * no edges out (a terminal). Lanes do not shift sideways once taken — a
   * freed lane is reused by the next branch that needs one, lowest first. */
  export function fromDag(
    nodes: readonly DagNode[],
    opts: { order?: Order; forks?: Forks } = {},
  ): DagLayout {
    const errors: string[] = [];
    const orderMode = opts.order ?? "side-first";
    const forks: Forks = opts.forks ?? (orderMode === "side-first" ? "lazy" : "eager");
    const cyclic = new Set<string>();
    const order = orderOf(nodes, orderMode, cyclic);
    const rowOf = new Map(order.map((node, i) => [node.id, i]));

    // A column is a lane and the edges travelling on it. Lazy forks put
    // every edge out of a row in ONE column (they ride its lane together);
    // eager forks give each its own.
    type Travelling = { to: string };
    const columns: Option<Travelling[]>[] = [];
    const lowestFree = () => {
      const k = columns.findIndex((c) => c == null);
      return k < 0 ? columns.length : k;
    };

    const rows: DagLayout["rows"] = [];
    for (const node of order) {
      // Every column carrying an edge to this node; the node sits on the
      // leftmost one that carries NOTHING else (an exclusive column), and
      // when none is exclusive — its edge is sharing a lane with siblings
      // still on their way — it splits off onto a lane of its own.
      const reaching: number[] = [];
      columns.forEach((c, k) => {
        if (c != null && c.some((t) => t.to === node.id)) reaching.push(k);
      });
      const exclusive = reaching.find((k) => columns[k]!.every((t) => t.to === node.id));
      for (const k of reaching) {
        const left = columns[k]!.filter((t) => t.to !== node.id);
        columns[k] = left.length > 0 ? left : null;
      }
      // Every reaching edge recorded its `via` when it set off; `route`
      // curves it from there into `lane` in the gap above this row.
      const lane = exclusive ?? lowestFree();

      const next: Edge[] = [];
      const out = node.next.filter((e) => {
        const j = rowOf.get(e.to);
        if (j == null) {
          errors.push(`${node.id} → ${e.to}: no such node`);
          return false;
        }
        if (j <= rowOf.get(node.id)!) {
          const why = cyclic.has(`${node.id}>${e.to}`) ? "closes a cycle" : "points up the list";
          errors.push(`${node.id} → ${e.to}: ${why}; not drawn`);
          return false;
        }
        return true;
      });
      if (forks === "lazy") {
        if (out.length > 0) {
          const bundle: Travelling[] = [];
          for (const e of out) {
            const edge: Edge = { ...e, via: lane };
            next.push(edge);
            bundle.push({ to: e.to });
          }
          columns[lane] = bundle;
        }
      } else {
        // The first edge takes this row's lane, so by the time a side edge
        // asks for the lowest free lane this one is already spoken for.
        out.forEach((e, k) => {
          const via = k === 0 ? lane : lowestFree();
          const edge: Edge = { ...e, via };
          next.push(edge);
          columns[via] = [{ to: e.to }];
        });
      }
      rows.push({ id: node.id, lane, next });
    }
    return { rows, errors };
  }

  /** The row order for `fromDag`. Topological orders are a reverse
   * postorder of a depth-first walk: roots are walked last-to-first and a
   * node's edges in the order that leaves the wanted sibling LAST in the
   * postorder, so it comes FIRST once reversed. A shared descendant is
   * always placed after every one of its sources. */
  function orderOf(nodes: readonly DagNode[], mode: Order, cyclic: Set<string>): DagNode[] {
    if (mode === "given") return [...nodes];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const hasParent = new Set<string>();
    for (const n of nodes) for (const e of n.next) if (byId.has(e.to)) hasParent.add(e.to);
    // Everything reachable from a node, itself included (memoised; a cycle
    // just stops the walk).
    const reached = new Map<string, Set<string>>();
    const reach = (id: string): Set<string> => {
      const known = reached.get(id);
      if (known) return known;
      const set = new Set<string>([id]);
      reached.set(id, set);
      for (const e of byId.get(id)?.next ?? []) if (byId.has(e.to)) for (const x of reach(e.to)) set.add(x);
      return set;
    };
    const post: DagNode[] = [];
    const state = new Map<string, "open" | "done">();
    const visit = (n: DagNode) => {
      state.set(n.id, "open");
      const kids = n.next.filter((e) => byId.has(e.to));
      // side-first: display P, c2..ck, c1 → walk c1, ck..c2.
      // trunk-first: display P, c1..ck → walk ck..c1.
      let sides = kids.slice(1);
      if (mode === "side-first" && kids.length > 2) {
        const trunk = reach(kids[0]!.to);
        const rejoins = (e: { to: string }) => [...reach(e.to)].some((id) => trunk.has(id));
        sides = [...sides.filter((e) => !rejoins(e)), ...sides.filter(rejoins)];
      }
      const walk = mode === "side-first" ? [...kids.slice(0, 1), ...sides.reverse()] : [...kids].reverse();
      for (const e of walk) {
        const s = state.get(e.to);
        if (s === "open") {
          // A back edge. It will point up the list, and `fromDag` drops it
          // there; this only remembers why.
          cyclic.add(`${n.id}>${e.to}`);
          continue;
        }
        if (s == null) visit(byId.get(e.to)!);
      }
      state.set(n.id, "done");
      post.push(n);
    };
    const roots = nodes.filter((n) => !hasParent.has(n.id));
    for (const r of [...roots].reverse()) if (!state.has(r.id)) visit(r);
    // Anything only reachable through a cycle: walk it from where it was
    // listed, after everything else.
    for (const n of [...nodes].reverse()) if (!state.has(n.id)) visit(n);
    return post.reverse();
  }
}
