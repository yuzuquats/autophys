import { Duration, DurationTime } from "@tento-chrono";
import { ColumnLayout } from "@tento-core/column-layout";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { $$ } from "../../fastdom";
import { FrameMarks } from "../../frame-marks";
import { Utils } from "../../utils";

@component({
  name: "std-calendar-column-layout-group",
})
export class CalendarColumnLayoutGroup extends LonaWebComponent {
  private layoutGeneration = 0;
  private previousLayout: Option<CalendarColumnLayoutGroup.Plan> = null;

  /** Cells hidden until their next layout write whose `[pending-layout]` is not written yet. */
  private static readonly unrevealed = new WeakSet<HTMLElement>();

  /**
   * Hide `$e` until a group's next layout write positions it. The attribute is
   * written at the end of the flush, and only when no layout write revealed the
   * cell first: a set and remove inside one flush never reaches style and
   * costs two style invalidations.
   */
  static markPendingLayout($e: HTMLElement): void {
    if ($e.hasAttribute("pending-layout")) return;
    CalendarColumnLayoutGroup.unrevealed.add($e);
    $$.mutateEnd(() => {
      if (CalendarColumnLayoutGroup.unrevealed.delete($e)) $e.toggleAttribute("pending-layout", true);
    });
  }

  /** Reveal `$e`: drops a pending mark, written or not. */
  static clearPendingLayout($e: HTMLElement): void {
    CalendarColumnLayoutGroup.unrevealed.delete($e);
    $e.removeAttribute("pending-layout");
  }

  onRecycle(): void {
    this.layoutGeneration++;
    this.previousLayout = null;
  }

  visibleCells(): CalendarColumnLayoutGroup.Cell<HTMLElement>[] {
    return [...this.children]
      .filter((node) => node instanceof HTMLElement)
      .map(($e) => {
        const vli = $e["visibleLayoutInfo"];
        if (
          vli == null ||
          !(vli instanceof CalendarColumnLayoutGroup.LayoutInfo)
        ) {
          return null;
        }
        return {
          $e,
          info: vli,
        };
      })
      .filter(Utils.isPresent);
  }

  /**
   * Plans all semantic spans and makes the validated plan current for this group.
   * Only successful calls supersede queued applications, including cache hits.
   */
  plan(
    infos: readonly CalendarColumnLayoutGroup.LayoutInfo[],
  ): CalendarColumnLayoutGroup.Plan {
    const plan = CalendarColumnLayoutGroup.Plan.generate(infos, this.previousLayout);
    this.previousLayout = plan;
    ++this.layoutGeneration;
    return plan;
  }

  /**
   * Applies only this group's current plan; independent or stale plans are ignored.
   * The caller owns membership, including wrappers, and must apply an empty list
   * when selection becomes empty. For bound destinations, Cell.info must be the
   * exact current visibleLayoutInfo object; ordinary HTML without a getter works.
   * Any moved/rebound destination cancels the entire queued batch. Moving an
   * intact wrapper keeps immediate parents stable, so the caller must supersede
   * applications when wrapper/selection ownership changes. Recycle cancels all.
   */
  applyPlan(
    plan: CalendarColumnLayoutGroup.Plan,
    cells: readonly CalendarColumnLayoutGroup.Cell[],
  ): void {
    if (plan !== this.previousLayout) return;
    const residentIds = new Set<string>();
    const entries = cells.map((cell) => {
      if (residentIds.has(cell.info.id)) {
        throw new Error(`Duplicate calendar resident ID: ${cell.info.id}`);
      }
      residentIds.add(cell.info.id);
      const entry = plan.byId.get(cell.info.id);
      if (entry == null || entry.startMs !== cell.info.time.start.toMs ||
          entry.endMs !== cell.info.time.end.toMs) {
        throw new Error(`Calendar resident is absent or changed in layout plan: ${cell.info.id}`);
      }
      return entry;
    });
    this.applyEntries(cells, entries);
  }

  layout(cells: CalendarColumnLayoutGroup.Cell[] = this.visibleCells()): void {
    cells.sort(CalendarColumnLayoutGroup.CELL_COMPARATOR);
    // Legacy full-mount callers may have duplicate IDs; positional correlation
    // preserves their behavior. Keyed subset planning deliberately rejects them.
    const plan = planFromOrderedInfos(
      cells.map(({ info }) => info), this.previousLayout, "positional",
    );
    this.previousLayout = plan;
    this.applyEntries(cells, plan.entries);
  }

