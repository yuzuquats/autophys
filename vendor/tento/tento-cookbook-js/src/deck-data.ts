/**
 * The pitch deck: every slide shares one frame (eyebrow, title, description),
 * so those three sit at the same place on every slide and only the body
 * changes. Each body kind is a template any slide may use, in any number
 * and order. The app passes its own slides; the cookbook ships none.
 */
export type DeckStat = { value: string; label: string };
export type DeckBar = { label: string; value: string; share: number; emphasis?: boolean };
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
  | DeckTerminal
  | DeckChat;

/** Chart bodies (src/deck-charts.ts). The values are supplied by the app; the deck only scales them. */
export type DeckAxis = { label: string; min: number; max: number; ticks?: number[]; unit?: string };
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
/** Joint uncertainty of two quantities as ellipses around the estimate,
 * inside a target box. Sizes are fractions of the square plot (0..1); angle in degrees. */
export type DeckUncertainty = {
  kind: "uncertainty";
  axes: [string, string];
  target: { label: string; size: number };
  regions: { label: string; rx: number; ry: number; angle: number; emphasis?: boolean }[];
};
/** Conversation bodies (src/deck-convo.ts). */
/** Shell lines in a dark card: `# …` is a comment, "" a blank line, anything
 * else a command (shown after a `$` prompt, with its words coloured). */
export type DeckTerminal = { kind: "terminal"; label?: string; lines: string[] };
/** A chat between the person and one agent, drawn as iOS message bubbles.
 * Consecutive messages from one sender form a run; `source` is a small
 * monospace line above the text (for example the tool a claim came from).
 * An optional approval card closes the thread; its actions are illustrative,
 * not controls, and the first is drawn as the primary one. */
export type DeckChat = {
  kind: "chat";
  agent: { name: string; avatar?: string };
  messages: { from: "user" | "agent"; text: string; source?: string }[];
  approval?: { label: string; title: string; rows: { label: string; value: string }[]; actions: string[] };
};
export type DeckSlide = {
  eyebrow: { label: string } | { icon: "mark" };
  /** Under about 60 characters: two lines from 640px, three on phones. */
  title: string;
  /** Under about 120 characters. */
  description: string;
  body: DeckBody;
};

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
  const pastStart = index === 0 && dx > 0, pastEnd = index === count - 1 && dx < 0;
  return pastStart || pastEnd ? dx * 0.35 : dx;
}
