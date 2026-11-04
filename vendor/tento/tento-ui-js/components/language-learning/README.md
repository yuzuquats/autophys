# Reusable aligned transcript

`LanguageLearningSection` displays timed subtitle dialogue, follows playback,
and retains several translations beneath each sentence. It uses the shared
Tento UI runtime and theme, with no dependency on the media app or Video.js.

The shared `std-scroll-vertical` renders a quiet, continuous subtitle stream.
The active sentence is brighter, with translations stacked underneath. A timestamp
rail on the left keeps replay buttons visible beside each sentence, using the
vertical stepper's marker/rail vocabulary. Shared `ScrollShadows` indicate content
above and below the viewport, extend to the component's outer edges, and clear
at the corresponding boundary. A
three-dot button in the transcript's corner opens language, subtitle track,
pronunciation, translation, and Follow playback options. There is no toolbar.
Translate appears on row hover or keyboard focus when annotation is needed, and
stays visible on touch devices. The menu supports Escape and outside-click dismissal.

```typescript
import { LanguageLearningSection } from "@tento-ui/components/language-learning/language-learning-section";

const section = LanguageLearningSection.makeWith({
  language: "zh",
  provider: (request, signal) => myLanguageService.study(request, signal),
  onPause: () => player.pause(),
  onReplay: (cue) => player.seekAndPlay(cue.start),
});
container.appendChild(section);
section.setTranscript(subtitleCues, "source-track-id");
section.setCurrentTime(player.currentTime);
section.setPlaying(!player.paused);
// Feed time and playback-state changes; update the transcript as more cues load.
// On a seek, call section.followPlayback() after updating the current time.
// On removal:
section.destroy();
```

Hosts can offer **Below video / Dock right** in the same menu by passing
`placement: "below" | "right"` and `onPlacementChange`. The option is absent
unless that callback is supplied. The host owns layout and preference storage;
the transcript does not move or recreate the player. Set the CSS custom property
`--language-learning-height` to fit a host-sized panel (for example `100%` in a
size-contained grid cell). The media app remembers the position locally, matches
the docked transcript to the video height, and stacks below when the available
container width is less than 900px, including narrow title sheets.
Its docked panel uses `std-round` content clipping with the video's 18px
continuous corners; below-video layouts leave the transcript edges unclipped.

Cues are `{ id, text, start, end }` with times in seconds. Their IDs must be
unique within a source. The component sorts and validates cues without guessing
sentence boundaries or merging speakers. Overlapping cues can both be active;
gaps leave the transcript visible. A different source key clears all previous
translation state. Existing rows retain their results when more cues load.
`setCue` remains a compatibility helper for a host with only one line available.

`setCompanionTranscripts([{ id, label, language, cues }])` supplies existing
subtitle translations before requesting annotation. Companion lines are matched
by overlapping time intervals, including split cues. These are parallel subtitles,
not guaranteed sentence-equivalent translations. Prepared cues may include
`tokens: StudyToken[]`, whose text must reconstruct the caption exactly. Their
`groups` IDs are scoped to the bundle and shared across all tracks. Hover, focus,
and pin work immediately in either source language without calling the provider.
Tokens and separator newlines survive joining split companion captions.
Unaligned tokens have empty groups; partial alignments are supported.
Every lexical fragment supports hover, keyboard focus and pin, even without
groups. An unlinked word highlights locally and explains the missing translation
link in its tooltip/accessibility description. No counterpart is invented.

Spoken-word underlines sit close beneath the base characters, with a brighter
current word and a continuous gradient based on character age. A smooth 2.5-second
decay reaches zero without a jump when a word finishes; neighboring ruby bases
share gradient endpoints. Translation underlines follow semantic
groups from the source; hover and pinned comparison remain independent. The
vendored Pretext runtime measures base-text widths once per font/text pair,
excluding ruby pronunciation, and is bundled locally for other app hosts.
The media adapter feeds its actual playback clock at up to 30fps while playing;
pause, buffering, playback-rate changes, and seeks use media time directly.

