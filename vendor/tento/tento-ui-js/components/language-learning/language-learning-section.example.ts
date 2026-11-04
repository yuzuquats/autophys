import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { LanguageLearningSection } from "./language-learning-section";
import type {
  StudyLanguage,
  StudyResult,
  StudyToken,
  TranslationLanguage,
} from "./model";

function token(
  text: string,
  groups: string[],
  readings: Partial<StudyToken> = {},
): StudyToken {
  return {
    text,
    groups,
    pinyin: "",
    zhuyin: "",
    kana: "",
    romaji: "",
    ...readings,
  };
}
const zh = [
  token("你", ["person"], { pinyin: "nǐ", zhuyin: "ㄋㄧˇ" }),
  token("想", ["wish"], { pinyin: "xiǎng", zhuyin: "ㄒㄧㄤˇ" }),
  token("喝", ["drink"], { pinyin: "hē", zhuyin: "ㄏㄜ" }),
  token("什麼", ["what"], { pinyin: "shén me", zhuyin: "ㄕㄣˊ ˙ㄇㄜ" }),
  token("？", []),
];
const ja = [
  token("あなたは", ["person"], { kana: "あなたは", romaji: "anata wa" }),
  token("何を", ["what"], { kana: "なにを", romaji: "nani o" }),
  token("飲みたい", ["drink", "wish"], { kana: "のみたい", romaji: "nomitai" }),
  token("ですか", ["wish"], { kana: "ですか", romaji: "desu ka" }),
  token("？", []),
];
const en = [
  token("What", ["what"]),
  token(" would ", ["wish"]),
  token("you", ["person"]),
  token(" like to ", ["wish"]),
  token("drink", ["drink"]),
  token("?", []),
];
const mainText = (language: StudyLanguage) =>
  (language === "zh" ? zh : ja).map((part) => part.text).join("");

