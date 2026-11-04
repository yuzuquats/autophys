/**
 * Property tests for `AVLTree.delete` — the rebalance, not the rotations.
 *
 * Bug shape: the `balance < -1` branch of `AVLTree.delete` (right subtree two
 * taller) chose between a single left rotation and a right-then-left double
 * rotation by inspecting `AVLTree.balance(root.left)`. Which rotation restores
 * the invariant is a fact about the RIGHT child, so the branch was taken on
 * noise from the other side of the tree. When `root.left` happened to be
 * left-heavy the double rotation ran, and `rightRotate` binds `y = z.left` on a
 * right child that may have no left subtree — `y.right = z` then throws
 * `TypeError: Cannot set properties of undefined (setting 'right')`.
 *
 * The mirror branch (`balance > 1`, testing `root.left`) is correct, and
 * `AVLTree.insert` reaches the same decision through key comparisons and cannot
 * express the mistake — so inserts never showed it and only deletes could.
 *
 * A unit test of `rightRotate` would pin that one symptom and miss the class.
 * These assert the two things that must hold after EVERY delete: the AVL
 * invariant (|balance| <= 1 at every node) and an in-order walk yielding
 * exactly the remaining keys in order. The invariant assertion is what catches
 * the silent half — the throw needs three conditions to coincide, but the wrong
 * branch is taken far more often than that and otherwise just leaves the tree
 * unbalanced without complaint.
 *
 * Seeds are fixed so a failure is reproducible.
 */

import { assert, assertEquals } from "jsr:@std/assert";

import { AVLTree } from "../../avl-tree.ts";

/** Deterministic PRNG — mulberry32. Keeps failures reproducible. */
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

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Every node's balance factor must be within ±1, and heights must be honest. */
function assertBalanced(
  tree: AVLTree<AVLTree.Node.Default>,
  context: string,
): void {
  for (const node of tree.dfs("pre")) {
    const balance = AVLTree.balance(node);
    assert(
      balance >= -1 && balance <= 1,
      `${context}: node ${node.key} has balance ${balance} (AVL invariant broken)`,
    );
    assertEquals(
      node.height,
      AVLTree.calculateHeight(node),
      `${context}: node ${node.key} has stale height`,
    );
  }
}

/**
 * NOTE: `dfs`'s order labels do not mean what they say. Its `"pre"` branch
 * descends left-first and yields ASCENDING in-order; `"in"` and `"post"` both
 * descend right-first and yield DESCENDING in-order. There is no true pre- or
 * post-order traversal in the implementation. `"pre"` is therefore the correct
 * argument for an ascending walk — this is not a typo. (The class docstring at
 * `avl-tree.ts:20` advertises `dfs("pre")` as pre-order; that is wrong too, and
 * is its own small defect, out of scope here.)
 */
function inOrderKeys(tree: AVLTree<AVLTree.Node.Default>): number[] {
  return [...tree.dfs("pre")].map((n) => n.key);
}

Deno.test("delete keeps the AVL invariant after every removal", () => {
  for (const seed of [1, 7, 42, 1337, 90210]) {
    for (const size of [8, 32, 128]) {
      const rand = rng(seed * 31 + size);
      const keys = shuffle(
        Array.from({ length: size }, (_, i) => i),
        rand,
      );
      const tree = AVLTree.withDefaultNodes(keys);
      assertBalanced(tree, `seed=${seed} size=${size} after build`);

      const remaining = new Set(keys);
      for (const key of shuffle(keys, rand)) {
        tree.delete(new AVLTree.Node.Default(key));
        remaining.delete(key);

        const label = `seed=${seed} size=${size} after delete(${key})`;
        assertBalanced(tree, label);
        assertEquals(
          inOrderKeys(tree),
          [...remaining].sort((a, b) => a - b),
          `${label}: in-order walk does not match the remaining keys`,
        );
      }

      // Loose equality on purpose: `Option<T>` is `null | T | undefined`, and
      // delete's leaf branches return the node's missing child, i.e. `undefined`
      // rather than `null`. Emptiness is the claim; which nullish value the last
      // return happened to carry is not.
      assert(
        tree.root == null,
        `seed=${seed} size=${size}: tree not empty`,
      );
    }
  }
});

