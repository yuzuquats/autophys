import { captionSpans, ContextualDefinitionIndex, validContextualDefinitions } from "./contextual-definitions.ts";
import type { ContextualDefinitions } from "./contextual-definitions.ts";
import type { TranscriptBundle } from "./parallel-transcript.ts";

function assert(value: unknown): asserts value { if (!value) throw new Error("assertion failed"); }
const bundle: TranscriptBundle = { version: 1, defaultTrackId: "ja", tracks: [
  { id: "ja", language: "ja", label: "Japanese", cues: [{ id: "a", text: "同じ😀言葉", start: 1, end: 3 }, { id: "b", text: "同じ😀言葉", start: 4, end: 6 }] },
  { id: "en", language: "en", label: "English", cues: [{ id: "a", text: "same", start: 1, end: 2 }, { id: "b", text: "word", start: 2, end: 3 }] },
  { id: "zh", language: "zh", label: "Chinese", cues: [] },
] };
const ja = (id = "a") => captionSpans("ja", bundle.tracks[0].cues.filter(c => c.id === id), 0, 2)[0];
const en = () => captionSpans("en", bundle.tracks[1].cues, 5, 9)[0];
function fixture(): ContextualDefinitions { return { version: 1, revision: "test-1", entries: [{
  id: "sense-1", source: [ja()], lemma: "同じ", meaningHere: "same", explanationLanguage: "en", senseRef: null, clueSpans: [ja("b")],
  counterparts: [{ trackId: "en", spans: [en()], relation: "paraphrase" }, { trackId: "zh", spans: [], relation: "omitted" }],
  certainty: "supported", provenance: { author: "test", baseRevision: null, adapterRevision: null, review: "draft" },
}] }; }

Deno.test("context definitions use cue identity, reverse links, and no invented omissions", () => {
  const data = fixture(); assert(validContextualDefinitions(data, bundle));
  const index = new ContextualDefinitionIndex(data);
  assert(index.lookup([ja()]).length === 1);
  assert(index.lookup([en()]).length === 1);
  assert(index.lookup([ja("b")]).length === 0); // Same word in a clue is not a counterpart.
  assert(index.lookup([{ ...ja(), trackId: "zh" }]).length === 0);
  assert(index.lookup([{ ...ja(), cueText: "different caption" }]).length === 0);
});

Deno.test("joined captions preserve UTF-16 offsets and exclude synthetic newlines", () => {
  assert(en().cueId === "b" && en().start === 0 && en().text === "word");
  assert(captionSpans("en", bundle.tracks[1].cues, 4, 5).length === 0);
  const cross = captionSpans("en", bundle.tracks[1].cues, 3, 6);
  assert(cross.length === 2 && cross[0].text === "e" && cross[1].text === "w");
  const data = fixture();
  data.entries[0].source = captionSpans("ja", [bundle.tracks[0].cues[0]], 2, 4);
  assert(validContextualDefinitions(data, bundle));
  data.entries[0].source = captionSpans("ja", [bundle.tracks[0].cues[0]], 2, 3);
  assert(!validContextualDefinitions(data, bundle));
});

Deno.test("invalid or stale annotations fail closed without changing transcript data", () => {
  for (const mutation of [
    (d: ContextualDefinitions) => { d.entries[0].source[0].cueText += "!"; },
    (d: ContextualDefinitions) => { d.entries[0].source[0].end = 999; },
    (d: ContextualDefinitions) => { d.entries[0].source[0].text = "wrong"; },
    (d: ContextualDefinitions) => { d.entries[0].counterparts[0].relation = "omitted"; },
    (d: ContextualDefinitions) => { d.entries[0].counterparts[0].spans = []; },
    (d: ContextualDefinitions) => { d.entries.push(d.entries[0]); },
    (d: ContextualDefinitions) => { d.entries[0].clueSpans[0].cueId = "missing"; },
  ]) { const data = fixture(); mutation(data); assert(!validContextualDefinitions(data, bundle)); }
  for (const value of [null, {}, { version: 1, revision: "bad", entries: [null] }]) assert(!validContextualDefinitions(value, bundle));
});
