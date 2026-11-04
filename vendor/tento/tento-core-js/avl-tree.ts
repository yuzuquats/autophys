import { NumRangeLike } from "./range";

/**
 * AVLTree is a self-balancing binary search tree implementation.
 *
 * An AVL tree maintains a balance factor for each node, ensuring that the heights
 * of the two child subtrees differ by at most one. This balancing ensures
 * O(log n) time complexity for lookups, insertions, and deletions.
 *
 * This implementation supports various node types that can be customized through
 * the AVLTree.Node interface and its implementations.
 *
 * @example
 * ```typescript
 * // Create a tree with default nodes
 * const tree = AVLTree.withDefaultNodes([5, 3, 7, 2, 4, 6, 8]);
 * tree.print(); // Outputs a visualization of the tree
 *
 * // Iterate through nodes in pre-order
 * for (const node of tree.dfs("pre")) {
 *   console.log(node.key);
 * }
 *
 * // Delete a node
 * tree.delete(new AVLTree.Node.Default(4));
 * ```
 */
export class AVLTree<T extends AVLTree.Node> {
  /** Root node of the tree */
  root: Option<T>;

  /**
   * Inserts multiple nodes into the tree
   * @param nodes Array of nodes to insert
   */
  insertMany(nodes: T[]) {
    for (const node of nodes) this.insert(node);
  }

  /**
   * Inserts a single node into the tree
   * @param node The node to insert
   */
  insert(node: T) {
    this.root = AVLTree.insert(this.root, node);
  }

  /**
   * Internal method to insert a node into a tree
   * @param root The root node of the tree or subtree
   * @param node The node to insert
   * @returns The new root after the insertion and rebalancing
   */
  static insert<T extends AVLTree.Node>(root: Option<T>, node: T): Option<T> {
    if (root == null) return node;

    if (node.key < root.key) {
      root.left = AVLTree.insert(root.left, node);
    } else if (node.key > root.key) {
      root.right = AVLTree.insert(root.right, node);
    } else {
      root.mergeWith(node);
    }

    AVLTree.redecorate(root, node);
    const balance = AVLTree.balance(root);

    if (balance > 1) {
      if (node.key < root.left!.key) {
        return AVLTree.rightRotate(root);
      } else {
        root.left = AVLTree.leftRotate(root.left!);
        return AVLTree.rightRotate(root);
      }
    }
    if (balance < -1) {
      if (node.key > root.right!.key) {
        return AVLTree.leftRotate(root);
      } else {
        root.right = AVLTree.rightRotate(root.right!);
        return AVLTree.leftRotate(root);
      }
    }

    return root;
  }

  /**
   * Removes all nodes from the tree
   */
  clear() {
    this.root = null;
  }

  /**
   * Deletes a node from the tree
   * @param node The node to delete
   * @returns The new root node after deletion
   */
  delete(node: T): Option<T> {
    this.root = AVLTree.delete(this.root, node);
    return this.root;
  }

  /**
   * Internal method to delete a node from a tree
   * @param root The root of the tree or subtree
   * @param node The node to delete
   * @returns The new root after deletion and rebalancing
   */
  static delete<T extends AVLTree.Node>(root: Option<T>, node: T): Option<T> {
    const key = node.key;
    if (!root) return root;
    else if (key < root.key) root.left = AVLTree.delete(root.left, node);
    else if (key > root.key) root.right = AVLTree.delete(root.right, node);
    else {
      // key === root.key
      const stillExists = root.deleteWith(node).nodeStillExists;
      if (stillExists) {
        return root;
      }
      if (!root.left) {
        return root.right;
      } else if (!root.right) {
        return root.left;
      }
      const temp = AVLTree.minValueNode(root.right)!;
      root.replaceContentsWith(temp);
      root.right = AVLTree.delete(root.right, temp);
    }

    AVLTree.redecorate(root, null);

    const balance = AVLTree.balance(root);
    if (balance > 1) {
      if (AVLTree.balance(root.left) >= 0) {
        return AVLTree.rightRotate(root);
      } else {
        root.left = AVLTree.leftRotate(root.left!);
        return AVLTree.rightRotate(root);
      }
    }
    if (balance < -1) {
      if (AVLTree.balance(root.right) <= 0) {
        return AVLTree.leftRotate(root);
      } else {
        root.right = AVLTree.rightRotate(root.right!);
        return AVLTree.leftRotate(root);
      }
    }
    return root;
  }

