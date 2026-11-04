/**
 * Spatial index for resolving pointer coordinates to canvas-drawn rects.
 *
 * Entries are sorted by y-position for efficient lookup. Since calendar
 * cells are axis-aligned and typically few per column (~50 max), a sorted
 * array with binary search on y followed by linear scan on x is sufficient.
 */

export namespace CanvasHitMap {
  export type Rect = {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  export type Entry = {
    id: string;
    rect: Rect;
    zIndex: number;
    /** Tag to distinguish hit types (default "cell") */
    tag?: string;
  };

  export type HitResult = {
    id: string;
    /** Region within the cell: body, or 4px resize handles at top/bottom */
    region: "body" | "top" | "bottom";
    /** Pointer offset relative to the cell's top-left corner */
    offset: { x: number; y: number };
    /** Tag from the entry (default "cell") */
    tag: string;
  };
}

const HANDLE_SIZE = 4;

export class CanvasHitMap {
  private entries: CanvasHitMap.Entry[] = [];
  private built: boolean = false;

  clear(): void {
    this.entries.length = 0;
    this.built = false;
  }

  add(entry: CanvasHitMap.Entry): void {
    this.entries.push(entry);
    this.built = false;
  }

  /** Sort entries for efficient lookup. Call after all adds. */
  build(): void {
    this.entries.sort((a, b) => {
      const dy = a.rect.y - b.rect.y;
      if (dy !== 0) return dy;
      // Higher zIndex last so reverse scan finds topmost first
      return a.zIndex - b.zIndex;
    });
    this.built = true;
  }

  /** Resolve a CSS-coordinate point to the topmost overlapping cell. */
  resolve(x: number, y: number): Option<CanvasHitMap.HitResult> {
    if (!this.built) this.build();

    const entries = this.entries;
    // Binary search: find first entry whose bottom edge is past y
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].rect.y + entries[mid].rect.height <= y) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Scan candidates — entries from `lo` onward whose top <= y
    let best: Option<CanvasHitMap.Entry> = null;
    for (let i = lo; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.rect.y > y) break; // past the point vertically

      if (!rectContains(entry.rect, x, y)) continue;

      // Among overlapping entries, highest zIndex wins
      if (best == null || entry.zIndex > best.zIndex) {
        best = entry;
      }
    }

    if (!best) return null;

    const offset = {
      x: x - best.rect.x,
      y: y - best.rect.y,
    };

    let region: CanvasHitMap.HitResult["region"] = "body";
    if (offset.y <= HANDLE_SIZE) {
      region = "top";
    } else if (offset.y >= best.rect.height - HANDLE_SIZE) {
      region = "bottom";
    }

    return { id: best.id, region, offset, tag: best.tag ?? "cell" };
  }

  get length(): number {
    return this.entries.length;
  }
}

function rectContains(
  rect: CanvasHitMap.Rect,
  x: number,
  y: number,
): boolean {
  return (
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
  );
}