  private applyEntries(
    cells: readonly CalendarColumnLayoutGroup.Cell[],
    entries: readonly CalendarColumnLayoutGroup.PlanEntry[],
  ): void {
    const generation = ++this.layoutGeneration;
    const dirty: number[] = [];
    for (let index = 0; index < cells.length; index++) {
      const $e = cells[index].$e;
      if (
        $e.hasAttribute("pending-layout") ||
        CalendarColumnLayoutGroup.unrevealed.has($e) ||
        entries[index].properties.some(({ name, value }) =>
          $e.style.getPropertyValue(name) !== value
        )
      ) dirty.push(index);
    }
    if (dirty.length === 0) return;
    const owners = cells.map(({ $e, info }) => ({
      $e,
      visibleLayoutInfo: ($e as HTMLElement & {
        readonly visibleLayoutInfo: Option<
          CalendarColumnLayoutGroup.LayoutInfo
        >;
      }).visibleLayoutInfo,
      $parent: $e.parentElement,
      info,
    }));
    $$.mutate(() => {
      // A newer layout, recycle, or moved/rebound cell supersedes this write.
      if (generation !== this.layoutGeneration) return;
      const applyStart = FrameMarks.begin();
      if (
        owners.some(({ $e, visibleLayoutInfo, $parent, info }) =>
          $e.parentElement !== $parent ||
          (visibleLayoutInfo != null && visibleLayoutInfo !== info) ||
          ($e as HTMLElement & {
              readonly visibleLayoutInfo: Option<
                CalendarColumnLayoutGroup.LayoutInfo
              >;
            }).visibleLayoutInfo !== visibleLayoutInfo
        )
      ) return;
      for (const index of dirty) {
        const $e = owners[index].$e;
        $e.assignStyles(entries[index].style);
        // First reveal still shares the write that positions the cell.
        CalendarColumnLayoutGroup.clearPendingLayout($e);
      }
      FrameMarks.end("layout-group.apply", applyStart, dirty.length, cells.length);
    });
  }

  static $styles = [
    css`
      :host {
        display: block;
        position: relative;
        height: 100%;
        width: 100%;
      }

      /* The owner's latest read for this lane failed (CalendarDaysStrip sets
         it, with a title): a faint red hatch so "not loaded" never reads as
         "no events". */
      :host([data-read-failed]) {
        background-image: repeating-linear-gradient(
          135deg,
          var(--red-dimmed) 0 1px,
          transparent 1px 8px
        );
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <slot></slot>
  `;
}

export namespace CalendarColumnLayoutGroup {
  /**
   * Where a lane's cell starts across its group: a fixed `px`, or an
   * equal-width `share` of the group less a reserve (`columnIndex` of
   * `numColumns` lanes). The numbers are the owner; the CSS the group writes
   * (`Lane.offsetCss`) and the rough layer's boxes (`Lane.offsetLength`)
   * are both read from them.
   */
  export type LaneOffset =
    | { readonly px: number }
    | { readonly share: { readonly reservePx: number; readonly numColumns: number; readonly columnIndex: number } };

  /** A lane's geometry as numbers: the x offset, the end inset, the extra height and the top margin, in px of the cell. */
  export type Lane = {
    readonly xOffset: LaneOffset;
    readonly endInsetPx: number;
    readonly additionalHeightPx: number;
    readonly marginTopPx: number;
  };

  export namespace Lane {
    /** The offset as `fraction·G + px` of the group's width `G`. */
    export function offsetLength(offset: LaneOffset): { readonly fraction: number; readonly px: number } {
      if ("px" in offset) return { fraction: 0, px: offset.px };
      const { reservePx, numColumns, columnIndex } = offset.share;
      const fraction = numColumns === 0 ? 0 : columnIndex / numColumns;
      return { fraction, px: -reservePx * fraction };
    }

    /** The offset as the CSS length the group writes into `--std-calendar-cell-x-offset`. */
    export function offsetCss(offset: LaneOffset): string {
      if ("px" in offset) return offset.px + "px";
      const { reservePx, numColumns, columnIndex } = offset.share;
      return `calc((100% - ${reservePx}px) / ${numColumns} * ${columnIndex})`;
    }
  }

  /** Element-free complete overlap facts, in comparator order. */
  export type PlanEntry = {
    readonly id: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly layout: Readonly<Layout>;
    /** The lane's geometry as numbers; `style` and `properties` are rendered from it. */
    readonly lane: Lane;
    readonly style: Readonly<CSSStyleWithVariables>;
    readonly properties: readonly { readonly name: string; readonly value: string }[];
  };