  /**
   * Updates the height and other properties of a node
   * @param n The node to update
   * @param newNode Optional new node that was just inserted
   */
  static redecorate<T extends AVLTree.Node>(n: T, newNode: Option<T>) {
    n.height = 1 + Math.max(AVLTree.height(n.left), AVLTree.height(n.right));
    n.redecorate(newNode);
  }

  /**
   * Performs a left rotation to maintain balance
   * @param z The node to rotate
   * @returns The new root of the subtree after rotation
   */
  static leftRotate<T extends AVLTree.Node>(z: T): T {
    const y = z.right! as T;
    const t2 = y?.left;
    y.left = z;
    z.right = t2;
    AVLTree.redecorate(z, null);
    AVLTree.redecorate(y, null);
    return y;
  }

  /**
   * Performs a right rotation to maintain balance
   * @param z The node to rotate
   * @returns The new root of the subtree after rotation
   */
  static rightRotate<T extends AVLTree.Node>(z: T): T {
    const y = z.left! as T;
    const t3 = y?.right;
    y.right = z;
    z.left = t3;
    AVLTree.redecorate(z, null);
    AVLTree.redecorate(y, null);
    return y;
  }

  /**
   * Calculates the balance factor of a node
   * @param node The node to calculate balance for
   * @returns The balance factor (left height - right height)
   */
  static balance<T extends AVLTree.Node>(node: Option<T>): number {
    if (!node) return 0;
    return AVLTree.height(node.left) - AVLTree.height(node.right);
  }

  /**
   * Calculates the height of a node by recursively computing heights
   * @param node The node to calculate height for
   * @returns The height of the node
   */
  static calculateHeight<T extends AVLTree.Node>(node: Option<T>): number {
    if (!node) return 0;
    return (
      1 +
      Math.max(
        AVLTree.calculateHeight(node.left),
        AVLTree.calculateHeight(node.right),
      )
    );
  }

  /**
   * Gets the height of a node (returns 0 for null nodes)
   * @param node The node to get height for
   * @returns The height of the node
   */
  static height<T extends AVLTree.Node>(node: Option<T>): number {
    if (!node) return 0;
    return node.height;
  }

  /**
   * Finds the node with the minimum key value in a subtree
   * @param node Root of the subtree
   * @returns The node with minimum key value
   */
  static minValueNode<T extends AVLTree.Node>(node: Option<T>): Option<T> {
    if (node == null || node.left == null) return node;
    return AVLTree.minValueNode(node.left);
  }

  /**
   * Performs a depth-first traversal of the tree
   * @param order The traversal order (pre-order, in-order, or post-order)
   * @returns An iterator over the nodes
   */
  dfs(order: "post" | "pre" | "in" = "pre"): IterableIterator<T> {
    return AVLTree.dfs(this.root, order);
  }

  /**
   * Internal method for depth-first traversal
   * @param node The starting node
   * @param order The traversal order
   * @returns An iterator over the nodes
   */
  static dfs<T extends AVLTree.Node>(
    node: Option<T>,
    order: "post" | "pre" | "in" = "pre",
  ): IterableIterator<T> {
    const stack: Array<T> = [];
    let current: Option<T> = node;
    while (current) {
      stack.push(current);
      current = order === "pre" ? current?.left : current?.right;
    }
    return {
      [Symbol.iterator]: function (): IterableIterator<T> {
        return this;
      },
      next: (..._args: [] | [undefined]): IteratorResult<T, any> => {
        const node = stack.pop();
        if (!node) {
          return {
            value: undefined,
            done: true,
          };
        }
        current = order === "pre" ? node.right : node.left;
        while (current) {
          stack.push(current);
          current = order === "pre" ? current.left : current.right;
        }
        return {
          value: node,
          done: false,
        };
      },
    };
  }

  /**
   * Performs an in-order traversal with a visitor function
   * @param node The starting node
   * @param visit Function called for each node
   * @param depth Current depth in the tree
   */
  static inorder<T extends AVLTree.Node>(
    node: T,
    visit: (n: T, depth: number) => void,
    depth: number = 0,
  ) {
    node.left && AVLTree.inorder(node.left, visit, depth + 1);
    visit(node, depth);
    node.right && AVLTree.inorder(node.right, visit, depth + 1);
  }

