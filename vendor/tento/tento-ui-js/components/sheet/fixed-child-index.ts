import type { NumRangeLike } from "@tento-core/range";

/** The mounted set is bounded by the rendered window. IDs own nodes, not
 * mutable interval-tree buckets. Geometry is read at query time because
 * mapper and layout changes mutate a mounted node's range in place. */
export class FixedChildIndex<T extends { id: string; range: NumRangeLike }> {
  private readonly nodes = new Map<string, T>();

  set(node: T): void {
    this.nodes.set(node.id, node);
  }

  get(id: string): Option<T> {
    return this.nodes.get(id) ?? null;
  }

  delete(id: string): void {
    this.nodes.delete(id);
  }

  clear(): void {
    this.nodes.clear();
  }

  all(): T[] {
    return [...this.nodes.values()];
  }

  inRange(range: NumRangeLike): T[] {
    return this.all().filter((node) =>
      node.range.start < range.end && node.range.end > range.start
    );
  }
}
