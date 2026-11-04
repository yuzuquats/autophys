/**
 * `AVLTree.Node.Many.insertBulk` against one-by-one `tree.insert`: over random
 * interval sets with shared starts, inserted into empty and non-empty trees,
 * with deletes in between, the bulk tree holds the same node objects in key
 * order with the same values in the same order, is AVL-balanced with correct
 * heights and each node's exact subtree `max` after a rebuild, and answers every overlap
 * query the same. Seeds are fixed so a failure is reproducible.
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

function inorder(tree: AVLTree<Node>): Node[] {
  const out: Node[] = [];
  if (tree.root != null) AVLTree.inorder(tree.root, (n) => out.push(n));
  return out;
}

/** Checks balance, heights and exact `max`; answers the subtree's height and max. */
function check(node: Node | null | undefined): { height: number; max: number } {
  if (node == null) return { height: 0, max: -Infinity };
  const l = check(node.left);
  const r = check(node.right);
  assert(Math.abs(l.height - r.height) <= 1, "balanced");
  assertEquals(node.height, 1 + Math.max(l.height, r.height), "height");
  const own = Math.max(...node.values.map((v) => v.range.end));
  assertEquals(node.max, Math.max(own, l.max, r.max), "exact max");
  return { height: node.height, max: node.max };
}

Deno.test("Many.insertBulk holds what one-by-one inserts hold, balanced, with exact max", () => {
  for (const seed of [1, 2, 3, 20261003, 77]) {
    const next = rng(seed);
    let serial = 0;
    const item = (): Item => {
      const start = Math.floor(next() * 400);
      return { id: `i${serial++}`, range: { start, end: start + Math.floor(next() * 60) } };
    };
    const one = new AVLTree<Node>();
    const bulk = new AVLTree<Node>();
    const live: Item[] = [];
    for (let round = 0; round < 12; round++) {
      // A batch large or small against the tree (both branches of insertBulk).
      const size = round % 3 === 0 ? 1 + Math.floor(next() * 4) : 20 + Math.floor(next() * 300);
      const batch = Array.from({ length: size }, item);
      for (const it of batch) one.insert(new AVLTree.Node.Many([it]));
      const rebuilds = batch.length * 8 >= 2 ** (bulk.root?.height ?? 0);
      AVLTree.Node.Many.insertBulk(bulk, batch.map((it) => new AVLTree.Node.Many([it])));
      // A rebuild (a batch at least 1/8 of the tree's size bound 2^height) leaves exact heights and max; deletes may later leave `max` high, as they do for
      // one-by-one trees (a conservative bound the walks tolerate).
      if (rebuilds) check(bulk.root);
      live.push(...batch);
      // Delete a few through the same path the index uses.
      for (let d = 0; d < 3 && live.length > 0; d++) {
        const victim = live.splice(Math.floor(next() * live.length), 1)[0]!;
        AVLTree.Node.Many.delete(one, victim);
        AVLTree.Node.Many.delete(bulk, victim);
      }
      const a = inorder(one);
      const b = inorder(bulk);
      assertEquals(b.map((n) => [n.key, n.values.map((v) => v.id)]), a.map((n) => [n.key, n.values.map((v) => v.id)]),
        `seed ${seed} round ${round}: same keys and values in the same order`);
      for (let q = 0; q < 40; q++) {
        const s = Math.floor(next() * 460) - 30;
        const r = { start: s, end: s + Math.floor(next() * 80) };
        const ids = (t: AVLTree<Node>) => (t.root?.findAllOverlaps(r) ?? []).map((v) => v.id).sort();
        assertEquals(ids(bulk), ids(one), `seed ${seed} round ${round} query ${q}`);
      }
    }
  }
});

Deno.test("Many.insertBulk: a small batch into a large tree inserts each and never walks the tree (CAL-N7)", () => {
  const tree = new AVLTree<Node>();
  AVLTree.Node.Many.insertBulk(tree, Array.from({ length: 4096 }, (_, i) => new AVLTree.Node.Many([{ id: `t${i}`, range: { start: i, end: i + 1 } }])));
  const walk = AVLTree.inorder;
  let walked = 0;
  AVLTree.inorder = ((...args: Parameters<typeof walk>) => {
    walked++;
    return walk(...args);
  }) as typeof walk;
  try {
    AVLTree.Node.Many.insertBulk(tree, Array.from({ length: 16 }, (_, i) => new AVLTree.Node.Many([{ id: `s${i}`, range: { start: 5000 + i, end: 5001 + i } }])));
  } finally {
    AVLTree.inorder = walk;
  }
  assertEquals(walked, 0, "16 nodes into 4,096: no in-order walk");
  assertEquals(inorder(tree).length, 4096 + 16);
  // Every overlap answer is right (max is an upper bound after one-by-one inserts, exact only after a rebuild).
  for (const s of [0, 2047, 4095, 4999, 5007, 5015, 5020]) {
    const got = (tree.root?.findAllOverlaps({ start: s, end: s + 3 }) ?? []).map((v) => v.id).sort();
    const want = inorder(tree).flatMap((n) => n.values).filter((v) => NumRangeLike.intersects(v.range, { start: s, end: s + 3 })).map((v) => v.id).sort();
    assertEquals(got, want, `overlaps at ${s}`);
  }
});

Deno.test("Many.insertBulk keeps the node object already holding a key and appends in arrival order", () => {
  const tree = new AVLTree<Node>();
  const held = new AVLTree.Node.Many<string, Item>([{ id: "a", range: { start: 5, end: 6 } }]);
  tree.insert(held);
  AVLTree.Node.Many.insertBulk(tree, [
    new AVLTree.Node.Many([{ id: "b", range: { start: 5, end: 9 } }]),
    new AVLTree.Node.Many([{ id: "c", range: { start: 1, end: 2 } }]),
    new AVLTree.Node.Many([{ id: "d", range: { start: 5, end: 7 } }]),
  ]);
  const nodes = inorder(tree);
  assertEquals(nodes.map((n) => n.values.map((v) => v.id)), [["c"], ["a", "b", "d"]]);
  assert(nodes[1] === held, "the node holding the key stays");
  check(tree.root);
});
