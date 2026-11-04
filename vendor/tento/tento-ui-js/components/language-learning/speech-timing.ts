import type { StudyCue, StudyToken } from "./model";

export type SpokenWord = { index: number; start: number; end: number };
export type SpeechTimeline = { words: SpokenWord[]; estimated: boolean };

/** Absolute media seconds. Caption-only fallback is an estimate, not audio alignment. */
export function speechTimeline(cue: StudyCue, tokens: StudyToken[]): SpeechTimeline {
  const words = tokens.flatMap((token, index) =>
    /[\p{L}\p{N}]/u.test(token.text) ? [{ token, index }] : []
  );
  const precise = words.length > 0 && words.every(({ token }) => {
    const timing = token.timing;
    return timing && Number.isFinite(timing.start) && Number.isFinite(timing.end) &&
      timing.start >= cue.start && timing.end <= cue.end && timing.end > timing.start;
  });
  if (precise) return {
    estimated: false,
    words: words.map(({ token, index }) => ({ index, ...token.timing! })),
  };
  const weights = words.map(({ token }) =>
    Math.max(1, [...(token.kana || token.text).replace(/[^\p{L}\p{N}]/gu, "")].length)
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let offset = 0;
  return {
    estimated: true,
    words: words.map(({ index }, i) => {
      const start = cue.start + (cue.end - cue.start) * offset / total;
      offset += weights[i];
      return { index, start, end: cue.start + (cue.end - cue.start) * offset / total };
    }),
  };
}

/** Recent words leave a short trail; seeks reconstruct state directly from time. */
export function spokenStrength(word: SpokenWord, seconds: number): number {
  if (seconds < word.start) return 0;
  const age = Math.min(1, Math.max(0, (seconds - word.end) / 2.5));
  // Smoothstep has no opacity jump at the word boundary or the trail's end.
  return 1 - age * age * (3 - 2 * age);
}

/** Sample age along the text, so adjacent words/characters share a continuous trail. */
export function spokenGradient(word: SpokenWord, seconds: number, from = 0, to = 1): [number, number] {
  return [from, to].map((fraction) => spokenStrength({
    ...word,
    end: word.start + (word.end - word.start) * fraction,
  }, seconds)) as [number, number];
}
