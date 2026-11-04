import type { TranscriptBundle, TranscriptCue } from "./parallel-transcript";

/** UTF-16 offsets, exclusive end. cueText binds an occurrence to its caption revision. */
export type CaptionSpan = {
  trackId: string;
  cueId: string;
  cueText: string;
  start: number;
  end: number;
  text: string;
};
export type ContextualDefinition = {
  id: string;
  source: CaptionSpan[];
  lemma: string;
  meaningHere: string;
  explanationLanguage: "en" | "ja" | "zh";
  senseRef: { dictionary: string; revision: string; id: string } | null;
  clueSpans: CaptionSpan[];
  counterparts: {
    trackId: string;
    spans: CaptionSpan[];
    relation: "equivalent" | "paraphrase" | "implicit" | "omitted" | "unresolved";
  }[];
  certainty: "supported" | "ambiguous" | "unknown";
  provenance: {
    author: string;
    baseRevision: string | null;
    adapterRevision: string | null;
    review: "draft" | "accepted" | "corrected";
  };
};
export type ContextualDefinitions = {
  version: 1;
  revision: string;
  entries: ContextualDefinition[];
};

const string = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2000;
const boundary = (text: string, offset: number) =>
  !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));

/** Reject the annotation cache independently; malformed annotations never hide subtitles. */
export function validContextualDefinitions(value: unknown, bundle: TranscriptBundle): value is ContextualDefinitions {
  const data = value as ContextualDefinitions;
  if (!data || data.version !== 1 || !string(data.revision) || !Array.isArray(data.entries) || data.entries.length > 20000) return false;
  const tracks = new Set(bundle.tracks.map(t => t.id));
  const cues = new Map<string, string>();
  for (const track of bundle.tracks) for (const cue of track.cues) {
    const key = JSON.stringify([track.id, cue.id]);
    if (cues.has(key)) return false;
    cues.set(key, cue.text);
  }
  const span = (s: CaptionSpan) => s && string(s.trackId) && string(s.cueId) && string(s.text) &&
    typeof s.cueText === "string" && cues.get(JSON.stringify([s.trackId, s.cueId])) === s.cueText &&
    Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= s.cueText.length &&
    boundary(s.cueText, s.start) && boundary(s.cueText, s.end) && s.cueText.slice(s.start, s.end) === s.text;
  const spans = (ss: CaptionSpan[]) => Array.isArray(ss) && ss.length <= 100 && ss.every(span);
  const ids = new Set<string>();
  return data.entries.every(d => {
    if (!d || !string(d.id) || ids.has(d.id)) return false;
    ids.add(d.id);
    return spans(d.source) && d.source.length > 0 && new Set(d.source.map(s => s.trackId)).size === 1 &&
      string(d.lemma) && string(d.meaningHere) && ["en", "ja", "zh"].includes(d.explanationLanguage) &&
      (d.senseRef === null || (d.senseRef && [d.senseRef.dictionary, d.senseRef.revision, d.senseRef.id].every(string))) &&
      spans(d.clueSpans) && Array.isArray(d.counterparts) && d.counterparts.length <= 12 &&
      new Set(d.counterparts.map(c => c?.trackId)).size === d.counterparts.length &&
      d.counterparts.every(c => c && tracks.has(c.trackId) && !d.source.some(s => s.trackId === c.trackId) &&
        spans(c.spans) && c.spans.every(s => s.trackId === c.trackId) &&
        (["equivalent", "paraphrase"].includes(c.relation) ? c.spans.length > 0 :
          ["implicit", "omitted", "unresolved"].includes(c.relation) && c.spans.length === 0)) &&
      ["supported", "ambiguous", "unknown"].includes(d.certainty) && Boolean(d.provenance) &&
      string(d.provenance.author) && ["draft", "accepted", "corrected"].includes(d.provenance.review) &&
      (d.provenance.baseRevision === null || string(d.provenance.baseRevision)) &&
      (d.provenance.adapterRevision === null || string(d.provenance.adapterRevision));
  });
}

export function definitionSpans(definition: ContextualDefinition): CaptionSpan[] {
  return [...definition.source, ...definition.counterparts.flatMap(c => c.spans)];
}

export function spansOverlap(a: CaptionSpan, b: CaptionSpan): boolean {
  return a.trackId === b.trackId && a.cueId === b.cueId && a.cueText === b.cueText && a.start < b.end && b.start < a.end;
}

/** Map rendered tokens across joined companion captions, excluding inserted newlines. */
export function captionSpans(trackId: string, cues: readonly TranscriptCue[], start: number, end: number): CaptionSpan[] {
  let offset = 0;
  return cues.flatMap(cue => {
    const from = Math.max(0, start - offset);
    const to = Math.min(cue.text.length, end - offset);
    offset += cue.text.length + 1;
    return to > from ? [{ trackId, cueId: cue.id, cueText: cue.text, start: from, end: to, text: cue.text.slice(from, to) }] : [];
  });
}

/** Indexed by occurrence, never by surface word or estimated alignment group. */
export class ContextualDefinitionIndex {
  private byCue = new Map<string, ContextualDefinition[]>();
  constructor(data?: ContextualDefinitions) {
    for (const definition of data?.entries ?? []) {
      const keys = new Set(definitionSpans(definition).map(s => JSON.stringify([s.trackId, s.cueId])));
      for (const key of keys) this.byCue.set(key, [...(this.byCue.get(key) ?? []), definition]);
    }
  }
  lookup(spans: readonly CaptionSpan[]): ContextualDefinition[] {
    const found = new Set<ContextualDefinition>();
    for (const span of spans) for (const definition of this.byCue.get(JSON.stringify([span.trackId, span.cueId])) ?? []) {
      if (definitionSpans(definition).some(other => spansOverlap(span, other))) found.add(definition);
    }
    return [...found];
  }
}
