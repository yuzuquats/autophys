/**
 * The pitch deck: every slide shares one frame (eyebrow, title, description),
 * so those three sit at the same place on every slide and only the body
 * changes. Each body kind is a template any slide may use, in any number
 * and order. The app passes its own slides; the cookbook ships none.
 */
export type DeckStat = { value: string; label: string };
export type DeckBar = {
  label: string;
  value: string;
  share: number;
  emphasis?: boolean;
};
export type Cta = { label: string; href: string };
export type DeckBody =
  | { kind: "actions"; primary: Cta | null; stats: DeckStat[] }
  | { kind: "person"; name: string; role: string }
  | { kind: "breakdown"; stats: DeckStat[]; segments: DeckBar[] }
  | {
    kind: "comparison";
    columns: [string, string];
    rows: { label: string; before: string; after: string }[];
  }
  | { kind: "demo"; caption: string }
  | { kind: "result"; bars: DeckBar[]; primary: Cta | null }
  | DeckLines
  | DeckProfile
  | DeckUncertainty
  | DeckCases
  | DeckTerminal
  | DeckChat
  | DeckBrowser
  | DeckUses
  | DeckLoops
  | DeckFeedback;

/** Chart bodies (src/deck-charts.ts). The values are supplied by the app; the deck only scales them. */
export type DeckAxis = {
  label: string;
  min: number;
  max: number;
  ticks?: number[];
  unit?: string;
};
export type DeckSeries = {
  label: string;
  points: [number, number][];
  emphasis?: boolean;
  /** One labelled point on the series, such as where it crosses the threshold. */
  marker?: { at: [number, number]; label: string };
};
/** Series over shared axes, with an optional horizontal threshold. */
export type DeckLines = {
  kind: "lines";
  x: DeckAxis;
  y: DeckAxis;
  series: DeckSeries[];
  threshold?: { value: number; label: string };
};
/** A curve over one axis (values 0..1, evenly spaced), a fixed plan's marks
 * above it and numbered picks on it; `at` positions are 0..1 along the axis. */
export type DeckProfile = {
  kind: "profile";
  axis: string[];
  curve: { label: string; values: number[] };
  fixed: { label: string; at: number[] };
  picks: { label: string; at: number[] };
};
/** One row per case: a base value and an emphasised value on one shared axis
 * (log scale when `axis.log`), with the case's outcome beside them. The
 * emphasised value is drawn hollow, labelled with `caveat`, when it is not a
 * real measurement. */
export type DeckCases = {
  kind: "cases";
  axis: DeckAxis & { log?: boolean };
  /** Legend labels for the base and the emphasised value. */
  legend: [string, string];
  rows: DeckCase[];
  /** A short caveat under the legend. */
  note?: string;
};
export type DeckCase = {
  label: string;
  base: number;
  value: number;
  outcome: string;
  /** The base's own outcome, under the row's outcome. */
  baseOutcome?: string;
  emphasis?: boolean;
  baseEmphasis?: boolean;
  caveat?: string;
};
/** Joint uncertainty of two quantities as ellipses around the estimate,
 * inside a target box. Sizes are fractions of the square plot (0..1); angle in degrees. */
export type DeckUncertainty = {
  kind: "uncertainty";
  axes: [string, string];
  target: { label: string; size: number };
  regions: {
    label: string;
    rx: number;
    ry: number;
    angle: number;
    emphasis?: boolean;
  }[];
};
/** Conversation bodies (src/deck-convo.ts). */
/** Shell lines in a dark card: `# …` is a comment, "" a blank line, anything
 * else a command (shown after a `$` prompt, with its words coloured). */
export type DeckTerminal = {
  kind: "terminal";
  label?: string;
  lines: string[];
};
/** A chat between the person and one agent, drawn as iOS message bubbles.
 * Consecutive messages from one sender form a run; `source` is a small
 * monospace line above the text (for example the tool a claim came from).
 * An optional approval card closes the thread; its actions are illustrative,
 * not controls, and the first is drawn as the primary one. */
export type DeckChat = {
  kind: "chat";
  agent: { name: string; avatar?: string };
  messages: { from: "user" | "agent"; text: string; source?: string }[];
  approval?: {
    label: string;
    title: string;
    rows: { label: string; value: string }[];
    actions: string[];
  };
};
/** A browser window card: `url` in the address bar, numbered steps below,
 * and an optional primary action under the card (deck-convo.ts). */
export type DeckBrowser = {
  kind: "browser";
  url: string;
  steps: { title: string; detail?: string }[];
  primary: Cta | null;
};
/** A wall of use-case cards in a masonry grid, faded out at the bottom so a
 * long list reads as open-ended (deck-uses.ts). `icon` is trusted inner SVG
 * markup for a 24 px stroked line icon; `live` marks cases that run today. */
export type DeckUses = {
  kind: "uses";
  uses: {
    name: string;
    pair: string;
    choice: string;
    note?: string;
    icon?: string;
    live?: boolean;
    emphasis?: boolean;
  }[];
  legend?: { live: string; other: string };
};
/** Loop bodies (src/deck-loops.ts). `icon` is trusted inner SVG markup for a
 * 24 px stroked line icon; `avatar` is an image URL drawn as a round icon instead. */