  /**
   * Performs a pre-order traversal with a visitor function
   * @param node The starting node
   * @param visit Function called for each node
   * @param depth Current depth in the tree
   */
  static preorder<T extends AVLTree.Node>(
    node: T,
    visit: (n: T, depth: number) => void,
    depth: number = 0,
  ) {
    visit(node, depth);
    node.left && AVLTree.preorder(node.left, visit, depth + 1);
    node.right && AVLTree.preorder(node.right, visit, depth + 1);
  }

  /**
   * Prints a visual representation of the tree to the console
   */
  print() {
    AVLTree.print(this.root);
  }

  /**
   * Internal method to print a tree with indentation
   * @param node The node to print
   * @param indent Current indentation string
   * @param last Whether this is the last child of its parent
   */
  static print<T extends AVLTree.Node>(
    node: Option<T>,
    indent: string = "",
    last: boolean = true,
  ) {
    if (node == null) return "<None>";
    if (last) {
      console.log(indent, "R----", node, node.description());
      indent += "     ";
    } else {
      console.log(indent, "L----", node, node.description());
      indent += " |    ";
    }
    AVLTree.print(node.left, indent, false);
    AVLTree.print(node.right, indent, true);
  }

  /**
   * Prints a simplified representation of the tree to the console
   * @returns "<None>" if the tree is empty
   */
  printRaw() {
    if (this.root == null) return "<None>";
    AVLTree.printRaw(this.root);
  }

  /**
   * Internal method to print a simplified tree
   * @param root The root node to print
   */
  static printRaw<T extends AVLTree.Node>(root: T) {
    AVLTree.inorder(root, (n, d) => {
      console.log("".padStart(d * 2, " "), n);
    });
  }
}

export namespace AVLTree {
  /**
   * Creates a new AVLTree with default nodes from an array of values
   * @param values Array of numbers to create nodes from
   * @returns A new AVLTree with default nodes
   *
   * @example
   * ```typescript
   * const tree = AVLTree.withDefaultNodes([5, 3, 7, 2, 4, 6, 8]);
   * tree.print();
   * ```
   */
  export function withDefaultNodes(values: number[]): AVLTree<Node.Default> {
    const tree = new AVLTree<Node.Default>();
    tree.insertMany(values.map((n) => new AVLTree.Node.Default(n)));
    return tree;
  }

  /**
   * Interface for nodes in the AVLTree
   */
  export interface Node {
    key: number;
    left: Option<this>;
    right: Option<this>;
    height: number;
    replaceContentsWith(n: this): void;
    redecorate(newNode: Option<this>): void;
    description(): Option<any>;

    mergeWith(n: this): void;
    deleteWith(n: this): { nodeStillExists: boolean };
  }

  export namespace Node {
    /**
     * Default implementation of the Node interface
     */
    export class Default implements Node {
      private _key: number = 0;
      get key(): number {
        return this._key;
      }
      left: Option<this>;
      right: Option<this>;
      height: number = 1;

      constructor(key: number) {
        this._key = key;
      }

      replaceContentsWith(n: Node): void {
        this._key = n.key;
      }

      redecorate(): void {}

      deleteWith(): { nodeStillExists: boolean } {
        return {
          nodeStillExists: false,
        };
      }

      mergeWith(n: this): void {
        throw new Error("default node cannot be merged");
      }

      description(): Option<string> {
        return undefined;
      }
    }

    /**
     * Single-value node implementation with range support.
     *
     * This class implements the Node interface for the AVLTree and stores:
     * - A numeric range (with start and end)
     * - A single value of type T
     *
     * It's useful for interval trees where each node represents a range with associated data.
     *
     * @example
     * ```typescript
     * // Create a tree for time slots with string labels
     * const tree = new AVLTree<AVLTree.Node.Single<string>>();
     *
     * // Add time slots
     * tree.insert(new AVLTree.Node.Single(
     *   { start: 9, end: 10 },    // 9:00-10:00 time slot
     *   "Morning meeting"
     * ));
     *
     * tree.insert(new AVLTree.Node.Single(
     *   { start: 13, end: 14 },   // 13:00-14:00 time slot
     *   "Lunch"
     * ));
     *
     * // Print the tree
     * tree.print();
     * ```
     */
    export class Single<T> implements Node {
      private _range: NumRangeLike;
      get key(): number {
        return this._range.start;
      }
      left: Option<this>;
      right: Option<this>;
      height: number = 1;
      max: number;
      value: T;

