/** Player- and service-independent contract for subtitle study. */
export type StudyLanguage = "zh" | "ja" | "en";
export type TranslationLanguage = StudyLanguage;
export type ReadingMode = "none" | "pinyin" | "zhuyin" | "kana" | "romaji";
export type StudyCue = { id: string; text: string; start: number; end: number };
export type StudyToken = {
  text: string;
  pinyin: string;
  zhuyin: string;
  kana: string;
  romaji: string;
  /** Sentence-local semantic groups; empty for unaligned punctuation. */
  groups?: string[];
  /** Optional audio-aligned word boundaries, in absolute media seconds. */
  timing?: { start: number; end: number };
};
export type StudyTranslation = {
  id: string;
  language: TranslationLanguage;
  text: string;
  tokens: StudyToken[];
};
export type StudyResult = {
  translation: string;
  tokens: StudyToken[];
  translations?: StudyTranslation[];
};
export type StudyRequest = {
  text: string;
  language: StudyLanguage;
  targetLanguages?: TranslationLanguage[];
};
export type StudyProvider = (
  request: StudyRequest,
  signal: AbortSignal,
) => Promise<StudyResult>;
export type StudyState = {
  cue: StudyCue | null;
  language: StudyLanguage;
  result: StudyResult | null;
  loading: boolean;
  error: string | null;
  revealed: boolean;
};

export function studyLanguage(code: string): StudyLanguage | null {
  const base = code.toLowerCase().split(/[-_]/)[0];
  if (["zh", "zho", "chi", "cmn"].includes(base)) return "zh";
  if (["en", "eng"].includes(base)) return "en";
  return ["ja", "jpn"].includes(base) ? "ja" : null;
}

function validTokens(tokens: StudyToken[], text: string): boolean {
  return Array.isArray(tokens) && tokens.every((token) =>
    token &&
    ["text", "pinyin", "zhuyin", "kana", "romaji"].every((key) =>
      typeof token[key as keyof StudyToken] === "string"
    )
  ) && tokens.map((token) => token.text).join("") === text;
}

export function validResult(
  result: StudyResult,
  text: string,
  targets?: TranslationLanguage[],
): boolean {
  if (
    typeof result?.translation !== "string" || !result.translation.trim() ||
    !validTokens(result.tokens, text)
  ) return false;
  if (!result.translations) return !targets?.length;
  if (!Array.isArray(result.translations)) return false;
  const groupsValid = (token: StudyToken) =>
    Array.isArray(token.groups) &&
    token.groups.every((id) =>
      typeof id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(id)
    ) &&
    (!/[\p{L}\p{N}]/u.test(token.text) || token.groups.length > 0);
  if (!result.tokens.every(groupsValid)) return false;
  const sourceGroups = new Set(
    result.tokens.flatMap((token) => token.groups ?? []),
  );
  const ids = new Set<string>();
  for (const line of result.translations) {
    if (
      !line || typeof line.id !== "string" || !line.id || ids.has(line.id) ||
      !["en", "zh", "ja"].includes(line.language) ||
      typeof line.text !== "string" ||
      !line.text.trim() || !validTokens(line.tokens, line.text) ||
      !line.tokens.every(groupsValid) ||
      line.tokens.some((token) =>
        token.groups!.some((id) => !sourceGroups.has(id))
      )
    ) return false;
    ids.add(line.id);
  }
  return !targets ||
    targets.every((language) =>
      result.translations!.some((line) => line.language === language)
    );
}

export function alignedWith(
  token: StudyToken,
  groups: readonly string[],
): boolean {
  return Boolean(token.groups?.some((group) => groups.includes(group)));
}

/** Preserve subtitle timing and speaker boundaries rather than guessing at prose. */
export function normalizeTranscript(cues: readonly StudyCue[]): StudyCue[] {
  const unique = new Map<string, StudyCue>();
  for (const cue of cues) {
    if (
      cue.text.trim() && Number.isFinite(cue.start) &&
      Number.isFinite(cue.end) &&
      cue.start >= 0 && cue.end > cue.start
    ) unique.set(cue.id, { ...cue });
  }
  return [...unique.values()].sort((a, b) =>
    a.start - b.start || a.end - b.end
  );
}

export function activeCueIds(
  cues: readonly StudyCue[],
  seconds: number,
): string[] {
  return cues.filter((cue) => cue.start <= seconds && seconds < cue.end).map((
    cue,
  ) => cue.id);
}

/** A new cue invalidates in-flight work even when a provider ignores abort. */
export class StudySession {
  state: StudyState = {
    cue: null,
    language: "zh",
    result: null,
    loading: false,
    error: null,
    revealed: false,
  };
  private revision = 0;
  private pending: AbortController | null = null;
  private cache = new Map<string, StudyResult>();

  constructor(
    private provider: StudyProvider,
    private changed: (state: StudyState) => void,
    private targets?: TranslationLanguage[],
  ) {}

  setCue(cue: StudyCue | null, language = this.state.language): void {
    if (
      cue?.id === this.state.cue?.id && cue?.text === this.state.cue?.text &&
      language === this.state.language
    ) return;
    this.cancel();
    this.state = {
      cue,
      language,
      result: null,
      loading: false,
      error: null,
      revealed: false,
    };
    this.changed(this.state);
  }

  async request(reveal: boolean): Promise<void> {
    if (!this.state.cue) return;
    this.state.revealed ||= reveal;
    if (this.state.result || this.state.loading) {
      this.changed(this.state);
      return;
    }
    const { text } = this.state.cue;
    const language = this.state.language;
    const key = JSON.stringify([language, text]);
    const cached = this.cache.get(key);
    if (cached) {
      this.state.result = cached;
      this.changed(this.state);
      return;
    }
    this.pending = new AbortController();
    const signal = this.pending.signal;
    const revision = ++this.revision;
    this.state.loading = true;
    this.state.error = null;
    this.changed(this.state);
    try {
      const result = await this.provider({
        text,
        language,
        ...(this.targets ? { targetLanguages: this.targets } : {}),
      }, signal);
      if (revision !== this.revision) return;
      if (!validResult(result, text, this.targets)) {
        throw new Error("Invalid language response");
      }
      this.cache.set(key, result);
      if (this.cache.size > 100) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      this.state.result = result;
    } catch {
      if (revision !== this.revision) return;
      this.state.error =
        "Language help is unavailable. Try again or check the translation service settings.";
    } finally {
      if (revision === this.revision) {
        this.state.loading = false;
        this.pending = null;
        this.changed(this.state);
      }
    }
  }

  private cancel(): void {
    ++this.revision;
    this.pending?.abort();
    this.pending = null;
  }

  destroy(): void {
    this.cancel();
    this.cache.clear();
  }
}
