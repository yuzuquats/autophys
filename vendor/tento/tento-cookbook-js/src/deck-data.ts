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
  | { kind: "result"; bars: DeckBar[]; primary: Cta | null };
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
