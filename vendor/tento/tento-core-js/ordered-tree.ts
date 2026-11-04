/**
 * Generic ordered tree where each node has an identity `Id` and children
 * are sorted by a comparable `Ord` value.
 *
 * `Ord` must support a `compare(a, b)` function returning -1 | 0 | 1.
 */
export namespace OrderedTree {
  export interface Node<Id, Ord> {
    readonly id: Id;
    readonly position: Ord;
    readonly children: Node<Id, Ord>[];
  }

  export class Root<Id, Ord> {
    readonly nodes: Node<Id, Ord>[];
    private readonly byId: Map<Id, Node<Id, Ord>>;
    private readonly parentMap: Map<Id, Option<Id>>;

    constructor(
      nodes: Node<Id, Ord>[],
      byId: Map<Id, Node<Id, Ord>>,
      parentMap: Map<Id, Option<Id>>,
    ) {
      this.nodes = nodes;
      this.byId = byId;
      this.parentMap = parentMap;
    }

    get(id: Id): Option<Node<Id, Ord>> {
      return this.byId.get(id) ?? null;
    }

    parent(id: Id): Option<Id> {
      return this.parentMap.get(id) ?? null;
    }

    children(id: Id): Node<Id, Ord>[] {
      return this.byId.get(id)?.children ?? [];
    }

    /** Pretty-print the tree using unicode box-drawing characters. */
    print(label?: (node: Node<Id, Ord>) => string): string {
      const fmt = label ?? ((n: Node<Id, Ord>) => String(n.id));
      const lines: string[] = [];
      const printNode = (node: Node<Id, Ord>, prefix: string, isLast: boolean, isRoot: boolean) => {
        const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
        lines.push(prefix + connector + fmt(node));
        const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
        for (let i = 0; i < node.children.length; i++) {
          printNode(node.children[i], childPrefix, i === node.children.length - 1, false);
        }
      };
      for (let i = 0; i < this.nodes.length; i++) {
        printNode(this.nodes[i], "", i === this.nodes.length - 1, true);
      }
      return lines.join("\n");
    }
  }

  /** Flat representation of an ordered tree — edges + positions, no nesting. */
  export type Flattened<Id, Ord> = {
    children: Map<Id, Id[]>;
    parent: Map<Id, Id>;
    positions: Map<Id, Ord>;
  };

  /** Flatten a Root into edges + positions. */
  export function flatten<Id, Ord>(root: Root<Id, Ord>): Flattened<Id, Ord> {
    const children = new Map<Id, Id[]>();
    const parent = new Map<Id, Id>();
    const positions = new Map<Id, Ord>();

    const walk = (node: Node<Id, Ord>, parentId: Option<Id>) => {
      positions.set(node.id, node.position);
      if (parentId) parent.set(node.id, parentId);
      if (node.children.length > 0) {
        children.set(node.id, node.children.map(c => c.id));
      }
      for (const child of node.children) walk(child, node.id);
    };
    for (const node of root.nodes) walk(node, null);

    return { children, parent, positions };
  }

  /** Build a Root from a Flattened representation. */
  export function unflatten<Id, Ord>(
    flat: Flattened<Id, Ord>,
    compare: (a: Ord, b: Ord) => number,
  ): Root<Id, Ord> {
    const nodes: { id: Id; position: Ord; children: Id[] }[] = [];
    for (const [id, position] of flat.positions) {
      nodes.push({ id, position, children: flat.children.get(id) ?? [] });
    }
    return build(nodes, compare);
  }

  /** Build a Root from flat node data with parent-child edges. */
  export function build<Id, Ord>(
    nodes: { id: Id; position: Ord; children: Id[] }[],
    compare: (a: Ord, b: Ord) => number,
  ): Root<Id, Ord> {
    const byId = new Map<Id, Node<Id, Ord>>();
    const parentMap = new Map<Id, Option<Id>>();
    const childSet = new Set<Id>();

    // 1. Create nodes
    for (const n of nodes) {
      const node: Node<Id, Ord> = {
        id: n.id,
        position: n.position,
        children: [],
      };
      byId.set(n.id, node);
    }

    // 2. Wire parent-child edges
    for (const n of nodes) {
      const parent = byId.get(n.id)!;
      for (const childId of n.children) {
        const child = byId.get(childId);
        if (child) {
          (parent.children as Node<Id, Ord>[]).push(child);
          parentMap.set(childId, n.id);
          childSet.add(childId);
        }
      }
    }

    // 3. Sort children by position
    for (const [, node] of byId) {
      if (node.children.length > 1) {
        (node.children as Node<Id, Ord>[]).sort((a, b) => compare(a.position, b.position));
      }
    }

    // 4. Collect roots (nodes not listed as children)
    const roots: Node<Id, Ord>[] = [];
    for (const n of nodes) {
      if (!childSet.has(n.id)) {
        roots.push(byId.get(n.id)!);
      }
    }
    roots.sort((a, b) => compare(a.position, b.position));

    return new Root(roots, byId, parentMap);
  }
}
