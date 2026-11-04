/**
 * The view model: everything the three surfaces draw, already derived. The caller decides
 * which nodes exist, what each trail says and in which tone, which rows are greyed, every
 * number's text and every chart's points; these components only lay it out and draw it.
 * Nothing here is a domain type: a fit, a proposal or a ridge is just rows, tags and series.
 */

/** Colour roles. The renderer maps each to a CSS variable; it never picks one itself. */
import type { SidebarExtras } from "./sidebar-model.ts";
import type { ProjectSetupBody } from "./new-project.ts";

export type Tone = "default" | "muted" | "ok" | "warn" | "run" | "danger";

/** Glyphs the package draws (icons.ts). */
export type IconName =
  | "workspace" | "device" | "config" | "investigation" | "measurements" | "measurement" | "fit" | "sensitivity"
  | "proposal" | "validate" | "view" | "residuals" | "landscape" | "envelope" | "frequency" | "zoom" | "plus" | "chevron";

/** A row's trailing edge: text in a tone, optionally a spinner before it, or a count badge. */
export type Trail = { text?: string; tone?: Tone; spinner?: boolean; badge?: string; label?: string };

export type TreeNode = {
  id: string;
  label: string;
  icon: IconName;
  trail?: Trail;
  /** Draws label and glyph in the tertiary colour. */
  dim?: boolean;
  /** Whether clicking a branch selects it; a leaf always does. */
  selectable: boolean;
  /** `null` is a leaf. */
  children: TreeNode[] | null;
};

export type Action = { name: string; label: string; variant?: "primary" | "secondary" | "ghost"; disabled?: boolean; title?: string };

// ------------------------------------------------------------------------------------ sidebar

export type SidebarModel = SidebarExtras & {
  /** Legacy source-load state; the workspace rail renders no project switcher. */
  switcher: { kind: "none" | "loading" | "single" | "select" | "unavailable"; label: string; value: string; options: { value: string; label: string }[] };
  /** Devices navigation, above the project section. */
  pinned: TreeNode;
  notice?: { kind: "no-projects" | "no-investigations" | "loading" | "unavailable"; title: string; description: string };
  section: { label: string; count: string; add?: Action };
  nodes: TreeNode[];
  /** The tree's accessible name. */
  treeLabel: string;
  selectedId: string | null;
  expandedIds: string[];
};

// ------------------------------------------------------------------------------------ charts

/** How a series is drawn: measured dots, a dashed initial guess, the black fit, and so on. */
export type SeriesTone = "measured" | "initial" | "fit" | "run" | "input" | "muted" | "warn";

export type Tick = { value: number; label: string };
export type Axis = { min: number; max: number; ticks: Tick[]; label?: string; log?: boolean };

export type Point = [number, number];
export type Layer =
  | { kind: "dots"; points: Point[]; tone: SeriesTone; r?: number }
  | { kind: "line"; points: Point[]; tone: SeriesTone; dashed?: boolean }
  /** A horizontal band between two y values (a noise band). */
  | { kind: "hband"; from: number; to: number; tone: SeriesTone }
  | { kind: "vband"; from: number; to: number; tone: SeriesTone }
  | { kind: "hline"; y: number; tone: SeriesTone }
  | { kind: "vline"; x: number; tone: SeriesTone };

export type LegendItem = { label: string; mark: "dot" | "line" | "dashed"; tone: SeriesTone };

/** A plot in data coordinates. `xTicks: false` hides the x labels (a strip above a chart that shares its axis). */
export type XYChart = {
  kind: "xy"; height: number; x: Axis; y: Axis; layers: Layer[];
  label?: string; legend?: LegendItem[]; xTicks?: boolean; left?: number;
};

/** A grid of cells, `values` row-major from the bottom row, each an opacity in [0, 1], plus an optional path over it. */
export type HeatmapChart = {
  kind: "heatmap"; height: number; x: Axis; y: Axis; cols: number; rows: number; values: number[];
  trail?: { points: Point[]; label?: string };
  label?: string;
};

export type BarRow = { label: string; fraction: number; value: string; tone?: Tone };
export type BarsChart = { kind: "bars"; rows: BarRow[]; label?: string };

