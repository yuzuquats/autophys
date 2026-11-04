import type { ReadingMode, StudyToken, TranslationLanguage } from "./model";

/** Mandarin syllables attach to characters; Japanese readings attach to words. */
export function readingSegments(
  token: StudyToken,
  language: TranslationLanguage,
  mode: ReadingMode,
): { text: string; reading: string }[] {
  const reading = mode === "none" ? "" : token[mode];
  if (!reading) return [{ text: token.text, reading: "" }];
  if (language === "zh" && (mode === "pinyin" || mode === "zhuyin")) {
    const characters = [...token.text];
    const syllables = reading.trim().split(/\s+/);
    if (
      /^\p{Script=Han}+$/u.test(token.text) &&
      characters.length === syllables.length
    ) {
      return characters.map((text, i) => ({ text, reading: syllables[i] }));
    }
  }
  return [{ text: token.text, reading }];
}