export class LanguageLearningSectionStoryBook extends Storybook.Default {
  title(): string {
    return "Aligned language transcript";
  }
  examples(): Storybook.Example[] {
    const make = (initial: StudyLanguage, state = "ready") => {
      let language = initial;
      const setTranscript = () => {
        const lines = language === "zh"
          ? ["我們先去散步吧。", mainText(language), "我想喝一杯茶。"]
          : ["少し歩こう。", mainText(language), "お茶を飲みたい。"];
        $section.setTranscript(
          state === "empty" ? [] : lines.map((text, i) => ({
            id: `${language}-${i}`,
            text,
            start: i * 5,
            end: i * 5 + 4,
          })),
          language,
        );
        $section.setCurrentTime(5.5);
      };
      const $section = LanguageLearningSection.makeWith({
        language,
        provider: async ({ text, language, targetLanguages }, signal) => {
          await new Promise((resolve) =>
            setTimeout(resolve, state === "slow" ? 2500 : 100)
          );
          signal.throwIfAborted();
          if (state === "error") {
            throw new Error("Example provider unavailable");
          }
          const main = text === mainText(language);
          const english = main
            ? "What would you like to drink?"
            : text.includes("茶")
            ? "I would like a cup of tea."
            : "Let's go for a walk first.";
          const chinese = text.includes("茶")
            ? "我想喝一杯茶。"
            : "我們先去散步吧。";
          const japanese = text.includes("茶")
            ? "お茶を飲みたい。"
            : "少し歩こう。";
          const choices: Record<TranslationLanguage, StudyToken[]> = main
            ? { en, zh, ja }
            : {
              en: [token(english, ["phrase"])],
              zh: [token(chinese, ["phrase"])],
              ja: [token(japanese, ["phrase"])],
            };
          const result: StudyResult = {
            translation: english,
            tokens: main ? choices[language] : [token(text, ["phrase"])],
            translations:
              (targetLanguages ?? ["en", language === "zh" ? "ja" : "zh"]).map((
                target,
              ) => ({
                id: target,
                language: target,
                text: choices[target].map((part) => part.text).join(""),
                tokens: choices[target],
              })),
          };
          return result;
        },
        onLanguageChange: (value) => {
          language = value;
          setTranscript();
        },
        onReplay: (cue) => $section.setCurrentTime(cue.start),
      });
      setTranscript();
      return $section;
    };
    return [
      {
        title: "Flowing parallel subtitles · hover definitions and spoken underline",
        render: () => {
          const $section = LanguageLearningSection.makeWith({
            language: "ja",
            provider: async () => {
              throw new Error("Prepared hover needs no provider");
            },
            onReplay: (cue) => $section.setCurrentTime(cue.start),
          });
          const tracks = ([["ja", ja], ["en", en], ["zh", zh]] as const).map((
            [language, tokens],
          ) => ({
            id: language,
            language,
            label: language,
            cues: Array.from({ length: 12 }, (_, i) => ({
              id: String(i),
              start: i * 5,
              end: i * 5 + 4,
              text: tokens.map((part) => part.text).join(""),
              tokens: tokens.map((part) => ({
                ...part,
                groups: part.groups?.map((group) => `${i}-${group}`),
              })),
            })),
          }));
          $section.setCompanionTranscripts(tracks);
          const span = (trackId: string, cueId: string, text: string) => {
            const cueText = tracks.find(track => track.id === trackId)!.cues.find(cue => cue.id === cueId)!.text;
            const start = cueText.indexOf(text);
            return { trackId, cueId, cueText, start, end: start + text.length, text };
          };
          $section.setContextualDefinitions({
            version: 1,
            revision: "storybook-drink-1",
            entries: tracks[0].cues.map(cue => ({
              id: `drink-${cue.id}`,
              source: [span("ja", cue.id, "飲みたい")],
              lemma: "飲みたい",
              meaningHere: "Want to drink. Here it asks what the listener would like to drink.",
              explanationLanguage: "en",
              senseRef: null,
              clueSpans: [],
              counterparts: [
                { trackId: "en", spans: [span("en", cue.id, "drink")], relation: "equivalent" },
                { trackId: "zh", spans: [span("zh", cue.id, "喝")], relation: "equivalent" },
              ],
              certainty: "supported",
              provenance: { author: "storybook", baseRevision: null, adapterRevision: null, review: "draft" },
            })),
          });
          $section.setTranscript(tracks[0].cues, "ja");
          $section.setCurrentTime(2.5);
          return $section;
        },
      },
      {
        title: "Mandarin → English + Japanese · reordered phrases",
        render: () => make("zh"),
      },
      { title: "Japanese → English + Mandarin", render: () => make("ja") },
      { title: "No subtitle track", render: () => make("zh", "empty") },
      {
        title: "Slow provider · switch source while waiting",
        render: () => make("ja", "slow"),
      },
      {
        title: "Unavailable provider · retry",
        render: () => make("zh", "error"),
      },
      {
        title: "Host-controlled position menu",
        render: () => {
          const $layout = document.createElement("div");
          $layout.assignStyles({ display: "grid", gap: "8px" });
          const $video = document.createElement("div");
          $video.assignStyles({
            minHeight: "280px",
            background: "var(--divider)",
            display: "grid",
            placeItems: "center",
          });
          $video.appendChild(Typography.p("Video"));
          const $section = LanguageLearningSection.makeWith({
            provider: async () => { throw new Error("Layout example"); },
            placement: "below",
            onPlacementChange: (position) => {
              $layout.style.gridTemplateColumns = position === "right"
                ? "minmax(0, 1fr) minmax(0, 1fr)"
                : "minmax(0, 1fr)";
            },
          });
          $section.style.setProperty("--language-learning-height", "280px");
          $layout.append($video, $section);
          return $layout;
        },
      },
      {
        title: "Narrow transcript",
        render: () => {
          const $section = make("zh");
          $section.style.maxWidth = "340px";
          return $section;
        },
      },
    ];
  }
}
