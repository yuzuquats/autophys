/**
 * Property tests for the interval walks of `AVLTree.Node.Many`
 * (`findAllOverlaps`, `findAllOverlapsNodes`, `findAllOverlapsExclusiveEnd`,
 * `findAllOverlapsInclusiveEnd`): they skip a right subtree once the node's
 * own key (its values' start) is past the query's end — every key to the
 * right is larger, so nothing there can start in time. The answer must be
 * exactly what the unpruned walk (left pruned by `max`, right always visited)
 * answered: the same values in the same order, over random interval sets
 * with shared starts, after inserts and deletes. Also counts the nodes a
 * query near the start of a long history visits.
 *
 * Seeds are fixed so a failure is reproducible.
 */

import { assert, assertEquals } from "jsr:@std/assert";

import { AVLTree } from "../../avl-tree.ts";
import { NumRangeLike } from "../../range.ts";

type Item = { readonly id: string; readonly range: NumRangeLike };
type Node = AVLTree.Node.Many<string, Item>;

/** Deterministic PRNG — mulberry32. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The walk as it was before pruning: left pruned by `max`, right always visited. */
function unpruned(root: Node, keep: (node: Node, v: Item) => boolean, r: NumRangeLike, nodesOnly: boolean): unknown[] {
  const out: unknown[] = [];
  const nodes: Node[] = [root];
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    if (nodesOnly) {
      if (node.values.some((v) => keep(node, v))) out.push(node);
    } else {
      for (const v of node.values) if (keep(node, v)) out.push(v);
    }
    if (node.left && node.left.max >= r.start) nodes.push(node.left);
    if (node.right) nodes.push(node.right);
  }
  return out;
}

const intersects = (_: Node, v: Item, r: NumRangeLike) => NumRangeLike.intersects(v.range, r);

Deno.test("AVLTree.Node.Many overlap walks answer exactly what the unpruned walk answered", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const next = rng(seed);
    const tree = new AVLTree<Node>();
    const live: Item[] = [];
    for (let step = 0; step < 600; step++) {
      if (live.length > 0 && next() < 0.25) {
        const victim = live.splice(Math.floor(next() * live.length), 1)[0]!;
        AVLTree.Node.Many.delete(tree, victim);
      } else {
        const start = Math.floor(next() * 200);
        const item = { id: `i${seed}-${step}`, range: { start, end: start + Math.floor(next() * (next() < 0.1 ? 150 : 10)) } };
        live.push(item);
        tree.insert(new AVLTree.Node.Many([item]));
      }
      const root = tree.root;
      if (root == null) continue;
      const a = Math.floor(next() * 220) - 10;
      const r = { start: a, end: a + Math.floor(next() * 30) };
      assertEquals(root.findAllOverlaps(r), unpruned(root, (n, v) => intersects(n, v, r), r, false), `seed ${seed} step ${step}: findAllOverlaps`);
      assertEquals(root.findAllOverlapsInclusiveEnd(r), unpruned(root, (n, v) => intersects(n, v, r), r, false), `seed ${seed} step ${step}: inclusive`);
      assertEquals(root.findAllOverlapsExclusiveEnd(r),
        unpruned(root, (n, v) => intersects(n, v, r) && r.start !== v.range.end, r, false), `seed ${seed} step ${step}: exclusive`);
      assertEquals(root.findAllOverlapsNodes(r), unpruned(root, (n, v) => intersects(n, v, r), r, true), `seed ${seed} step ${step}: nodes`);
    }
  }
});

Deno.test("AVLTree.Node.Many: a query near the start of a 10k history visits O(log n + k) nodes", () => {
  const tree = new AVLTree<Node>();
  for (let i = 0; i < 10_000; i++) tree.insert(new AVLTree.Node.Many([{ id: `e${i}`, range: { start: i * 10, end: i * 10 + 5 } }]));
  const root = tree.root!;
  // Count visits through the `values` reads of the walk.
  let visits = 0;
  const seen = new Set<Node>();
  const wrap = (node: Node | null | undefined): void => {
    if (node == null || seen.has(node)) return;
    seen.add(node);
    const values = node.values;
    Object.defineProperty(node, "values", { configurable: true, get: () => { visits++; return values; }, set: () => {} });
    wrap(node.left);
    wrap(node.right);
  };
  wrap(root);
  const found = root.findAllOverlapsInclusiveEnd({ start: 100, end: 170 });
  assertEquals(found.map((v) => v.id).sort(), ["e10", "e11", "e12", "e13", "e14", "e15", "e16", "e17"].sort());
  assert(visits < 100, `visited ${visits} nodes (the unpruned walk visits ~10k)`);
});