      constructor(range: NumRangeLike, value: T) {
        this._range = range;
        this.max = this._range.end;
        this.value = value;
      }

      replaceContentsWith(n: Single<T>): void {
        this._range = n._range;
        this.max = n.max;
        this.value = n.value;
      }

      /**
       * Updates the node's properties after tree structure changes
       * For Single nodes, recalculates the max property based on children
       * @param newNode Optional new node that was just inserted
       */
      redecorate(newNode: Option<this>): void {
        if (newNode) {
          this.max = Math.max(newNode.max, this.max);
        } else {
          this.max = Math.max(
            this._range.end,
            this.left?.max ?? 0,
            this.right?.max ?? 0,
          );
        }
      }

      /**
       * Gets the maximum range value in the subtree
       * @returns The maximum end value of any range in this subtree
       */
      getMaxRange(): number {
        return this.max;
      }

      /**
       * Checks if this node's range contains the given point
       * @param point The numeric point to check
       * @returns True if the point is within this node's range (inclusive)
       */
      contains(point: number): boolean {
        return NumRangeLike.contains(this._range, point);
      }

      /**
       * Checks if this node's range overlaps with another range
       * @param range The range to check for overlap
       * @returns True if the ranges overlap
       */
      overlaps(range: NumRangeLike): boolean {
        return NumRangeLike.intersects(this._range, range);
      }

      /**
       * Handles node deletion logic
       * @param n The node being deleted
       * @returns Object indicating whether the node still exists after deletion
       */
      deleteWith(_: this): { nodeStillExists: boolean } {
        // For Single nodes, any deletion removes the node completely
        return {
          nodeStillExists: false,
        };
      }

      /**
       * Merges this node with another node with the same key
       * @param n The node to merge with
       * @throws Error - Single nodes don't support merging by default
       */
      mergeWith(_: this): void {
        throw new Error(
          "Single nodes cannot be merged by default. Override this method for custom merge behavior.",
        );
      }

      /**
       * Get the underlying range object
       * @returns The numeric range
       */
      getRange(): NumRangeLike {
        return this._range;
      }

      /**
       * Find all other Single nodes in a tree that overlap with this node's range
       * @param tree The AVL tree to search in
       * @returns Array of overlapping nodes
       */
      findOverlapping(
        tree: AVLTree<AVLTree.Node.Single<any>>,
      ): AVLTree.Node.Single<any>[] {
        if (!tree.root) return [];
        const results: AVLTree.Node.Single<any>[] = [];
        const stack = [tree.root];

        while (stack.length > 0) {
          const node = stack.pop()!;

          // Check if this node overlaps
          if (this.overlaps(node.getRange())) {
            results.push(node);
          }

          // Only search left subtree if it could contain overlapping ranges
          if (node.left && node.left.max >= this._range.start) {
            stack.push(node.left);
          }

          // Always check right subtree
          if (node.right) {
            stack.push(node.right);
          }
        }

        return results;
      }

      /**
       * Provides a description of this node for debugging
       * @returns The range and value of this node
       */
      description(): Option<any> {
        return {
          range: this._range,
          value: this.value,
        };
      }
    }

