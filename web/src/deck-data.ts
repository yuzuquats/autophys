/**
 * The pitch deck: every slide shares one frame (eyebrow, title, description),
 * so those three sit at the same place on every slide and only the body
 * changes. Each body kind is a template any slide may use. The slides below
 * are neutral placeholders until the operator says what autophys is for.
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

const openApp: Cta = { label: "Open app", href: "/app" };
const stat = (label: string): DeckStat => ({ value: "—", label });

export const slides: DeckSlide[] = [
  {
    eyebrow: { icon: "mark" },
    title: "autophys",
    description: "Placeholder description for the first slide.",
    body: {
      kind: "actions",
      primary: openApp,
      stats: [stat("Placeholder"), stat("Placeholder"), stat("Placeholder")],
    },
  },
  {
    eyebrow: { label: "Slide 2" },
    title: "Placeholder title for slide two.",
    description: "Placeholder description.",
    body: { kind: "person", name: "Placeholder name", role: "Placeholder role" },
  },
  {
    eyebrow: { label: "Slide 3" },
    title: "Placeholder title for slide three.",
    description: "Placeholder description.",
    body: {
      kind: "breakdown",
      stats: [stat("Placeholder"), stat("Placeholder"), stat("Placeholder")],
      segments: [
        { label: "Part A", value: "", share: 20 },
        { label: "Part B", value: "", share: 50, emphasis: true },
        { label: "Part C", value: "", share: 30 },
      ],
    },
  },
  {
    eyebrow: { label: "Slide 4" },
    title: "Placeholder title for slide four.",
    description: "Placeholder description.",
    body: {
      kind: "comparison",
      columns: ["Column A", "Column B"],
      rows: [
        { label: "Row 1", before: "Placeholder", after: "Placeholder" },
        { label: "Row 2", before: "Placeholder", after: "Placeholder" },
        { label: "Row 3", before: "Placeholder", after: "Placeholder" },
      ],
    },
  },
  {
    eyebrow: { label: "Slide 5" },
    title: "Placeholder title for slide five.",
    description: "Placeholder description.",
    body: { kind: "demo", caption: "Placeholder" },
  },
  {
    eyebrow: { label: "Slide 6" },
    title: "Placeholder title for slide six.",
    description: "Placeholder description.",
    body: {
      kind: "result",
      bars: [
        { label: "Bar A", value: "—", share: 100 },
        { label: "Bar B", value: "—", share: 40, emphasis: true },
      ],
      primary: openApp,
    },
  },
];

export function clampSlide(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(index)));
}

/** Where a released swipe lands: a drag past a fifth of the width, or a
 * flick faster than 0.4 px/ms, moves one slide; anything else springs back. */
export function swipeTarget(
  index: number,
  dx: number,
  width: number,
  velocity: number,
  count: number,
): number {
  const flick = Math.abs(velocity) > 0.4 && Math.abs(dx) > 8;
  const far = width > 0 && Math.abs(dx) > width / 5;
  if (!flick && !far) return index;
  return clampSlide(index + (dx < 0 ? 1 : -1), count);
}

/** Drag offset with resistance past the first and last slide. */
export function dragOffset(index: number, dx: number, count: number): number {
  const pastStart = index === 0 && dx > 0, pastEnd = index === count - 1 && dx < 0;
  return pastStart || pastEnd ? dx * 0.35 : dx;
}
