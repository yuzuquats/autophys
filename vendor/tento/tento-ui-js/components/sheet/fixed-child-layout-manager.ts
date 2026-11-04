import type { NumRangeLike } from "@tento-core/range";
import { FixedChildIndex } from "./fixed-child-index";
import { type RowIdentity, rowIdentity } from "./row-identity";

export interface FixedChildLayoutNode {
  id: string;
  range: NumRangeLike;
  data: {
    $content: Pick<HTMLElement, "getAttribute">;
    rowId: Option<RowIdentity>;
    owner: Option<string>;
    inset: Option<Optional<Inset>>;
  };
}

/** Owns mounted identities and their row/owner memberships. No DOM lifecycle
 * is needed to test this index; elements supply only their ownership attributes. */
export class FixedChildLayoutManager<T extends FixedChildLayoutNode> {
  private readonly nodes = new FixedChildIndex<T>();
  // Secondary index: rowId+owner → Set<nodeId>
  private byRowOwner: Map<string, Set<string>> = new Map();

  private rowOwnerKey(rowId: RowIdentity, owner: string): string {
    return `${rowId.toString()}::${owner}`;
  }

  add(node: T) {
    // Remove existing node with same ID to prevent duplicates
    if (this.nodes.get(node.id) != null) {
      this.remove(node.id);
    }

    this.nodes.set(node);

    // Add to row-owner index if row-id and owner attributes are set
    const rowIdAttr = node.data.$content.getAttribute("row-id");
    const ownerAttr = node.data.$content.getAttribute("data-fixed-owner");
    node.data.rowId = rowIdAttr != null ? rowIdentity(rowIdAttr) : null;
    node.data.owner = ownerAttr ?? null;

    const rowId = node.data.rowId;
    const owner = node.data.owner;
    if (rowId != null && owner != null) {
      const key = this.rowOwnerKey(rowId, owner);
      let rowSet = this.byRowOwner.get(key);
      if (!rowSet) {
        rowSet = new Set();
        this.byRowOwner.set(key, rowSet);
      }
      rowSet.add(node.id);
    }
  }

  findAll(): T[] {
    return this.nodes.all();
  }

  findInRange(range: NumRangeLike): T[] {
    return this.nodes.inRange(range);
  }

  clear() {
    this.nodes.clear();
    this.byRowOwner.clear();
  }

  remove(id: string) {
    const node = this.nodes.get(id);
    if (node == null) return;
    const { rowId, owner } = node.data;
    if (rowId != null && owner != null) {
      const key = this.rowOwnerKey(rowId, owner);
      const rowSet = this.byRowOwner.get(key);
      rowSet?.delete(id);
      if (rowSet?.size === 0) this.byRowOwner.delete(key);
    }
    this.nodes.delete(id);
  }

  updateInset(id: string, newInset: Optional<Inset>): Option<T> {
    const node = this.nodes.get(id);
    if (node == null) return null;
    node.data.inset = newInset;
    return node;
  }

  /**
   * Get all node IDs for a specific row owner.
   */
  getIdsForRowOwner(rowId: RowIdentity, owner: string): Set<string> {
    return this.byRowOwner.get(this.rowOwnerKey(rowId, owner)) ?? new Set();
  }

  getIdsForOwner(owner: string): Set<string> {
    const ids = new Set<string>();
    const suffix = `::${owner}`;
    for (const [key, rowIds] of this.byRowOwner) {
      if (!key.endsWith(suffix)) continue;
      for (const id of rowIds) {
        ids.add(id);
      }
    }
    return ids;
  }

  /**
   * Update the byRowOwner secondary index when a node's rowId or owner changes.
   */
  updateRowOwner(
    nodeId: string,
    oldRowId: Option<RowIdentity>,
    oldOwner: Option<string>,
    newRowId: RowIdentity,
    newOwner: string,
  ): void {
    if (oldRowId != null && oldOwner != null) {
      const oldKey = this.rowOwnerKey(oldRowId, oldOwner);
      const oldSet = this.byRowOwner.get(oldKey);
      oldSet?.delete(nodeId);
      if (oldSet && oldSet.size === 0) this.byRowOwner.delete(oldKey);
    }
    const newKey = this.rowOwnerKey(newRowId, newOwner);
    let newSet = this.byRowOwner.get(newKey);
    if (!newSet) {
      newSet = new Set();
      this.byRowOwner.set(newKey, newSet);
    }
    newSet.add(nodeId);
  }

  /**
   * Get a node by its ID.
   */
  get(id: string): Option<T> {
    return this.nodes.get(id);
  }
}