    /**
     * Multi-value node implementation with interval tree capabilities
     * Used for efficiently querying ranges/intervals
     */
    export class Many<ID, T extends Identifiable<ID> & AVLTree.HasNumRange>
      implements Node
    {
      get key(): number {
        return this.values[0].range.start;
      }
      left: Option<this>;
      right: Option<this>;
      height: number = 1;
      max: number;
      values: T[];

      constructor(values: T[]) {
        this.values = values;
        this.max = this.maxOfValues();
        let start = values[0].range.start;
        for (const value of values) {
          if (start !== value.range.start) {
            throw new Error("start values are not equal");
          }
        }
      }

      /**
       * Calculates the maximum end value across all values
       * @returns The maximum end value from all contained values
       */
      private maxOfValues(): number {
        let max = this.values[0].range.end;
        for (const value of this.values) {
          max = Math.max(max, value.range.end);
        }
        return max;
      }

      replaceContentsWith(n: this): void {
        this.max = n.max;
        this.values = n.values;
      }

      redecorate(newNode: Option<this>): void {
        if (newNode) {
          this.max = Math.max(newNode.max, this.max);
        } else {
          this.max = Math.max(
            this.max,
            this.left?.max ?? 0,
            this.right?.max ?? 0,
          );
        }
      }

      deleteWith(node: this): { nodeStillExists: boolean } {
        const toDelete = new Map(node.values.map((v) => [v.id, v]));
        this.values = this.values.filter((v) => !toDelete.has(v.id));
        return {
          nodeStillExists: this.values.length > 0,
        };
      }

      mergeWith(n: this): void {
        this.values = this.values.concat(n.values);
        this.max = Math.max(n.max, this.max);
      }

      /**
       * Deletes an item from the tree by finding the node containing it,
       * removing the entire node, and re-adding each element as a new Many node
       * @param tree The AVL tree to operate on
       * @param t The item to delete
       */
      static delete<ID, T extends Identifiable<ID> & AVLTree.HasNumRange>(
        tree: AVLTree<Many<ID, T>>,
        t: T,
      ): void {
        if (!tree.root) return;

        // Use the interval tree to efficiently find the node containing t
        // by searching for nodes that overlap with t's range
        const overlappingNodes = tree.root.findAllOverlapsNodes(t.range);

        // Find the specific node that contains t
        const nodeWithItem = overlappingNodes.find((node) =>
          node.values.some((v) => v.id === t.id),
        );

        if (!nodeWithItem) return;

        // Store all values from the node
        const values = [...nodeWithItem.values];

        // Delete the entire node from the tree
        tree.delete(nodeWithItem);

        // Re-add each element (except the one we want to delete) as a new Many node
        for (const value of values) {
          if (value.id !== t.id) {
            // Create a new Many node with single value
            const newNode = new Many([value]);
            tree.insert(newNode);
          }
        }
      }

      /**
       * Insert `nodes` into `tree` at once: the same node objects, and the
       * same values in each in the same order, as inserting them one by one
       * with `tree.insert` (a key already present merges into the node
       * holding it, values appended in arrival order); only the shape
       * differs. The tree's size is bounded from its height without a walk
       * (n < 2^height): when `nodes` is at least an eighth of that bound,
       * the tree is rebuilt balanced from its in-order nodes and the new
       * ones, O(n + k log k) = O(k log k) as n < 8k; otherwise each is
       * inserted, O(k log n), and the tree is never walked. After a rebuild
       * each node's `max` is exact; after inserts it is what `tree.insert`
       * leaves (an upper bound the overlap walks tolerate).
       */
      static insertBulk<ID, T extends Identifiable<ID> & AVLTree.HasNumRange>(
        tree: AVLTree<Many<ID, T>>,
        nodes: readonly Many<ID, T>[],
      ): void {
        if (nodes.length === 0) return;
        if (nodes.length * 8 < 2 ** (tree.root?.height ?? 0)) {
          for (const node of nodes) tree.insert(node);
          return;
        }
        const existing: Many<ID, T>[] = [];
        if (tree.root != null) AVLTree.inorder(tree.root, (n) => existing.push(n));
        // Stable by key: equal keys keep arrival order, as one-by-one merges do.
        const incoming = nodes.map((node, i) => ({ node, i, key: node.key }))
          .sort((a, b) => a.key - b.key || a.i - b.i);
        const merged: Many<ID, T>[] = [];
        let e = 0;
        for (const { node, key } of incoming) {
          while (e < existing.length && existing[e]!.key < key) merged.push(existing[e++]!);
          const last = merged.length > 0 ? merged[merged.length - 1]! : null;
          if (e < existing.length && existing[e]!.key === key) {
            const held = existing[e++]!;
            held.mergeWith(node);
            merged.push(held);
          } else if (last != null && last.key === key) {
            last.mergeWith(node);
          } else {
            merged.push(node);
          }
        }
        while (e < existing.length) merged.push(existing[e++]!);
        const build = (lo: number, hi: number): Option<Many<ID, T>> => {
          if (lo >= hi) return null;
          const mid = (lo + hi) >> 1;
          const node = merged[mid]!;
          node.left = build(lo, mid);
          node.right = build(mid + 1, hi);
          node.height = 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0);
          let max = -Infinity;
          for (const v of node.values) if (v.range.end > max) max = v.range.end;
          if (node.left != null && node.left.max > max) max = node.left.max;
          if (node.right != null && node.right.max > max) max = node.right.max;
          node.max = max;
          return node;
        };
        tree.root = build(0, merged.length);
      }