/** One row per range: a track from `lo` to `hi` with a marker at `at` (a fraction of the track). */
export type RangeRow = { label: string; unit?: string; lo: string; hi: string; at: number; initial?: string; scale?: string; tag?: Tag; note?: string };
export type RangesChart = { kind: "ranges"; rows: RangeRow[]; label?: string };

export type Missing = { kind: "missing"; title: string; description: string };
export type Chart = XYChart | HeatmapChart | BarsChart | RangesChart | Missing;

/** Charts stacked in one block, sharing its width (an input strip over its output). */
export type ChartPanel = { title?: string; charts: Chart[]; blocks?: Block[] };

// ------------------------------------------------------------------------------------ main

/** A crumb segment; with an `id` it is a link that selects that node. */
export type Crumb = { label: string; id?: string };

export type MainBody =
  | ProjectSetupBody
  | { kind: "empty"; text: string }
  | Missing
  | { kind: "loading"; title: string; description: string }
  | { kind: "unavailable"; title: string; description: string }
  /** `serve --login`, signed out: the one place that asks to sign in. */
  | { kind: "signed-out"; title: string; description: string }
  | { kind: "onboarding"; title: string; description: string; snippet: string; copyLabel: string; note: string }
  | { kind: "configuration"; parameters: RangesChart; experiments: Section[]; sections: Section[] }
  /** Cards stacked in one column, each a Section with its caption (a proposal: candidates, then reasoning). */
  | { kind: "decision"; cards: Section[] }
  | { kind: "panels"; panels: ChartPanel[]; columns?: number };

export type MainModel = {
  source?: "demo" | "live";
  connectionError?: string;
  crumb: Crumb[];
  meta: string;
  actions: Action[];
  body: MainBody;
  /** The one credit line under the viewer. */
  credit: string;
  creditLabel?: string;
};

// ------------------------------------------------------------------------------------ details

export type Tag = { text: string; tone?: Tone };

export type Fact = { label: string; value: string; tone?: Tone; tag?: Tag; note?: string };
export type Cell = { text: string; unit?: string; tag?: Tag; end?: boolean };
/** `strong` marks the row a table is about (the proposal among its candidates). */
export type TableRow = { cells: Cell[]; dim?: boolean; strong?: boolean };
/** One step of a reasoning trace: `current` is expanded with its evidence and expectation; the others show one line. */
export type TraceRow = { title: string; meta?: string; text?: string; evidence?: string[]; expected?: string; current?: boolean; tone?: Tone };
export type Meter = { label: string; value: string; fraction: number; tone?: Tone };
/** An editable value. `value` is the raw text shown; `invalid` marks the field with a message. */
export type Field = { name: string; label: string; value: string; unit?: string; invalid?: string };
export type Link = { label: string; id: string };

export type TextStep = { label: string; delayMs: number };

export type Block =
  | Missing
  | { kind: "pairing"; device: string; client: string; code: string; expiry: { at: string; steps: TextStep[] }; decision: [Action, Action] }
  | { kind: "facts"; rows: Fact[] }
  | { kind: "table"; rows: TableRow[] }
  | { kind: "bars"; rows: BarRow[] }
  | { kind: "meters"; rows: Meter[] }
  | { kind: "fields"; fields: Field[] }
  | { kind: "links"; links: Link[] }
  | { kind: "text"; text: string; tone?: Tone; link?: Link }
  /** A small trace (an experiment's input preview); `label` names it for assistive tech and the hover title, `caption` shows above it. */
  | { kind: "wave"; t: number[]; y: number[]; label: string; caption?: string }
  | { kind: "trace"; steps: TraceRow[] };

/** `caption` is one line under the heading; renderers without a caption slot ignore it. */
export type Section = { heading: string; caption?: string; blocks: Block[] };

export type DetailsModel = {
  icon: IconName;
  title: string;
  /** Marks the title as the name a mirrored review card shows. */
  cardName?: boolean;
  /** Draw placeholder blocks instead of the header and sections (signed out, nothing to show). */
  placeholder?: boolean;
  status: { text: string; tone?: Tone };
  sections: Section[];
  /** The decision row: exactly two buttons. */
  decision?: [Action, Action];
  /** Any other buttons, in a row of their own. */
  actions?: Action[];
  /** One quiet line after everything else (provenance). */
  footnote?: string;
};
