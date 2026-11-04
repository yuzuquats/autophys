import {
  companionCues,
  companionText,
  companionTokens,
  validTranscriptBundle,
} from "./parallel-transcript.ts";
import { alignedWith } from "./model.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("assertion failed");
}

Deno.test("prepared captions retain long text cards within a bounded payload", () => {
  const cue = { id: "card", text: "word ".repeat(500), start: 1, end: 10 };
  const bundle = { version: 1, defaultTrackId: "en", tracks: [{ id: "en", label: "English", language: "en", cues: [cue] }] };
  assert(validTranscriptBundle(bundle));
  cue.text = "x".repeat(8001);
  assert(!validTranscriptBundle(bundle));
});

Deno.test("timed companions join split cues without attaching neighboring dialogue", () => {
  const source = { id: "s", text: "source", start: 10, end: 14 };
  const track = {
    id: "en",
    language: "en" as const,
    label: "English",
    cues: [
      { id: "before", text: "previous", start: 8, end: 10.1 },
      { id: "a", text: "first half", start: 10, end: 12 },
      { id: "b", text: "second half", start: 12, end: 14 },
      { id: "after", text: "next", start: 14, end: 16 },
    ],
  };
  assert(companionText(source, track) === "first half\nsecond half");
  assert(companionText({ ...source, start: 20, end: 21 }, track) === "");
});

Deno.test("prepared transcript rejects malformed timings, languages and duplicate tracks", () => {
  const track = {
    id: "zh",
    language: "zh",
    label: "Mandarin",
    cues: [
      { id: "a", text: "你好", start: 1, end: 2 },
    ],
  };
  const bundle = { version: 1, defaultTrackId: "zh", tracks: [track] };
  assert(validTranscriptBundle(bundle));
  assert(!validTranscriptBundle(null));
  assert(!validTranscriptBundle({ ...bundle, tracks: [track, track] }));
  assert(
    !validTranscriptBundle({
      ...bundle,
      tracks: [{ ...track, language: "xx" }],
    }),
  );
  assert(
    !validTranscriptBundle({
      ...bundle,
      tracks: [{
        ...track,
        cues: [{ id: "x", text: "bad", start: 3, end: 1 }],
      }],
    }),
  );
});

Deno.test("prepared word alignment survives split captions and language switching", () => {
  const token = (text: string, groups: string[]) => ({
    text,
    groups,
    pinyin: "",
    zhuyin: "",
    kana: "",
    romaji: "",
  });
  const ja = {
    id: "j",
    text: "猫が好き",
    start: 1,
    end: 4,
    tokens: [token("猫", ["cat"]), token("が", []), token("好き", ["like"])],
  };
  const en = {
    id: "en",
    label: "English",
    language: "en" as const,
    cues: [
      {
        id: "e1",
        text: "I like",
        start: 1,
        end: 2,
        tokens: [token("I ", []), token("like", ["like"])],
      },
      {
        id: "e2",
        text: "cats",
        start: 2,
        end: 4,
        tokens: [token("cats", ["cat"])],
      },
    ],
  };
  const joined = companionTokens(companionCues(ja, en))!;
  assert(joined.map((t) => t.text).join("") === "I like\ncats");
  assert(
    joined.filter((t) => alignedWith(t, ja.tokens[0].groups)).map((t) => t.text)
      .join("") === "cats",
  );
  assert(
    ja.tokens.filter((t) => alignedWith(t, joined[1].groups)).map((t) => t.text)
      .join("") === "好き",
  );
  assert(
    companionTokens([{ id: "x", text: "plain", start: 1, end: 2 }]) === null,
  );
  const bundle = {
    version: 1,
    defaultTrackId: "ja",
    tracks: [{ id: "ja", language: "ja", label: "Japanese", cues: [ja] }, en],
  };
  assert(validTranscriptBundle(bundle));
  for (
    const tokens of [[token("changed", ["cat"])], [
      token("猫が好き", ["bad group!"]),
    ], [{ text: "猫が好き", groups: [] }]]
  ) {
    assert(
      !validTranscriptBundle({
        ...bundle,
        tracks: [{ ...bundle.tracks[0], cues: [{ ...ja, tokens }] }],
      }),
    );
  }
});