  export type Plan = {
    readonly geometry: readonly { readonly startMs: number; readonly endMs: number }[];
    readonly entries: readonly PlanEntry[];
    readonly byId: {
      readonly get: (id: string) => Option<PlanEntry>;
      readonly has: (id: string) => boolean;
      readonly size: number;
    };
  };
  export namespace Plan {
    /**
     * Pure complete-input planner; it does not establish current group ownership.
     * Use group.plan() to establish ownership before group.applyPlan(). Identical
     * semantic inputs return the previous immutable plan; shifts/renames remap
     * facts after sorting and share lane styles when relative shape is unchanged.
     * Positional mode preserves duplicate-ID legacy full-mount callers only.
     */
    export function generate(
      descriptors: readonly LayoutInfo[],
      previous: Option<Plan> = null,
      identityMode: "keyed" | "positional" = "keyed",
    ): Plan {
      const infos = [...descriptors].sort((a, b) => a.compare(b));
      return planFromOrderedInfos(infos, previous, identityMode);
    }
  }

  export type Cell<T extends HTMLElement = HTMLElement> = {
    $e: T;
    info: LayoutInfo;
  };

  export class LayoutInfo {
    constructor(
      readonly id: string,
      readonly time: DurationTime.Range,
    ) {}

    compare(o: LayoutInfo): number {
      let result = this.time.start.cmp(o.time.start);
      if (result !== 0) {
        return result;
      }
      // Preserve the established end-ascending ordering.
      result = this.time.end.cmp(o.time.end);
      if (result !== 0) {
        return result;
      }
      // Use a stable comparator (It is possible that title could be null)
      return this.id.localeCompare(o.id);
    }
  }

  export const CELL_COMPARATOR = (e1: Cell, e2: Cell) =>
    e1.info.compare(e2.info);

  export interface Layout {
    numColumns: number;
    columnIndex: number;
    canExpand: boolean;
    debugColor: Option<string>;
  }
  export namespace Layout {
    export function generate(
      events: Cell[],
      options: Option<Optional<{
        expandThreshold: Duration.Time;
      }>> = null,
    ): {
      sortedEvents: Cell[];
      layouts: Layout[];
    } {
      const sortedEvents: Cell[] = events.sort(CELL_COMPARATOR);
      return {
        sortedEvents,
        layouts: computeOrderedLayouts(sortedEvents.map(({ info }) => info), options),
      };
    }