Prepared tokens may supply `timing: { start, end }` in absolute media seconds.
When every spoken source token has valid timing within its cue, the underline
uses those boundaries, including pauses between words. Existing Tatami/Scott
captions only have sentence timing: their word progress is **estimated** using
pronunciation/text length, not audio alignment. The source line exposes
`data-word-timing="estimated"` or `"aligned"`; caption text and sidecars are
unchanged. Pretext measures layout; it does not infer speech timing.

Prepared Pinyin and romaji appear above their base text by default, including
companion subtitles. Pinyin/Zhuyin syllables align individually to Han characters
when the syllable count matches; Japanese readings stay with the corresponding
word. Missing readings produce plain text rather than empty ruby annotations.
Pronunciation options can hide these readings or switch the source to kana or
Zhuyin. Existing prepared readings require no provider request. English subtitles
use a tighter 1.25 line-height ratio independently of the annotated CJK lines.

Bundles without tokens retain the explicit **Study words** annotation action.
Pronunciation can still be requested independently through the options menu.
The component, token schema, and scroll behavior are independent of the offline
alignment tool and media app, so another host can supply human-reviewed groups
or its own aligner.

The user chooses English, the other study language, or both. Translate requests
help for that sentence and pauses playback. Results remain visible as playback
moves on. At most two sentences request translation concurrently. Hover highlights
words while the transcript continues following the video. Manual scrolling or
keyboard focus pauses following; after four seconds without further interaction,
a playing video resumes following. Browsing stays put while playback is paused.
Playing, seeking, replaying a timestamp, or choosing Follow playback rejoins the
active line within the transcript's own scroll region. Pending resume timers are
cleared on pause, source replacement, and disposal.

The provider receives `{ text, language, targetLanguages }` and returns:

```typescript
{
  translation: "English gloss", // compatibility field
  tokens: sourceTokens,
  translations: [
    { id: "en-natural", language: "en", text: "…", tokens: englishTokens },
    { id: "ja-natural", language: "ja", text: "…", tokens: japaneseTokens },
  ],
}
```

Every token has `text`, `pinyin`, `zhuyin`, `kana`, `romaji`, and `groups`.
Inapplicable readings are empty strings. Tokens must concatenate to the exact
source or translated line text. Each translated line has a unique ID; the shape
also permits multiple variants in the same language. The media provider currently
returns one natural translation for each requested language.

`groups` contains sentence-local semantic IDs such as `person`, `wish`, or
`drink`. Group membership supports reordered words and many-to-many phrases.
For example, Chinese `想` and `喝` can have separate groups, while Japanese
`飲みたい` belongs to both. Hovering that Japanese fragment highlights the
corresponding Chinese fragments and English phrases. Highlighting uses direct
shared membership, not substring matches, token positions, or transitive closure.
Every target group must exist in the source. Unaligned punctuation can have no
groups. Machine-generated group membership requires linguistic review.

Hover and keyboard focus highlight matching fragments only within that sentence.
Click, tap, Enter, or Space pins the selection; clicking again or Escape clears it.
All text is rendered through text nodes. Malformed responses, missing requested
languages, changed source text, and unknown group references are rejected.

Optional `onLanguageChange` and `onTrackChange` callbacks let a host own track
selection. Call `setTracks([{ id, label }], selectedId)` and `setLanguage` to
reflect those choices. `setSuspended(message)` hides the transcript when the host
cannot supply a reliable clock; `setSuspended(null)` resumes it. The media adapter
uses this during casting. Destroy the section before dropping it to cancel
pending work. Providers should honor the abort signal; late responses are still
discarded if they cannot cancel their transport.

`language-learning-section.example.ts` exports
`LanguageLearningSectionStoryBook` with interactive multilingual fixtures,
reordered phrases, slow/error providers, empty state, and narrow layout.

```sh
deno test tento-ui-js/components/language-learning/model.deno.test.ts
```