      description(): Option<any> {
        return {
          id: this.values[0]?.id,
          ids: this.values.map((v) => v.id),
          max: this.max,
          values: this.values,
        };
      }

      /*
        Interval Search Tree
        ===========================================================================
      */

      /**
       * Finds all values with ranges that overlap with the given range
       * @param r The range to check for overlaps
       * @returns Array of values with overlapping ranges
       */
      findAllOverlaps(r: NumRangeLike): T[] {
        const results: T[] = [];
        const nodes = [this];
        while (nodes.length > 0) {
          const node = nodes.pop()!;
          for (const v of node.values) {
            if (NumRangeLike.intersects(v.range, r)) results.push(v);
          }
          if (node.left && node.left.max >= r.start) nodes.push(node.left);
          // Every key in the right subtree exceeds this node's, so none
          // can start at or before `r.end` once this one does not.
          if (node.right && node.key <= r.end) nodes.push(node.right);
        }
        return results;
      }

      findAllOverlapsNodes(r: NumRangeLike): this[] {
        const results: this[] = [];
        const nodes = [this];
        while (nodes.length > 0) {
          const node = nodes.pop()!;
          // Check if any value in this node overlaps with the range
          // Add the node only once if there's an overlap
          const hasOverlap = node.values.some((v) =>
            NumRangeLike.intersects(v.range, r),
          );
          if (hasOverlap) {
            results.push(node);
          }
          // Continue traversing the tree based on interval tree properties
          if (node.left && node.left.max >= r.start) nodes.push(node.left);
          if (node.right && node.key <= r.end) nodes.push(node.right);
        }
        return results;
      }

      /**
       * Finds all values with ranges that overlap with the given range,
       * excluding those where r.start equals the end of the value's range
       * @param r The range to check for overlaps
       * @returns Array of values with overlapping ranges
       */
      findAllOverlapsExclusiveEnd(r: NumRangeLike): T[] {
        const results: T[] = [];
        const nodes = [this];
        while (nodes.length > 0) {
          const node = nodes.pop()!;
          for (const v of node.values) {
            if (
              NumRangeLike.intersects(v.range, r) &&
              r.start !== v.range.end
            ) {
              results.push(v);
            }
          }
          if (node.left && node.left.max >= r.start) nodes.push(node.left);
          // Every key in the right subtree exceeds this node's, so none
          // can start at or before `r.end` once this one does not.
          if (node.right && node.key <= r.end) nodes.push(node.right);
        }
        return results;
      }

      /**
       * Finds all values in the tree whose ranges overlap with the given range.
       * Both the stored ranges and query range use inclusive-end semantics.
       *
       * For inclusive ranges:
       * - [1, 5] and [5, 10] DO overlap (they share the value 5)
       * - [1, 5] and [6, 10] do NOT overlap
       *
       * @param r The range to search for overlaps (inclusive end)
       * @returns Array of all values that overlap with the given range
       */
      findAllOverlapsInclusiveEnd(r: NumRangeLike): T[] {
        const results: T[] = [];
        const nodes = [this];
        while (nodes.length > 0) {
          const node = nodes.pop()!;
          for (const v of node.values) {
            if (NumRangeLike.intersects(v.range, r)) {
              results.push(v);
            }
          }
          if (node.left && node.left.max >= r.start) nodes.push(node.left);
          // Every key in the right subtree exceeds this node's, so none
          // can start at or before `r.end` once this one does not.
          if (node.right && node.key <= r.end) nodes.push(node.right);
        }
        return results;
      }

      /**
       * Recalculates and validates the max property for the entire subtree
       * Throws an error if the current max value is incorrect
       */
      recalculateAndValidate() {
        this.left?.recalculateAndValidate();
        this.right?.recalculateAndValidate();
        const max = Math.max(
          this.max,
          this.left?.max ?? 0,
          this.right?.max ?? 0,
        );
        if (this.max !== max) {
          throw new Error(`not equal! ${this.max} !=  ${max}`);
        }
        this.max = max;
      }
    }
  }

  /**
   * Interface for objects that have a numeric range
   */
  export type HasNumRange = {
    range: NumRangeLike;
  };
}