export type DeckCell = {
  title: string;
  caption: string;
  icon?: string;
  avatar?: string;
  /** A small badge after the title, such as "today". */
  tag?: string;
  emphasis?: boolean;
  /** Drawn outlined: a step that does not run yet. */
  planned?: boolean;
};
/** One inner loop: a titled card with four steps on a ring, clockwise from
 * the top left, and an optional note in the middle (such as when it stops). */
export type DeckLoopCard = {
  title: string;
  caption: string;
  avatar?: string;
  badge?: string;
  steps: [string, string, string, string];
  note?: string;
};
/** An outer ring of three steps around the inner-loop card, travelling
 * clockwise: top, then the card, then bottom, then left. */
export type DeckLoops = {
  kind: "loops";
  inner: DeckLoopCard;
  outer: { top: DeckCell; bottom: DeckCell; left: DeckCell };
};
/** Steps beside the inner-loop card: the card feeds the first, and the last
 * feeds back into the card along an arrow labelled `back`. */
export type DeckFeedback = {
  kind: "feedback";
  inner: DeckLoopCard;
  steps: DeckCell[];
  back: string;
};
export type DeckSlide = {
  eyebrow: { label: string } | { icon: "mark" };
  /** Under about 60 characters: two lines from 640px, three on phones. */
  title: string;
  /** Under about 120 characters. */
  description: string;
  body: DeckBody;
  /** Later states of this slide, shown in place before the deck moves on (as
   * Keynote builds do): each replaces the eyebrow, title, description and
   * body. An element marked `data-ck-share` in both bodies moves between its
   * two places (FLIP) instead of fading, such as the loop bodies' card. */
  builds?: DeckBuild[];
  /** Stepping forward onto this slide also opens the app, as the down arrow
   * does, and starts the tutorial; the slide stays behind it, shown on the way
   * back. The arrows then step through the tutorial, and the right arrow on
   * its last step returns to the deck at the following slide. */
  opensApp?: boolean;
};
export type DeckBuild = Omit<DeckSlide, "builds" | "opensApp">;

/** Where one step lands, given each slide's build count: through the current
 * slide's builds first, then to the next slide's first build (forwards) or
 * the previous slide's last build (backwards). The ends stay put. */
export function stepTarget(
  index: number,
  build: number,
  delta: number,
  builds: readonly number[],
): { index: number; build: number } {
  const dir = Math.sign(delta);
  if (build + dir >= 0 && build + dir < builds[index]) {
    return { index, build: build + dir };
  }
  const target = clampSlide(index + dir, builds.length);
  if (target === index) return { index, build };
  return { index: target, build: dir > 0 ? 0 : builds[target] - 1 };
}

/** Where the cases chart places things, as fractions of its band (x, 0 at
 * the axis minimum) and of its height (y): every tick, and per row the y of
 * its centre line, which its label, rail, dots and outcome share, and the x
 * of its base and value dots. Values outside the axis, or at or below zero
 * on a log axis, clamp to the nearest edge. `paired` rows also show a base
 * outcome, so their own outcome sits on the upper half of the row. */
export type CaseLayout = {
  ticks: { value: number; x: number }[];
  rows: { y: number; base: number; value: number; paired: boolean }[];
};
export function caseLayout(body: Pick<DeckCases, "axis" | "rows">): CaseLayout {
  const { axis, rows } = body;
  const f = (v: number) => (axis.log ? Math.log10(Math.max(v, Number.MIN_VALUE)) : v);
  const lo = f(axis.min), hi = f(axis.max);
  const x = (v: number) => Math.max(0, Math.min(1, (f(v) - lo) / (hi - lo || 1)));
  return {
    ticks: (axis.ticks ?? []).map((value) => ({ value, x: x(value) })),
    rows: rows.map((row, i) => ({
      y: (i + 0.5) / Math.max(1, rows.length),
      base: x(row.base),
      value: x(row.value),
      paired: Boolean(row.baseOutcome),
    })),
  };
}

export function clampSlide(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(index)));
}

/** Legacy exported helper retained for API compatibility; createDeck uses
 * Hacks’ 15% distance-only release instead. Where a released swipe lands: a drag past a fifth of the width, or a
 * flick faster than 0.4 px/ms, moves one slide from the rounded starting
 * position; anything else springs back to that starting slide. */
export function swipeTarget(
  start: number,
  dx: number,
  width: number,
  velocity: number,
  count: number,
): number {
  const index = Math.round(start);
  const flick = Math.abs(velocity) > 0.4 && Math.abs(dx) > 8;
  const far = width > 0 && Math.abs(dx) > width / 5;
  if (!flick && !far) return index;
  return clampSlide(index + (dx < 0 ? 1 : -1), count);
}

/** Legacy exported helper retained for API compatibility. The live adapter
 * uses the bounded shared deckPull layer instead. */
export function dragOffset(index: number, dx: number, count: number): number {
  const pastStart = index === 0 && dx > 0,
    pastEnd = index === count - 1 && dx < 0;
  return pastStart || pastEnd ? dx * 0.35 : dx;
}
