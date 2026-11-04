import { Tracing } from "@tento-core/tracing";

/**
 * Generalized Cumulative-Layout-Shift (CLS) detector.
 *
 * Wraps the browser `layout-shift` PerformanceObserver into a small,
 * page-agnostic instrument: it accumulates CLS, filters shifts that followed
 * recent user input (per the Web Vitals spec), and describes each shift's
 * attributed DOM sources (node label + rect delta) as a plain structured
 * record. It has **no** app-specific coupling — any surface (calendar app,
 * landing pages, data sheets) can point it at a sink.
 *
 * The DOM-touching pieces (`start`, `nodeInfoFrom`, `entryFrom`) live in
 * `@tento-ui` because `PerformanceObserver`/`Node`/`Element` are browser
 * globals absent from `@tento-core`. The folding logic (`ingest`,
 * `describeNode`, `describeRect`) is pure and is the unit-tested seam — it
 * takes decoupled `Entry` values, never a live `PerformanceEntry`.
 */
export class LayoutShiftDetector {
  private cumulative = 0;
  private observer: Option<PerformanceObserver> = null;
  private readonly maxSources: number;

  constructor(private readonly opts: LayoutShiftDetector.Options) {
    this.maxSources = opts.maxSources ?? LayoutShiftDetector.DEFAULT_MAX_SOURCES;
  }

  /** Running CLS across every unignored shift folded so far. */
  get cumulativeLayoutShift(): number {
    return this.cumulative;
  }

  /**
   * Fold one shift entry into the running CLS and produce a record, or return
   * `null` when the shift followed recent user input (excluded from CLS by
   * spec). Pure — no browser dependency, so this is the unit-tested seam.
   */
  ingest(entry: LayoutShiftDetector.Entry): Option<LayoutShiftDetector.ShiftRecord> {
    if (entry.hadRecentInput) return null;
    this.cumulative += entry.value;
    const sources = entry.sources.slice(0, this.maxSources).map((source) => ({
      node: LayoutShiftDetector.describeNode(source.node),
      from: LayoutShiftDetector.describeRect(source.previousRect),
      to: LayoutShiftDetector.describeRect(source.currentRect),
    }));
    return { value: entry.value, cumulative: this.cumulative, sources };
  }

  /**
   * Begin observing `layout-shift` entries. Buffered, so shifts from before
   * `start()` are still folded. No-ops (and warns) when the browser lacks
   * layout-shift instrumentation. Idempotent.
   */
  start(): void {
    if (this.observer !== null) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const record = this.ingest(LayoutShiftDetector.entryFrom(raw));
          if (record != null) this.opts.onShift(record);
        }
      });
      observer.observe({ type: "layout-shift", buffered: true });
      this.observer = observer;
    } catch (_err) {
      Tracing.warn("ui")("layout-shift observation unsupported");
    }
  }

  /** Stop observing. Retains the accumulated CLS. */
  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}

export namespace LayoutShiftDetector {
  export const DEFAULT_MAX_SOURCES = 5;

  export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }

  /** Structural DOM-node descriptor extracted from a shift source. */
  export interface NodeInfo {
    /** Uppercase tag name when the node is an `Element`, else `null`. */
    readonly tagName: Option<string>;
    /** Non-empty element id, else `null`. */
    readonly id: Option<string>;
    /** `node.nodeName` for any node, else `null`. */
    readonly nodeName: Option<string>;
  }

  /** One attributed source of a shift, already DOM-extracted. */
  export interface Attribution {
    readonly node: NodeInfo;
    readonly previousRect: Rect;
    readonly currentRect: Rect;
  }

  /** A layout-shift entry decoupled from the browser `PerformanceEntry`. */
  export interface Entry {
    readonly value: number;
    readonly hadRecentInput: boolean;
    readonly sources: readonly Attribution[];
  }

  /** A described source in an emitted record. */
  export interface Source {
    readonly node: string;
    readonly from: string;
    readonly to: string;
  }

  /** The structured record handed to `Options.onShift`. */
  export interface ShiftRecord {
    readonly value: number;
    readonly cumulative: number;
    readonly sources: readonly Source[];
  }

  export interface Options {
    /** Sink invoked once per unignored shift. */
    readonly onShift: (record: LayoutShiftDetector.ShiftRecord) => void;
    /** Cap on attributed sources per record (default `DEFAULT_MAX_SOURCES`). */
    readonly maxSources?: Option<number>;
  }

  /** Format a node descriptor as `tag#id`, else its `nodeName`, else `"?"`. */
  export function describeNode(info: NodeInfo): string {
    if (info.tagName != null && info.id != null) {
      return `${info.tagName.toLowerCase()}#${info.id}`;
    }
    if (info.nodeName != null) {
      return info.nodeName;
    }
    return "?";
  }

  /** Format a rect as `x,y WxH` with rounded integer coordinates. */
  export function describeRect(rect: Rect): string {
    return `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(
      rect.width,
    )}x${Math.round(rect.height)}`;
  }

  /** Extract a structural {@link NodeInfo} from a live DOM node (browser). */
  export function nodeInfoFrom(node: Node | null): NodeInfo {
    if (node instanceof Element) {
      return {
        tagName: node.tagName,
        id: node.id.length > 0 ? node.id : null,
        nodeName: node.nodeName,
      };
    }
    if (node !== null) {
      return { tagName: null, id: null, nodeName: node.nodeName };
    }
    return { tagName: null, id: null, nodeName: null };
  }

  // `layout-shift` entries aren't in the standard DOM lib types; declare the
  // subset used here and downcast at the browser boundary.
  interface RawAttribution {
    readonly node: Node | null;
    readonly previousRect: Rect;
    readonly currentRect: Rect;
  }
  interface RawEntry extends PerformanceEntry {
    readonly value: number;
    readonly hadRecentInput: boolean;
    readonly sources: readonly RawAttribution[];
  }

  /** Translate a live `PerformanceEntry` into a decoupled {@link Entry}. */
  export function entryFrom(raw: PerformanceEntry): Entry {
    const shift = raw as RawEntry;
    return {
      value: shift.value,
      hadRecentInput: shift.hadRecentInput,
      sources: shift.sources.map((source) => ({
        node: nodeInfoFrom(source.node),
        previousRect: source.previousRect,
        currentRect: source.currentRect,
      })),
    };
  }
}
