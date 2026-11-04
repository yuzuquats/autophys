import { speechTimeline, spokenStrength, spokenGradient } from "./speech-timing.ts";
import type { StudyToken } from "./model.ts";

const token = (text: string, timing?: StudyToken["timing"]): StudyToken => ({
  text, pinyin: "", zhuyin: "", kana: "", romaji: "", timing,
});
const cue = { id: "a", text: "你好，世界", start: 10, end: 14 };
function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}

Deno.test("estimated speech skips punctuation and spans the caption without changing token indices", () => {
  const timeline = speechTimeline(cue, [token("你好"), token("，"), token("世界")]);
  assert(timeline.estimated);
  assert(JSON.stringify(timeline.words) === JSON.stringify([
    { index: 0, start: 10, end: 12 }, { index: 2, start: 12, end: 14 },
  ]));
  assert(speechTimeline(cue, [token("…")]).words.length === 0);
});

Deno.test("audio-aligned timestamps retain silence and fall back for incomplete or invalid timing", () => {
  const tokens = [token("你好", { start: 10.2, end: 11 }), token("世界", { start: 12, end: 13 })];
  const timeline = speechTimeline(cue, tokens);
  assert(!timeline.estimated);
  assert(timeline.words.every((word) => spokenStrength(word, 11.5) < 1));
  assert(speechTimeline(cue, [tokens[0], token("世界")]).estimated);
  assert(speechTimeline(cue, [token("你好", { start: 8, end: 11 })]).estimated);
});

Deno.test("current word is prominent, past words fade, and seeking backwards clears future words", () => {
  const word = { index: 0, start: 10, end: 11 };
  assert(spokenStrength(word, 10.5) === 1);
  assert(spokenStrength(word, 11.1) > spokenStrength(word, 12));
  assert(spokenStrength(word, 14) === 0);
  assert(spokenStrength(word, 9) === 0);
  assert(Math.abs(spokenStrength(word, 11 - 0.0001) - spokenStrength(word, 11 + 0.0001)) < 0.001);
  const gradient = spokenGradient(word, 11.5);
  assert(gradient[0] < gradient[1]);
  assert(spokenGradient(word, 13.5).every((value) => value === 0));
  assert(spokenGradient(word, 9).every((value) => value === 0));
  assert(spokenGradient(word, 11.5, 0, 0.5)[1] === spokenGradient(word, 11.5, 0.5, 1)[0]);
});