Deno.test("delete keeps the AVL invariant when interleaved with inserts", () => {
  // The test above only ever deletes from a tree built by inserts, so every
  // shape it visits descends from one build. Interleaving rounds keeps deleting
  // from trees whose current shape is itself the product of earlier deletes and
  // their rotations — a different population of subtree balances arriving at
  // the rebalance, which is where the branch is chosen.
  const space = 64;
  for (const seed of [3, 11, 2024]) {
    const rand = rng(seed);
    const present = new Set<number>();
    const tree = new AVLTree<AVLTree.Node.Default>();

    for (let round = 0; round < 12; round++) {
      const absent = Array.from({ length: space }, (_, i) => i).filter(
        (k) => !present.has(k),
      );
      // Never insert a key already in the tree: that path calls `mergeWith`,
      // which `Node.Default` throws on by design.
      for (const key of shuffle(absent, rand).slice(
        0,
        Math.floor(rand() * absent.length),
      )) {
        tree.insert(new AVLTree.Node.Default(key));
        present.add(key);

        const label = `seed=${seed} round=${round} after insert(${key})`;
        assertBalanced(tree, label);
        assertEquals(
          inOrderKeys(tree),
          [...present].sort((a, b) => a - b),
          `${label}: in-order walk does not match the live keys`,
        );
      }

      const live = [...present];
      for (const key of shuffle(live, rand).slice(
        0,
        Math.floor(rand() * live.length),
      )) {
        tree.delete(new AVLTree.Node.Default(key));
        present.delete(key);

        const label = `seed=${seed} round=${round} after delete(${key})`;
        assertBalanced(tree, label);
        assertEquals(
          inOrderKeys(tree),
          [...present].sort((a, b) => a - b),
          `${label}: in-order walk does not match the live keys`,
        );
      }
    }
  }
});

Deno.test("delete survives the right-heavy rebalance that reached rightRotate", () => {
  // The minimal shape that separates the two branches. These keys insert with
  // zero rotations into exactly:
  //
  //            50
  //      20          80
  //   10    30    70    90
  //             60  75
  //
  // so the starting tree is fixed by the insert order alone, with no rotation
  // to reason about.
  const tree = AVLTree.withDefaultNodes([50, 20, 80, 10, 30, 70, 90, 60, 75]);
  assertBalanced(tree, "constructed");

  // Trims the left subtree without unbalancing anything: balance(50) = -1.
  tree.delete(new AVLTree.Node.Default(10));
  assertBalanced(tree, "after delete(10)");

  // Now balance(50) = -2 — the right subtree is two taller, so the rotation
  // choice is a fact about the RIGHT child. balance(80) = +1 (its left child 70
  // is the tall one), which calls for the right-then-left DOUBLE rotation.
  //
  // The bug read balance(root.left) here: balance(20) = 0 <= 0, selecting the
  // single leftRotate(50). That hoists 80 to the root with balance +2 and the
  // assertBalanced walk below fails at it — the silent half of the defect, an
  // invariant violation with nothing thrown.
  tree.delete(new AVLTree.Node.Default(30));
  assertBalanced(tree, "after delete(30)");

  assertEquals(inOrderKeys(tree), [20, 50, 60, 70, 75, 80, 90]);
});

Deno.test("deleting a missing key is a no-op", () => {
  const tree = AVLTree.withDefaultNodes([4, 2, 6]);
  tree.delete(new AVLTree.Node.Default(99));
  assertBalanced(tree, "after deleting a missing key");
  assertEquals(inOrderKeys(tree), [2, 4, 6]);
});
