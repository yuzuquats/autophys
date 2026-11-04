import { studyLanguage, StudySession } from "./model.ts";
import type { StudyResult } from "./model.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const cue = { id: "1", text: "你好", start: 1, end: 3 };
const result: StudyResult = {
  translation: "Hello",
  tokens: [
    {
      text: "你好",
      pinyin: "nǐ hǎo",
      zhuyin: "ㄋㄧˇ ㄏㄠˇ",
      kana: "",
      romaji: "",
    },
  ],
};

Deno.test("new cues hide answers and cannot receive stale translations", async () => {
  let finish!: (value: StudyResult) => void;
  let signal!: AbortSignal;
  const session = new StudySession((_request, abort) => {
    signal = abort;
    return new Promise((resolve) => {
      finish = resolve;
    });
  }, () => {});
  session.setCue(cue);
  const pending = session.request(true);
  session.setCue({ ...cue, id: "2", text: "再見" });
  assert(signal.aborted);
  finish(result);
  await pending;
  assert(session.state.result === null);
  assert(!session.state.revealed && !session.state.loading);
});

Deno.test("reading help keeps English hidden; reveal reuses the request", async () => {
  let calls = 0;
  const session = new StudySession(async () => {
    calls++;
    return result;
  }, () => {});
  session.setCue(cue);
  await session.request(false);
  assert(!session.state.revealed);
  await session.request(true);
  assert(session.state.revealed && calls === 1);
  session.setCue(null);
  session.setCue({ ...cue, id: "replay" });
  await session.request(true);
  assert(calls === 1, "repeated text uses a bounded cache");
});

Deno.test("provider errors are retryable and changed source text is rejected", async () => {
  let calls = 0;
  const session = new StudySession(async () => {
    calls++;
    return calls === 1 ? { ...result, tokens: [] } : result;
  }, () => {});
  session.setCue(cue);
  await session.request(true);
  assert(session.state.error && !session.state.result);
  await session.request(true);
  assert(!session.state.error && session.state.result);
});

Deno.test("language changes invalidate requests and caches are language-specific", async () => {
  let calls = 0;
  const session = new StudySession(async () => {
    calls++;
    return result;
  }, () => {});
  session.setCue(cue, "zh");
  await session.request(true);
  session.setCue(cue, "ja");
  assert(!session.state.revealed);
  await session.request(true);
  assert(calls === 2);
});

Deno.test("destroy aborts pending work and prevents updates", async () => {
  let finish!: (value: StudyResult) => void;
  let changes = 0;
  const session = new StudySession(() =>
    new Promise((resolve) => {
      finish = resolve;
    }), () => changes++);
  session.setCue(cue);
  const pending = session.request(true);
  session.destroy();
  const before = changes;
  finish(result);
  await pending;
  assert(changes === before);
});

Deno.test("subtitle locale aliases support English without treating Cantonese as Mandarin", () => {
  for (const code of ["zh-Hant", "zh_TW", "cmn", "zho", "chi"]) {
    assert(studyLanguage(code) === "zh");
  }
  for (const code of ["ja-JP", "jpn"]) assert(studyLanguage(code) === "ja");
  for (const code of ["en", "eng", "en-US"]) assert(studyLanguage(code) === "en");
  for (const code of ["yue", "und"]) assert(studyLanguage(code) === null);
});

Deno.test("alignment follows semantic groups through reordered and many-to-many fragments", async () => {
  const { alignedWith, validResult } = await import("./model.ts");
  const make = (text: string, groups: string[]) => ({
    text,
    groups,
    pinyin: "",
    zhuyin: "",
    kana: "",
    romaji: "",
  });
  const source = [make("喝", ["drink"]), make("什麼", ["what"])];
  const aligned = {
    translation: "What to drink",
    tokens: source,
    translations: [{
      id: "en",
      language: "en" as const,
      text: "What to drink",
      tokens: [make("What", ["what"]), make(" to drink", ["drink"])],
    }],
  };
  assert(validResult(aligned, "喝什麼", ["en"]));
  assert(alignedWith(aligned.translations[0].tokens[0], ["what"]));
  assert(!alignedWith(aligned.translations[0].tokens[1], ["what"]));
  assert(alignedWith(make("飲みたい", ["drink", "wish"]), ["wish"]));
  assert(
    !validResult(aligned, "喝什麼", ["en", "ja"]),
    "missing requested language",
  );
  aligned.translations[0].tokens[0].groups = ["unknown"];
  assert(
    !validResult(aligned, "喝什麼", ["en"]),
    "unknown group must be rejected",
  );
});

Deno.test("transcript preserves overlaps, sorts cues and clears active state in gaps", async () => {
  const { normalizeTranscript, activeCueIds } = await import("./model.ts");
  const cues = normalizeTranscript([
    { id: "b", text: "second", start: 3, end: 5 },
    { id: "a", text: "first", start: 0, end: 2 },
    { id: "c", text: "overlap", start: 1, end: 2 },
    { id: "bad", text: "bad", start: 9, end: 8 },
  ]);
  assert(cues.length === 3 && cues[0].id === "a");
  assert(activeCueIds(cues, 1.5).join(",") === "a,c");
  assert(activeCueIds(cues, 2).length === 0);
  assert(activeCueIds(cues, 4).join(",") === "b");
});
