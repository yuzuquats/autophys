import type { StudyCue, StudyToken, TranslationLanguage } from "./model";

/** Group IDs are scoped to a bundle, shared across its caption tracks. */
export type TranscriptCue = StudyCue & { tokens?: StudyToken[] };

export type TranscriptTrack = {
  id: string;
  label: string;
  language: TranslationLanguage;
  cues: TranscriptCue[];
};

export type TranscriptBundle = {
  version: 1;
  defaultTrackId: string;
  tracks: TranscriptTrack[];
  /** Optional cache, validated separately so older bundles keep working. */
  contextualDefinitions?: unknown;
};

/** Match existing subtitle lines by time, without inventing word alignment. */
export function companionText(cue: StudyCue, track: TranscriptTrack): string {
  return companionCues(cue, track).map((other) => other.text).join("\n");
}

export function companionCues(
  cue: StudyCue,
  track: TranscriptTrack,
): TranscriptCue[] {
  return track.cues.filter((other) => {
    const overlap = Math.min(cue.end, other.end) -
      Math.max(cue.start, other.start);
    return overlap > 0 &&
      overlap >= Math.min(cue.end - cue.start, other.end - other.start) / 2;
  });
}

/** Preserve line breaks and exact caption text when joining split translations. */
export function companionTokens(cues: TranscriptCue[]): StudyToken[] | null {
  if (!cues.length || cues.some((cue) => !cue.tokens)) return null;
  return cues.flatMap((cue, index) => [
    ...(index
      ? [{
        text: "\n",
        pinyin: "",
        zhuyin: "",
        kana: "",
        romaji: "",
        groups: [],
      }]
      : []),
    ...cue.tokens!,
  ]);
}

export function validCaptionTokens(
  tokens: unknown,
  text: string,
): tokens is StudyToken[] {
  return Array.isArray(tokens) && tokens.length <= 2000 &&
    tokens.every((token) =>
      token &&
      ["text", "pinyin", "zhuyin", "kana", "romaji"].every((key) =>
        typeof token[key] === "string"
      ) &&
      token.text.length > 0 && Array.isArray(token.groups) &&
      (token.timing === undefined || (
        Number.isFinite(token.timing?.start) && token.timing.start >= 0 &&
        Number.isFinite(token.timing?.end) && token.timing.end > token.timing.start
      )) &&
      token.groups.length <= 100 &&
      token.groups.every((id: unknown) =>
        typeof id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(id)
      )
    ) &&
    tokens.map((token) => token.text).join("") === text;
}

export function validTranscriptBundle(
  value: unknown,
): value is TranscriptBundle {
  const bundle = value as TranscriptBundle;
  return bundle?.version === 1 && typeof bundle.defaultTrackId === "string" &&
    Array.isArray(bundle.tracks) && bundle.tracks.length > 0 &&
    bundle.tracks.length <= 12 &&
    new Set(bundle.tracks.map((t) => t?.id)).size === bundle.tracks.length &&
    bundle.tracks.every((track) =>
      track && typeof track.id === "string" &&
      typeof track.label === "string" &&
      ["zh", "ja", "en"].includes(track.language) &&
      Array.isArray(track.cues) && track.cues.length <= 20000 &&
      track.cues.every((cue) =>
        cue && typeof cue.id === "string" &&
        // Prepared tracks can include longer on-screen notes or title cards.
        // This is independent of the online study endpoint's request limit.
        typeof cue.text === "string" && cue.text.length <= 8000 &&
        Number.isFinite(cue.start) && cue.start >= 0 &&
        Number.isFinite(cue.end) && cue.end > cue.start &&
        (cue.tokens === undefined || validCaptionTokens(cue.tokens, cue.text))
      )
    );
}