    /** Pure descriptor computation; never retains or inspects DOM elements. */
    export function generateInfos(
      infos: readonly LayoutInfo[],
      options: Option<Optional<{ expandThreshold: Duration.Time }>>,
    ): { sortedInfos: LayoutInfo[]; layouts: Layout[] } {
      const sortedInfos = [...infos].sort((a, b) => a.compare(b));
      const layouts = computeOrderedLayouts(sortedInfos, options);
      return { sortedInfos, layouts };
    }
  }
}

// Only adapters that have already established comparator order call this helper.
function planFromOrderedInfos(
  infos: readonly CalendarColumnLayoutGroup.LayoutInfo[],
  previous: Option<CalendarColumnLayoutGroup.Plan>,
  identityMode: "keyed" | "positional",
): CalendarColumnLayoutGroup.Plan {
  // Positional mode is only for the legacy full-mount API. Subsets need
  // unambiguous IDs; silently choosing the last duplicate changes lanes.
  if (identityMode === "keyed") {
    const ids = new Set<string>();
    for (const info of infos) {
      if (ids.has(info.id)) {
        throw new Error(`Duplicate calendar layout ID: ${info.id}`);
      }
      ids.add(info.id);
    }
  }
  const origin = infos[0]?.time.start.toMs ?? 0;

  if (previous != null && previous.entries.length === infos.length &&
      infos.every((info, index) =>
        previous.entries[index].id === info.id &&
        previous.entries[index].startMs === info.time.start.toMs &&
        previous.entries[index].endMs === info.time.end.toMs
      )) return previous;
  const sameShape = previous != null && previous.geometry.length === infos.length &&
    infos.every((info, index) =>
      previous.geometry[index].startMs === info.time.start.toMs - origin &&
      previous.geometry[index].endMs === info.time.end.toMs - origin
    );
  const geometry = sameShape ? previous.geometry : Object.freeze(infos.map((info) => Object.freeze({
    startMs: info.time.start.toMs - origin,
    endMs: info.time.end.toMs - origin,
  })));
  const shape = sameShape ? previous.entries : generateEntries(infos);
  const entries = infos.map((info, index) => Object.freeze({
    ...shape[index], id: info.id,
    startMs: info.time.start.toMs, endMs: info.time.end.toMs,
  }));
  const indexed = new Map(entries.map((entry) => [entry.id, entry]));
  const byId = Object.freeze({
    get: (id: string): Option<CalendarColumnLayoutGroup.PlanEntry> => indexed.get(id),
    has: (id: string): boolean => indexed.has(id),
    size: indexed.size,
  });
  const plan = Object.freeze({ geometry, entries: Object.freeze(entries), byId });
  return plan;
}

function generateEntries(
  infos: readonly CalendarColumnLayoutGroup.LayoutInfo[],
): CalendarColumnLayoutGroup.PlanEntry[] {
  // Inputs are already ordered here. The core solver owns its required
  // defensive sort; do not sort through the full-mount adapter again.
  const { layouts } = ColumnLayout.compute(infos.map((info) => ({
    id: info.id,
    startMs: info.time.start.toMs,
    endMs: info.time.end.toMs,
  })), Duration.Time.MIN15.toMs);
  // The lane's numbers come first; the CSS below is rendered from them, so the
  // rough layer (RoughGeometry.cellBox) and the cell read one owner.
  const lanes: CalendarColumnLayoutGroup.Lane[] = layouts.map((layout) => {
    if (layout.columnIndex === 0) {
      return { xOffset: { px: 3.5 }, endInsetPx: 1, additionalHeightPx: -2, marginTopPx: 0 };
    } else if (layout.canExpand) {
      return { xOffset: { px: 2.5 + layout.columnIndex * 5 }, endInsetPx: 1, additionalHeightPx: -1, marginTopPx: 0 };
    } else {
      return {
        xOffset: { share: { reservePx: 20, numColumns: layout.numColumns, columnIndex: layout.columnIndex } },
        endInsetPx: 1,
        additionalHeightPx: 0,
        marginTopPx: -1,
      };
    }
  });
  const styles = layouts.map((layout, index) => {
    const lane = lanes[index];
    const base = {
      zIndex: String(layout.columnIndex),
      background: "",
      "--std-calendar-cell-end-inset": lane.endInsetPx + "px",
      "--std-calendar-cell-x-offset": CalendarColumnLayoutGroup.Lane.offsetCss(lane.xOffset),
      "--std-calendar-cell-additional-height": lane.additionalHeightPx + "px",
    };
    if (layout.columnIndex === 0) {
      return {
        ...base,
        border: "",
        "--additional-width": (layout.numColumns > 1 ? -8 : 0) + "px",
        margin: "",
      };
    } else if (layout.canExpand) {
      return {
        ...base,
        border: "1px solid var(--bg)",
        "--additional-width": 0 + "px",
        margin: "",
      };
    } else {
      return {
        ...base,
        border: "1px solid var(--bg)",
        "margin-right": "1px",
        "margin-top": lane.marginTopPx + "px",
        "--additional-width": 0 + "px",
      };
    }
  });

  return infos.map((info, index) => ({
    id: info.id, startMs: info.time.start.toMs, endMs: info.time.end.toMs,
    layout: Object.freeze({ ...layouts[index], debugColor: null }),
    lane: Object.freeze({ ...lanes[index], xOffset: Object.freeze(lanes[index].xOffset) }),
    style: Object.freeze(styles[index]),
    properties: Object.freeze(Object.entries(styles[index]).map(([name, value]) =>
      Object.freeze({
        name: name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()),
        value: String(value ?? ""),
      })
    )),
  }));
}

function computeOrderedLayouts(
  infos: readonly CalendarColumnLayoutGroup.LayoutInfo[],
  options: Option<Optional<{ expandThreshold: Duration.Time }>>,
): CalendarColumnLayoutGroup.Layout[] {
  const expandThresholdMs = options?.expandThreshold?.toMs ?? Duration.Time.MIN15.toMs;
  const inputs = infos.map((info) => ({
    id: info.id, startMs: info.time.start.toMs, endMs: info.time.end.toMs,
  }));

  const { layouts: coreLayouts } = ColumnLayout.compute(
    inputs,
    expandThresholdMs,
  );

  const layouts: CalendarColumnLayoutGroup.Layout[] = coreLayouts.map((r) => ({
    numColumns: r.numColumns,
    columnIndex: r.columnIndex,
    canExpand: r.canExpand,
    debugColor: null,
  }));

  return layouts;
}
