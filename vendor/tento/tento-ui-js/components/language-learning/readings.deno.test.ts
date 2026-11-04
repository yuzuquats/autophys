import { readingSegments } from "./readings.ts";
import type { StudyToken } from "./model.ts";

const token = (text: string, values: Partial<StudyToken> = {}): StudyToken => ({
  text,
  pinyin: "",
  zhuyin: "",
  kana: "",
  romaji: "",
  groups: [],
  ...values,
});
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(JSON.stringify({ actual, expected }));
  }
}

Deno.test("Pinyin and Zhuyin attach to corresponding Mandarin characters", () => {
  const word = token("神社", { pinyin: "shén shè", zhuyin: "ㄕㄣˊ ㄕㄜˋ" });
  equal(readingSegments(word, "zh", "pinyin"), [
    { text: "神", reading: "shén" },
    { text: "社", reading: "shè" },
  ]);
  equal(readingSegments(word, "zh", "zhuyin"), [{
    text: "神",
    reading: "ㄕㄣˊ",
  }, { text: "社", reading: "ㄕㄜˋ" }]);
});
Deno.test("Japanese word readings remain intact and empty/off readings add no ruby", () => {
  const word = token("神社", { romaji: "jinja", kana: "じんじゃ" });
  equal(readingSegments(word, "ja", "romaji"), [{
    text: "神社",
    reading: "jinja",
  }]);
  equal(readingSegments(word, "ja", "none"), [{ text: "神社", reading: "" }]);
  equal(readingSegments(token("、"), "ja", "romaji"), [{
    text: "、",
    reading: "",
  }]);
  equal(readingSegments(token("你好", { pinyin: "nihao" }), "zh", "pinyin"), [{
    text: "你好",
    reading: "nihao",
  }]);
});
