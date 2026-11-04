import "../../component-builtin";
import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Hotkeys } from "../../hotkeys";
import { companionCues, companionTokens } from "./parallel-transcript";
import { captionSpans, ContextualDefinitionIndex, definitionSpans, spansOverlap } from "./contextual-definitions";
import type { CaptionSpan, ContextualDefinitions } from "./contextual-definitions";
import type { TranscriptCue, TranscriptTrack } from "./parallel-transcript";
import { ScrollShadows } from "../../ui/scroll-shadows";
import { readingSegments } from "./readings";
import { speechTimeline, spokenStrength, spokenGradient } from "./speech-timing";
import type { SpeechTimeline, SpokenWord } from "./speech-timing";
import { spokenTextWidth } from "./spoken-text-measure";
import { Typography } from "../../ui/typography";
import "@tento-scroll/vertical/scroll-vertical";
import type { ScrollVertical } from "@tento-scroll/vertical/scroll-vertical";
import {
  activeCueIds,
  alignedWith,
  normalizeTranscript,
  StudySession,
} from "./model";
import type {
  ReadingMode,
  StudyCue,
  StudyLanguage,
  StudyProvider,
  StudyToken,
  TranslationLanguage,
} from "./model";

type TranscriptFragment = {
  key: string;
  spans: CaptionSpan[];
  $element: HTMLElement;
  token: StudyToken;
  bases: { $element: HTMLElement; from: number; to: number }[];
};
type TranscriptRow = {
  cue: TranscriptCue;
  $row: HTMLElement;
  $content: HTMLElement;
  $status: HTMLElement;
  $translate: HTMLButtonElement;
  session: Option<StudySession>;
  fragments: TranscriptFragment[];
  pinned: string[];
  pinnedKey: Option<string>;
  speech: SpeechTimeline;
  sourceFragments: TranscriptFragment[];
};
const labels = { zh: "中文", ja: "日本語", en: "English" };

@component({ name: "media-language-learning-section" })
export class LanguageLearningSection extends LonaWebComponent {
  private $scroll: ScrollVertical<HTMLElement> = this.hydrate("stream");
  private $transcript: HTMLElement = this.$scroll.$viewport;
  private $definition: HTMLElement = this.$("definition");
  private definitionAnchor: Option<{ row: TranscriptRow; fragment: TranscriptFragment; rect: DOMRect }>;
  private definitionTimer: Option<ReturnType<typeof setTimeout>>;
  private definitionEvents: Option<AbortController>;
  private $more: HTMLButtonElement = this.$("more");
  private $options: HTMLElement = this.$("options");
  private $optionGroups: HTMLElement = this.$("option-groups");
  private shadowObserver = new ResizeObserver(() => this.updateShadows());
  private scrollReady = false;
  private scrollInitialized = false;
  private measured = new Map<string, number>();
  private rowObserver = new ResizeObserver((entries) => {
    let resized = false;
    for (const entry of entries) {
      const $row = entry.target as HTMLElement;
      this.measureSpokenText($row);
      const id = $row.dataset.cueId!;
      const height = Math.ceil($row.getBoundingClientRect().height);
      if (!height || this.measured.get(id) === height) continue;
      this.measured.set(id, height);
      const index = this.cues.findIndex((cue) => cue.id === id);
      if (index >= 0 && this.scrollReady) {
        this.$scroll.invalidateHeight(index, !this.following);
        resized = true;
      }
    }
    // This finite transcript already owns its earlier rows. Keep the native
    // scroll range after resize anchoring instead of exposing the chat banner.
    if (resized && !this.following) this.$scroll.renormalize();
    // Translations change row heights after the initial scroll, even while paused.
    if (resized && this.following) this.scheduleFollow();
    if (resized) this.updateShadows();
  });
  private $empty: HTMLElement = this.$("empty");
  private $status: HTMLElement = this.$("status");
  private $language: HTMLSelectElement = this.$("language");
  private $reading: HTMLSelectElement = this.$("reading");
  private $targets: HTMLSelectElement = this.$("targets");
  private $track: HTMLSelectElement = this.$("track");
  private $placement: HTMLSelectElement = this.$("placement");
  private $follow: HTMLButtonElement = this.$("follow");
  private props: Option<LanguageLearningSection.Props>;
  private rows = new Map<string, TranscriptRow>();
  private cues: StudyCue[] = [];
  private companionTracks: TranscriptTrack[] = [];
  private definitions = new ContextualDefinitionIndex();
  private active: string[] = [];
  private sourceKey = "";
  private language: StudyLanguage = "zh";
  private reading: ReadingMode = "none";
  private targets: TranslationLanguage[] = ["en", "ja"];
  private seconds = 0;
  private following = true;
  private playing = false;
  private browseTimer: Option<ReturnType<typeof setTimeout>>;
  private emptyMessage = "Choose a subtitle track to see the transcript.";
  private suspended: Option<string>;
  private listenersBound = false;
  private followFrame: Option<number>;

  static makeWith(
    props: LanguageLearningSection.Props,
  ): LanguageLearningSection {
    return (LanguageLearningSection.make() as LanguageLearningSection).bind(
      props,
    );
  }

  bind(props: LanguageLearningSection.Props): this {
    this.destroy();
    this.companionTracks = [];
    this.definitions = new ContextualDefinitionIndex();
    this.props = props;
    this.$placement.value = props.placement ?? "below";
    this.suspended = null;
    this.following = true;
    this.seconds = 0;
    this.emptyMessage = "Choose a subtitle track to see the transcript.";
    this.setLanguage(props.language ?? "zh");
    this.setTracks([], "");
    this.mountScroll();
    this.shadowObserver.observe(this.$transcript);
    this.definitionEvents = new AbortController();
    const signal = this.definitionEvents.signal;
    // Top-layer tooltips must not remain behind when their virtualized row moves.
    document.addEventListener("scroll", (event) => {
      if (!event.composedPath().includes(this.$definition)) this.hideMovedDefinition();
    }, { capture: true, passive: true, signal });
    window.addEventListener("resize", () => this.hideDefinition(), { signal });
    document.addEventListener("pointerdown", (event) => {
      const anchor = this.definitionAnchor;
      if (anchor && !event.composedPath().some($element =>
        $element === this.$definition || $element === anchor.fragment.$element)) {
        this.hideDefinition(true);
      }
    }, { capture: true, signal });
    if (!this.listenersBound) {
      this.listenersBound = true;
      this.$definition.addEventListener("pointerenter", () => this.clearDefinitionTimer());
      this.$definition.addEventListener("pointerleave", () => this.deferHideDefinition());
      this.$transcript.addEventListener("scroll", () => {
        this.hideMovedDefinition();
        this.updateShadows();
      }, {
        passive: true,
      });
      this.action(this.$more, () => {
        if (this.$options.matches(":popover-open")) this.$options.hidePopover();
        else {
          this.paintOptions();
          this.$options.showPopover();
          const rect = this.$more.getBoundingClientRect();
          const width = this.$options.offsetWidth;
          const height = this.$options.offsetHeight;
          this.$options.style.left = `${
            Math.max(12, Math.min(rect.right - width, innerWidth - width - 12))
          }px`;
          this.$options.style.top = `${
            Math.max(12, Math.min(rect.bottom + 8, innerHeight - height - 12))
          }px`;
          this.$options.querySelector<HTMLButtonElement>("button")?.focus();
        }
      });
      this.$options.addEventListener(
        "toggle",
        () => {
          const open = this.$options.matches(":popover-open");
          Hotkeys.clearEscapeHandler(this.$options);
          if (open) {
            Hotkeys.pushEscapeHandler(this.$options, () => {
              this.$options.hidePopover();
              this.$more.focus();
            });
          }
          this.$more.setAttribute(
            "aria-expanded",
            String(open),
          );
        },
      );
      this.$options.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          Hotkeys.clearEscapeHandler(this.$options);
          this.$options.hidePopover();
          this.$more.focus();
        }
      });
      this.$language.addEventListener("change", () => {
        this.setLanguage(this.$language.value as StudyLanguage);
        this.props?.onLanguageChange?.(this.language);
      });
      this.$placement.addEventListener("change", () => {
        this.props?.onPlacementChange?.(
          this.$placement.value as LanguageLearningSection.Placement,
        );
        this.$options.hidePopover();
        this.$more.focus();
      });
      this.$track.addEventListener(
        "change",
        () => this.props?.onTrackChange?.(this.$track.value),
      );
      this.$targets.addEventListener("change", () => {
        this.targets = this.$targets.value === "both"
          ? this.defaultTargets()
          : [this.$targets.value as TranslationLanguage];
        for (const row of this.rows.values()) {
          row.session?.destroy();
          row.session = null;
          row.pinned = [];
          row.pinnedKey = null;
          this.paintRow(row);
        }
      });
      this.$reading.addEventListener("change", () => {
        this.reading = this.$reading.value as ReadingMode;
        for (const row of this.rows.values()) this.paintRow(row);
        const current = this.rows.get(this.active[0]);
        if (
          current && this.reading !== "none" &&
          !current.cue.tokens?.some((token) =>
            token[this.reading as Exclude<ReadingMode, "none">]
          )
        ) {
          this.request(current, false);
        }
      });
      this.action(this.$follow, () => {
        this.followPlayback();
        this.$options.hidePopover();
      });
      const browse = () => this.browseTranscript();
      this.$transcript.addEventListener("wheel", browse, { passive: true });
      this.$transcript.addEventListener("touchstart", browse, {
        passive: true,
      });
      this.$transcript.addEventListener("touchmove", browse, { passive: true });
      this.$transcript.addEventListener("pointerdown", browse);
      this.$transcript.addEventListener("keydown", (event) => {
        if (
          ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", "Tab"]
            .includes(event.key)
        ) browse();
        if (event.key === "Escape") {
          for (const row of this.rows.values()) {
            row.pinned = [];
            row.pinnedKey = null;
            this.highlight(row, []);
            this.paintDefinition(row);
          }
        }
      });
    }
    this.paintStatus();
    return this;
  }

  private action($element: HTMLElement, callback: () => void): void {
    const run = () => {
      if (!$element.hasAttribute("disabled") && !this.suspended) callback();
    };
    GESTURE_MANAGER.addPointerEvent($element, { onClick: run });
    $element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        run();
      }
    });
  }

  /** Accept a validated annotation cache; the reusable component owns no media API. */
  setContextualDefinitions(data?: ContextualDefinitions): void {
    this.definitions = new ContextualDefinitionIndex(data);
    for (const row of this.rows.values()) this.paintRow(row);
  }

  setTranscript(
    cues: readonly TranscriptCue[],
    sourceKey = this.sourceKey,
  ): void {
    const normalized = normalizeTranscript(cues) as TranscriptCue[];
    const sourceChanged = sourceKey !== this.sourceKey;
    if (sourceChanged) this.clearTranscript();
    this.sourceKey = sourceKey;
    const same = normalized.length === this.cues.length &&
      normalized.every((cue, i) => {
        const previous = this.cues[i];
        return cue.id === previous.id && cue.text === previous.text &&
          cue.start === previous.start && cue.end === previous.end &&
          cue.tokens === (previous as TranscriptCue).tokens;
      });
    if (same) return;
    const keep = new Set(normalized.map((cue) => cue.id));
    for (const [id, row] of this.rows) {
      if (!keep.has(id)) {
        row.session?.destroy();
        row.$row.remove();
        this.rows.delete(id);
      }
    }
    for (const cue of normalized) {
      let row = this.rows.get(cue.id);
      if (row && JSON.stringify(row.cue) !== JSON.stringify(cue)) {
        row.session?.destroy();
        row.$row.remove();
        this.rows.delete(cue.id);
        row = undefined;
      }
      if (!row) {
        row = this.makeRow(cue);
        this.rows.set(cue.id, row);
      }
    }
    this.cues = normalized;
    for (const [index, cue] of normalized.entries()) {
      this.rows.get(cue.id)!.$row.toggleAttribute(
        "data-last",
        index === normalized.length - 1,
      );
    }
    if (this.scrollReady) {
      this.$scroll.updateMaxIndex(Math.max(0, this.cues.length - 1));
      this.$scroll.scrollEngine.bindIndex(
        Math.max(0, this.cues.findIndex((cue) => cue.id === this.active[0])),
        sourceChanged
          ? {
            kind: "reanchor",
            at: { position: "start", useNativeScrollTo: true, scrollBehavior: "instant" },
            viewportChangeSource: "bind",
          }
          : { kind: "refresh", viewportChangeSource: "bind" },
      );
      this.$scroll.invalidateHeight(0, !this.following);
    }
    this.active = [];
    this.setCurrentTime(this.seconds);
    this.paintStatus();
    this.scheduleFollow();
  }

  /** Compatibility for hosts that provide only one active line. */
  setCue(cue: Option<StudyCue>): void {
    this.setTranscript(cue ? [cue] : []);
    if (cue) this.setCurrentTime(cue.start);
  }

  /** Existing translations, independently timed; available before AI annotation. */
  setCompanionTranscripts(tracks: TranscriptTrack[]): void {
    this.companionTracks = tracks;
    for (const row of this.rows.values()) this.paintRow(row);
  }

  setCurrentTime(seconds: number): void {
    this.seconds = seconds;
    this.paintSpeech();
    const next = this.suspended ? [] : activeCueIds(this.cues, seconds);
    if (next.join("\0") === this.active.join("\0")) return;
    for (const id of this.active) {
      const $row = this.rows.get(id)?.$row;
      $row?.classList.remove("active");
      $row?.removeAttribute("aria-current");
    }
    this.active = next;
    for (const id of next) {
      const $row = this.rows.get(id)!.$row;
      $row.classList.add("active");
      $row.setAttribute("aria-current", "true");
    }
    if (this.following) this.followActive();
  }

  /** Hosts feed playback state as well as time; resuming playback rejoins it. */
  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (playing) this.followPlayback();
    else this.clearBrowseTimer();
  }

  followPlayback(): void {
    this.clearBrowseTimer();
    this.following = true;
    this.paintStatus();
    this.followActive();
  }

  private clearBrowseTimer(): void {
    if (this.browseTimer != null) clearTimeout(this.browseTimer);
    this.browseTimer = null;
  }

  private browseTranscript(): void {
    this.clearBrowseTimer();
    this.following = false;
    this.paintStatus();
    if (this.playing) {
      this.browseTimer = setTimeout(() => {
        this.browseTimer = null;
        if (this.isConnected && this.playing) this.followPlayback();
      }, 4000);
    }
  }

  private defaultTargets(): TranslationLanguage[] {
    return this.language === "en" ? ["ja", "zh"] : ["en", this.language === "zh" ? "ja" : "zh"];
  }

  setLanguage(language: StudyLanguage): void {
    this.language = language;
    this.$language.value = language;
    this.reading = language === "en" ? "none" : language === "zh" ? "pinyin" : "romaji";
    this.targets = this.defaultTargets();
    this.clearTranscript();
    this.options(
      this.$reading,
      language === "en" ? [["none", "Text"]] : language === "zh"
        ? [["none", "Characters"], ["pinyin", "Pinyin"], [
          "zhuyin",
          "Zhuyin 注音",
        ]]
        : [["none", "Characters"], ["kana", "Kana かな"], ["romaji", "Romaji"]],
    );
    this.$reading.value = this.reading;
    this.options(this.$targets, language === "en" ? [
      ["both", "Japanese + Mandarin"], ["ja", "Japanese"], ["zh", "Mandarin"],
    ] : [
      ["both", language === "zh" ? "English + Japanese" : "English + Mandarin"],
      ["en", "English"],
      [
        language === "zh" ? "ja" : "zh",
        language === "zh" ? "Japanese" : "Mandarin",
      ],
    ]);
    this.paintStatus();
  }

  private options($select: HTMLSelectElement, choices: string[][]): void {
    $select.replaceChildren();
    for (const [value, label] of choices) {
      const $option = document.createElement("option");
      $option.value = value;
      $option.textContent = label;
      $select.appendChild($option);
    }
  }

  setTracks(tracks: LanguageLearningSection.Track[], selected: string): void {
    // Avoid rebuilding the dropdown on every TextTrackList change event.
    const signature = JSON.stringify(tracks);
    if (this.$track.dataset.signature !== signature) {
      this.options(this.$track, [
        ["", "Select subtitles…"],
        ...tracks.map((track) => [track.id, track.label]),
      ]);
      this.$track.dataset.signature = signature;
    }
    this.$track.value = selected;
    this.$track.hidden = !this.props?.onTrackChange;
    this.paintStatus();
  }

  setSuspended(message: Option<string>): void {
    if (this.suspended === message) return;
    this.suspended = message;
    this.setCurrentTime(this.seconds);
    this.paintStatus();
  }

  setEmptyMessage(message: string): void {
    if (this.emptyMessage === message) return;
    this.emptyMessage = message;
    this.paintStatus();
  }

  private makeRow(cue: TranscriptCue): TranscriptRow {
    const $row = document.createElement("article");
    $row.className = "sentence";
    $row.dataset.cueId = cue.id;
    const $head = document.createElement("std-row");
    $head.className = "sentence-head";
    const $time = document.createElement("button");
    $time.type = "button";
    $time.className = "timestamp";
    $time.textContent = `${Math.floor(cue.start / 60)}:${
      String(Math.floor(cue.start % 60)).padStart(2, "0")
    }`;
    $time.setAttribute("aria-label", `Replay sentence at ${$time.textContent}`);
    $time.disabled = !this.props?.onReplay;
    const $marker = document.createElement("span");
    $marker.className = "timeline-marker";
    $marker.setAttribute("aria-hidden", "true");
    this.action($time, () => {
      this.props?.onReplay?.(cue);
    });
    const $translate = document.createElement("button");
    $translate.type = "button";
    $translate.className = "translate";
    const $content = document.createElement("div");
    $content.className = "sentence-content";
    const $status = document.createElement("div");
    $status.className = "sentence-status";
    $status.setAttribute("role", "status");
    const row: TranscriptRow = {
      cue,
      $row,
      $content,
      $status,
      $translate,
      session: null,
      fragments: [],
      pinned: [],
      pinnedKey: null,
      speech: { words: [], estimated: true },
      sourceFragments: [],
    };
    this.action($translate, () => this.request(row, true));
    $head.append($translate);
    $row.append($time, $marker, $content, $head, $status);
    this.paintRow(row);
    return row;
  }

  private request(row: TranscriptRow, reveal: boolean): void {
    if (!this.props || this.suspended || row.session?.state.loading) return;
    if (
      [...this.rows.values()].filter((entry) => entry.session?.state.loading)
        .length >= 2
    ) {
      row.$status.replaceChildren(
        Typography.p("Two lines are translating. Try this one in a moment."),
      );
      return;
    }
    this.following = false;
    this.props.onPause?.();
    this.paintStatus();
    if (!row.session) {
      row.session = new StudySession(
        this.props.provider,
        () => this.paintRow(row),
        this.targets,
      );
      row.session.setCue(row.cue, this.language);
    }
    void row.session.request(reveal);
  }

  private paintRow(row: TranscriptRow): void {
    if (this.definitionAnchor?.row === row) this.hideDefinition();
    const state = row.session?.state;
    const result = state?.result;
    row.fragments = [];
    row.sourceFragments = [];
    row.$content.replaceChildren();
    const line = (
      language: TranslationLanguage,
      tokens: Option<StudyToken[]>,
      text: string,
      source: boolean,
      origin?: { trackId: string; cues: TranscriptCue[] },
    ) => {
      const $line = document.createElement("div");
      $line.className = source ? "source-line" : "translation-line";
      const reading: ReadingMode = language === "en" || this.reading === "none"
        ? "none"
        : source
        ? this.reading
        : language === "zh"
        ? "pinyin"
        : "romaji";
      $line.classList.toggle(
        "with-reading",
        reading !== "none" && Boolean(tokens?.some((token) => token[reading])),
      );
      const $text = Typography.p("");
      $text.className = "sentence-text";
      $text.lang = language;
      const parts: StudyToken[] = tokens ?? [...new Intl.Segmenter(language, { granularity: "word" }).segment(text)]
        .map(({ segment }) => ({ text: segment, pinyin: "", zhuyin: "", kana: "", romaji: "" }));
      let captionOffset = 0;
      for (const [index, token] of parts.entries()) {
          const key = `${language}:${source}:${index}:${token.text}`;
          const spans = origin ? captionSpans(origin.trackId, origin.cues, captionOffset, captionOffset + token.text.length) : [];
          captionOffset += token.text.length;
          const groups = token.groups ?? [];
          const $fragment = document.createElement("span");
          $fragment.className = "fragment";
          const bases: TranscriptFragment["bases"] = [];
          let offset = 0;
          for (const segment of readingSegments(token, language, reading)) {
            const $base = document.createElement("span");
            $base.className = "spoken-base";
            $base.textContent = segment.text;
            bases.push({ $element: $base, from: offset / token.text.length, to: (offset + segment.text.length) / token.text.length });
            offset += segment.text.length;
            if (!segment.reading) {
              $fragment.appendChild($base);
              continue;
            }
            const $ruby = document.createElement("ruby");
            $ruby.classList.toggle(
              "short-reading",
              [...segment.text].length <= 6 && segment.reading.length <= 24,
            );
            $ruby.appendChild($base);
            const $reading = document.createElement("rt");
            $reading.className = "text";
            $reading.textContent = segment.reading;
            $ruby.appendChild($reading);
            $fragment.appendChild($ruby);
          }
          if (groups.length || /[\p{L}\p{N}]/u.test(token.text)) {
            $fragment.tabIndex = 0;
            $fragment.setAttribute("role", "button");
            $fragment.setAttribute(
              "aria-label",
              groups.length ? `Highlight translations of ${token.text.trim()}` : `Select ${token.text.trim()}`,
            );
            $fragment.dataset.alignment = groups.length ? "linked" : "unlinked";
            if (this.definitions.lookup(spans).length) {
              $fragment.dataset.hasDefinition = "true";
              $fragment.setAttribute("aria-description", "Show the meaning in this sentence.");
            } else if (!groups.length) {
              $fragment.title = "No aligned translation available for this word yet.";
              $fragment.setAttribute("aria-description", $fragment.title);
            }
            $fragment.addEventListener("pointerenter", () => {
              this.highlight(row, groups, key);
              this.paintDefinition(row, key);
            });
            $fragment.addEventListener("pointerleave", () => {
              this.deferHideDefinition();
              if (!this.definitionAnchor) this.highlight(row, row.pinned);
            });
            $fragment.addEventListener("focus", () => {
              this.browseTranscript();
              this.highlight(row, groups, key);
              this.paintDefinition(row, key);
            });
            $fragment.addEventListener("blur", () => {
              this.deferHideDefinition();
              if (!this.definitionAnchor) this.highlight(row, row.pinned);
            });
            $fragment.addEventListener("keydown", (event) => {
              if (event.key === "Escape" && this.definitionAnchor) {
                event.preventDefault();
                event.stopPropagation();
                this.hideDefinition(true);
              }
            });
            this.action($fragment, () => {
              const unpin = row.pinnedKey === key;
              row.pinned = unpin ? [] : [...groups];
              row.pinnedKey = unpin ? null : key;
              this.highlight(row, row.pinned);
              this.paintDefinition(row);
            });
          }
          const fragment = { key, spans, $element: $fragment, token, bases };
          row.fragments.push(fragment);
          if (source) row.sourceFragments.push(fragment);
          $text.appendChild($fragment);
        }
      if (source) {
        row.speech = speechTimeline(row.cue, parts);
        $line.dataset.wordTiming = row.speech.estimated ? "estimated" : "aligned";
      }
      $line.setAttribute(
        "aria-label",
        source ? "Original subtitle" : labels[language],
      );
      $line.append($text);
      row.$content.appendChild($line);
    };
    line(this.language, result?.tokens ?? row.cue.tokens, row.cue.text, true, { trackId: this.sourceKey, cues: [row.cue] });
    if (state?.revealed && result) {
      if (result.translations) {
        for (const translation of result.translations) {
          line(
            translation.language,
            translation.tokens,
            translation.text,
            false,
          );
        }
      } else line("en", null, result.translation, false);
    } else {
      for (const target of this.targets) {
        const track = this.companionTracks.find((track) =>
          track.language === target
        );
        if (!track || track.language === this.language) continue;
        const cues = companionCues(row.cue, track);
        const text = cues.map((cue) => cue.text).join("\n");
        if (text) line(track.language, companionTokens(cues), text, false, { trackId: track.id, cues });
      }
    }
    row.$translate.hidden = Boolean(state?.revealed && result) ||
      Boolean(row.cue.tokens && !state?.loading && !state?.error);
    row.$translate.disabled = Boolean(state?.loading);
    row.$translate.textContent = state?.loading
      ? "Translating…"
      : state?.error
      ? "Retry"
      : state?.revealed && result
      ? "Translated"
      : this.companionTracks.length
      ? "Study words"
      : "Translate";
    row.$status.replaceChildren();
    if (state?.error) row.$status.appendChild(Typography.p(state.error));
    this.highlight(row, row.pinned);
    if (row.$row.isConnected) {
      this.measureSpokenText(row.$row);
      this.paintRowSpeech(row);
    }
  }

  private measureSpokenText($row: HTMLElement): void {
    for (const $text of $row.querySelectorAll<HTMLElement>(".sentence-text")) {
      const style = getComputedStyle($text);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      for (const $base of $text.querySelectorAll<HTMLElement>(".spoken-base")) {
        $base.style.setProperty("--spoken-width", `${spokenTextWidth($base.textContent ?? "", font)}px`);
      }
    }
  }

  private paintSpeech(): void {
    for (const row of this.rows.values()) {
      if (row.$row.isConnected) this.paintRowSpeech(row);
    }
  }

  private paintRowSpeech(row: TranscriptRow): void {
    const words = new Map<HTMLElement, SpokenWord>();
    const groups = new Map<string, SpokenWord>();
    for (const word of row.speech.words) {
      const fragment = row.sourceFragments[word.index];
      if (!fragment) continue;
      words.set(fragment.$element, word);
      for (const group of fragment.token.groups ?? []) {
        if (this.seconds >= word.start && (groups.get(group)?.end ?? -1) < word.end) {
          groups.set(group, word);
        }
      }
    }
    for (const { $element, token, bases } of row.fragments) {
      const word = words.get($element) ?? (token.groups ?? []).map((group) => groups.get(group))
        .filter((word): word is SpokenWord => Boolean(word)).sort((a, b) => b.end - a.end)[0];
      const value = word && !this.suspended ? spokenStrength(word, this.seconds) : 0;
      const state = word && !this.suspended && this.seconds >= word.start && this.seconds < word.end
        ? "current" : value > 0 ? "past" : "future";
      if ($element.dataset.spoken !== state) $element.dataset.spoken = state;
      const opacity = value.toFixed(3);
      if ($element.style.getPropertyValue("--spoken-strength") !== opacity) {
        $element.style.setProperty("--spoken-strength", opacity);
      }
      for (const base of bases) {
        const gradient = word && !this.suspended
          ? spokenGradient(word, this.seconds, base.from, base.to) : [0, 0];
        for (const [index, name] of ["--spoken-start", "--spoken-end"].entries()) {
          const opacity = gradient[index].toFixed(3);
          if (base.$element.style.getPropertyValue(name) !== opacity) base.$element.style.setProperty(name, opacity);
        }
      }
    }
  }

  private clearDefinitionTimer(): void {
    if (this.definitionTimer != null) clearTimeout(this.definitionTimer);
    this.definitionTimer = null;
  }

  private deferHideDefinition(): void {
    this.clearDefinitionTimer();
    const anchor = this.definitionAnchor;
    if (!anchor || anchor.row.pinnedKey === anchor.fragment.key ||
      anchor.fragment.$element.matches(":focus-visible")) return;
    // Leave enough time to move the pointer from the word into its tooltip.
    this.definitionTimer = setTimeout(() => this.hideDefinition(), 140);
  }

  private hideMovedDefinition(): void {
    const anchor = this.definitionAnchor;
    if (!anchor) return;
    const rect = anchor.fragment.$element.getBoundingClientRect();
    // The scroll engine also emits scroll events while settling the same offset.
    if (!anchor.fragment.$element.isConnected ||
      Math.abs(rect.top - anchor.rect.top) > 1 || Math.abs(rect.left - anchor.rect.left) > 1) {
      this.hideDefinition();
    }
  }

  private hideDefinition(clearSelection = false): void {
    this.clearDefinitionTimer();
    const anchor = this.definitionAnchor;
    this.definitionAnchor = null;
    anchor?.fragment.$element.removeAttribute("aria-describedby");
    if (this.$definition.matches(":popover-open")) this.$definition.hidePopover();
    Hotkeys.clearEscapeHandler(this.$definition);
    if (anchor) {
      if (clearSelection) {
        anchor.row.pinned = [];
        anchor.row.pinnedKey = null;
      }
      this.highlight(anchor.row, anchor.row.pinned);
    }
  }

  private paintDefinition(row: TranscriptRow, key = row.pinnedKey): void {
    this.hideDefinition();
    const fragment = row.fragments.find(fragment => fragment.key === key);
    if (!fragment || !fragment.$element.isConnected) return;
    this.highlight(row, fragment.token.groups ?? [], key);
    const definitions = this.definitions.lookup(fragment.spans);
    if (!definitions.length && key !== row.pinnedKey) return;
    this.$definition.replaceChildren();
    for (const definition of definitions) {
      const $entry = document.createElement("div");
      $entry.dataset.definitionId = definition.id;
      const $label = Typography.p(`${definition.lemma} · Meaning here${definition.provenance.review === "draft" ? " · Draft" : ""}${definition.certainty !== "supported" ? " · Uncertain" : ""}`);
      $label.className = "definition-label";
      const $meaning = Typography.p(definition.meaningHere);
      $meaning.lang = definition.explanationLanguage;
      $entry.append($label, $meaning);
      this.$definition.append($entry);
    }
    if (!definitions.length) {
      this.$definition.append(Typography.p("No contextual definition for this word yet."));
    }
    const rect = fragment.$element.getBoundingClientRect();
    this.definitionAnchor = { row, fragment, rect };
    fragment.$element.setAttribute("aria-describedby", "definition");
    this.highlight(row, fragment.token.groups ?? [], key);
    this.$definition.showPopover();
    const width = this.$definition.offsetWidth;
    const height = this.$definition.offsetHeight;
    this.$definition.style.left = `${Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, innerWidth - width - 12))}px`;
    const top = rect.top - height - 8;
    this.$definition.style.top = `${Math.max(12, Math.min(top >= 12 ? top : rect.bottom + 8, innerHeight - height - 12))}px`;
    Hotkeys.pushEscapeHandler(this.$definition, () => this.hideDefinition(true));
  }

  private highlight(row: TranscriptRow, groups: string[], selectedKey = row.pinnedKey): void {
    const spansFor = (key: Option<string>) => this.definitions.lookup(row.fragments.find(f => f.key === key)?.spans ?? []).flatMap(definitionSpans);
    const selectedSpans = spansFor(selectedKey);
    const pinnedSpans = spansFor(row.pinnedKey);
    for (const { key, spans, $element, token } of row.fragments) {
      $element.classList.toggle("aligned", key === selectedKey || (selectedSpans.length
        ? spans.some(s => selectedSpans.some(other => spansOverlap(s, other))) : alignedWith(token, groups)));
      if ($element.hasAttribute("role")) {
        $element.setAttribute(
          "aria-pressed",
          String(key === row.pinnedKey || (pinnedSpans.length
            ? spans.some(s => pinnedSpans.some(other => spansOverlap(s, other))) : alignedWith(token, row.pinned))),
        );
      }
    }
  }

  private mountScroll(): void {
    if (this.scrollInitialized) return;
    this.scrollInitialized = true;
    this.$transcript.setAttribute("role", "region");
    this.$transcript.setAttribute("aria-label", "Subtitle transcript");
    this.$transcript.tabIndex = 0;
    this.$scroll.initialize({
      onCreate: () => {
        const $cell = document.createElement("div");
        $cell.className = "transcript-cell";
        return $cell;
      },
      onBind: ($cell, index) => {
        const cue = this.cues[index];
        const row = cue && this.rows.get(cue.id);
        if (!row) {
          $cell.replaceChildren();
          return;
        }
        if ($cell.firstElementChild !== row.$row) {
          if ($cell.firstElementChild) {
            this.rowObserver.unobserve($cell.firstElementChild);
          }
          $cell.replaceChildren(row.$row);
        }
        this.rowObserver.observe(row.$row);
        this.paintRowSpeech(row);
      },
      onRecycle: ($cell) => {
        if (this.definitionAnchor && $cell.contains(this.definitionAnchor.fragment.$element)) {
          this.hideDefinition();
        }
        if ($cell.firstElementChild) {
          this.rowObserver.unobserve($cell.firstElementChild);
        }
        $cell.replaceChildren();
      },
      options: {
        cellWidthForIndex: (index) =>
          this.measured.get(this.cues[index]?.id) ?? null,
      },
    });
    void this.$scroll.bind({
      cellHeightPx: 112,
      minIndex: 0,
      maxIndex: Math.max(0, this.cues.length - 1),
    }).then(() => {
      this.scrollReady = true;
      this.$scroll.updateMaxIndex(Math.max(0, this.cues.length - 1));
      this.$scroll.invalidateHeight(0, false);
      this.updateShadows();
      if (this.following) this.followActive();
    });
  }

  private updateShadows(): void {
    ScrollShadows.updateScrollShadows(this, this.$transcript);
  }

  private scheduleFollow(): void {
    if (this.followFrame != null) cancelAnimationFrame(this.followFrame);
    this.followFrame = requestAnimationFrame(() => {
      this.followFrame = null;
      if (this.isConnected && this.following) this.followActive();
    });
  }

  private followActive(): void {
    if (!this.scrollReady || this.suspended || !this.active.length) return;
    const index = this.cues.findIndex((cue) => cue.id === this.active[0]);
    if (index >= 0) {
      this.$scroll.scrollEngine.bindIndex(index, {
        kind: "reveal",
        at: {
          // A long sentence on a narrow screen must keep its opening line visible.
          position: (this.measured.get(this.active[0]) ?? 112) >
              this.$transcript.clientHeight
            ? "start"
            : "center",
          scrollBehavior: "instant",
          useNativeScrollTo: true,
        },
        viewportChangeSource: "navigator",
      });
    }
  }

  private paintOptions(): void {
    this.$optionGroups.replaceChildren();
    for (
      const [title, $select] of [
        ["Position", this.$placement],
        ["Language", this.$language],
        ["Subtitles", this.$track],
        ["Pronunciation", this.$reading],
        ["Translate into", this.$targets],
      ] as const
    ) {
      if ($select === this.$placement && !this.props?.onPlacementChange) continue;
      if ($select === this.$track && $select.hidden) continue;
      const $group = document.createElement("div");
      $group.className = "option-group";
      $group.setAttribute("role", "group");
      $group.setAttribute("aria-label", title);
      const $title = Typography.p(title);
      $title.className = "option-label";
      $group.appendChild($title);
      const $choices = document.createElement("std-row");
      $choices.className = "option-choices";
      for (const option of $select.options) {
        const $button = document.createElement("button");
        $button.type = "button";
        $button.textContent = option.textContent;
        $button.setAttribute(
          "aria-pressed",
          String(option.value === $select.value),
        );
        $button.disabled = $select.disabled;
        this.action($button, () => {
          const index = [...$select.options].indexOf(option);
          $select.value = option.value;
          $select.dispatchEvent(new Event("change"));
          if ($select === this.$placement) return;
          this.paintOptions();
          const $nextGroup = [...this.$optionGroups.children].find(($group) =>
            $group.getAttribute("aria-label") === title
          );
          $nextGroup?.querySelectorAll<HTMLButtonElement>("button")[index]
            ?.focus();
        });
        $choices.appendChild($button);
      }
      $group.appendChild($choices);
      this.$optionGroups.appendChild($group);
    }
  }

  private paintStatus(): void {
    this.$empty.hidden = this.cues.length > 0 && !this.suspended;
    this.$empty.replaceChildren(
      Typography.p(this.suspended ?? this.emptyMessage),
    );
    this.$scroll.hidden = !this.cues.length || Boolean(this.suspended);
    this.$more.disabled = Boolean(this.suspended);
    this.$language.disabled = Boolean(this.suspended);
    this.$reading.disabled = Boolean(this.suspended);
    this.$targets.disabled = Boolean(this.suspended);
    this.$track.disabled = Boolean(this.suspended) ||
      this.$track.options.length <= 1;
    this.$follow.disabled = !this.cues.length || Boolean(this.suspended);
    this.$follow.hidden = this.following || !this.cues.length;
    this.$follow.textContent = "Follow playback";
    this.$follow.setAttribute("aria-pressed", String(this.following));
    this.$status.replaceChildren(
      Typography.p(
        this.cues.length
          ? `${this.cues.length} subtitle lines · hover or focus a fragment to compare · click to pin`
          : "Your subtitles become the transcript.",
      ),
    );
    this.updateShadows();
  }

  private clearTranscript(): void {
    this.hideDefinition();
    this.clearBrowseTimer();
    if (this.followFrame != null) cancelAnimationFrame(this.followFrame);
    this.followFrame = null;
    this.rowObserver.disconnect();
    this.measured.clear();
    for (const row of this.rows.values()) {
      row.session?.destroy();
      row.$row.remove();
    }
    this.rows.clear();
    this.cues = [];
    this.active = [];
    this.sourceKey = "";
    this.$transcript.scrollTop = 0;
    this.following = true;
  }

  destroy(): void {
    this.definitionEvents?.abort();
    this.definitionEvents = null;
    this.playing = false;
    this.shadowObserver.disconnect();
    this.clearTranscript();
    Hotkeys.clearEscapeHandler(this.$options);
    if (this.$options.matches(":popover-open")) this.$options.hidePopover();
    this.props = null;
  }
  onRecycle(): void {
    this.destroy();
  }

  static $styles = [
    ScrollShadows.$styles,
    css`
      :host {
        display: block;
        position: relative;
        overflow: clip;
        color: var(--text-pri);
        background: color-mix(in srgb, var(--bg) 93%, var(--text-pri) 7%);
        padding: 0 clamp(20px, 4vw, 40px);
      }
      [hidden] {
        display: none !important;
      }
      section {
        position: relative;
        overflow: clip;
        height: var(--language-learning-height, auto);
      }
      button {
        font: inherit;
        --font-size: var(--text-9px);
        color: var(--text-sec);
        background: none;
        border: 0;
        border-radius: 6px;
        padding: 6px 8px;
        cursor: pointer;
      }
      button:hover {
        color: var(--text-pri);
        background: var(--hover-color);
      }
      button:disabled {
        opacity: 0.4;
        cursor: default;
      }
      button:focus-visible,
      .fragment:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 3px;
      }
      #more {
        position: absolute;
        top: 12px;
        right: 0;
        z-index: 3;
        width: 32px;
        height: 32px;
        display: grid;
        place-items: center;
        padding: 0;
      }
      #more svg {
        width: 18px;
        height: 18px;
      }
      #stream {
        display: block;
        height: var(--language-learning-height, min(520px, 60vh));
        width: 100%;
        padding-right: 36px;
      }
      .sentence {
        --step-marker-size: 7px;
        --step-pad-x: 57px;
        --step-pad-y: 33px;
        --step-rail-width: 1px;
        --step-gap: 24px;
        position: relative;
        padding: 22px 8px 18px calc(var(--step-pad-x) + var(--step-marker-size) +
          var(--step-gap));
      }
      .sentence:not([data-last])::before {
        content: "";
        position: absolute;
        left: calc(var(--step-pad-x) + (var(--step-marker-size) -
          var(--step-rail-width)) / 2);
        top: calc(var(--step-pad-y) + var(--step-marker-size) + 5px);
        bottom: calc(5px - var(--step-pad-y));
        width: var(--step-rail-width);
        background: var(--divider);
      }
      .timeline-marker {
        position: absolute;
        top: var(--step-pad-y);
        left: var(--step-pad-x);
        width: var(--step-marker-size);
        height: var(--step-marker-size);
        box-sizing: border-box;
        border: 1px solid var(--text-ter);
        border-radius: 50%;
      }
      .active .timeline-marker {
        background: var(--text-pri);
        border-color: var(--text-pri);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--text-pri) 8%, transparent);
      }
      .sentence-content {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 20px;
      }
      .sentence-text {
        --font-size: var(--text-13px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        --line-height-ratio: 1.65;
        /* Caption line breaks belong to the video overlay. Let the transcript
           flow at its own width while retaining the original span offsets. */
        white-space: normal;
        overflow-wrap: anywhere;
        color: var(--text-ter);
        transition: color 0.3s ease;
      }
      .source-line .sentence-text {
        --font-size: var(--text-20px);
        --line-height-ratio: 1.7;
        font-weight: 500;
        color: var(--text-ter);
      }
      .sentence-text[lang=en] {
        --line-height-ratio: 1.25;
      }
      .active .source-line .sentence-text {
        color: var(--text-pri);
      }
      .active .translation-line .sentence-text,
      .sentence:hover .sentence-text {
        color: var(--text-sec);
      }
      .active:hover .source-line .sentence-text {
        color: var(--text-pri);
      }
      .with-reading .sentence-text {
        padding-top: 8px;
      }
      .sentence-head {
        align-items: center;
        gap: 12px;
        padding-top: 10px;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .sentence-head:has(.translate[hidden]) {
        display: none;
      }
      .sentence:hover .sentence-head,
      .sentence:focus-within .sentence-head {
        opacity: 1;
      }
      .timestamp,
      .translate {
        padding: 2px 0;
        min-height: 24px;
        --font-size: var(--text-8px);
      }
      .timestamp {
        position: absolute;
        top: calc(var(--step-pad-y) - 9px);
        left: 0;
        width: calc(var(--step-pad-x) - 12px);
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: var(--text-ter);
      }
      .active .timestamp {
        color: var(--text-pri);
      }
      .scroll-shadow-top,
      .scroll-shadow-bottom {
        left: 0;
        right: 0;
      }
      .fragment,
      .spoken-base {
        display: inline;
      }
      .fragment {
        border-radius: 3px;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }
      #definition {
        position: fixed;
        inset: auto;
        margin: 0;
        box-sizing: border-box;
        width: max-content;
        max-width: min(340px, calc(100vw - 24px));
        max-height: min(320px, calc(100dvh - 24px));
        overflow: auto;
        padding: 12px 14px;
        border: 1px solid var(--divider);
        border-radius: 10px;
        background: var(--bg);
        color: var(--text-pri);
        box-shadow: 0 6px 24px color-mix(in srgb, var(--text-pri) 14%, transparent);
      }
      #definition p {
        --font-size: var(--text-10px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        line-height: 1.4;
        color: var(--text-sec);
      }
      #definition .definition-label {
        --font-size: var(--text-8px);
        color: var(--text-ter);
        --margin-bottom: 4px;
      }
      #definition > div + div { margin-top: 10px; }
      .spoken-base {
        background-image: linear-gradient(
          to right,
          color-mix(in srgb, var(--blue) calc(var(--spoken-start, 0) * 100%), transparent),
          color-mix(in srgb, var(--blue) calc(var(--spoken-end, 0) * 100%), transparent)
        );
        background-position: center calc(100% - 2px);
        background-size: min(100%, var(--spoken-width, 100%)) 2px;
        background-repeat: no-repeat;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }
      .fragment[role=button] {
        cursor: pointer;
      }
      .fragment.aligned {
        background: color-mix(in srgb, var(--blue) 22%, transparent);
        color: var(--text-pri);
      }
      ruby {
        ruby-align: center;
        ruby-position: over;
      }
      ruby.short-reading {
        white-space: nowrap;
      }
      rt {
        --font-size: var(--text-8px);
        --line-height-ratio: 1;
        margin: 0;
        min-height: 0;
        color: var(--text-sec);
        font-weight: 400;
        letter-spacing: 0.01em;
      }
      .sentence-status p {
        --font-size: var(--text-9px);
        --margin-top: 12px;
        --margin-bottom: 0px;
        color: var(--text-sec);
      }
      #status {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
      }
      #empty {
        padding: 30px 8px;
      }
      #empty p {
        --font-size: var(--text-10px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-sec);
      }
      #options {
        position: fixed;
        inset: auto;
        margin: 0;
        box-sizing: border-box;
        width: min(292px, calc(100vw - 24px));
        max-height: calc(100dvh - 24px);
        overflow: auto;
        padding: 16px;
        border: 1px solid var(--divider);
        border-radius: 12px;
        background: var(--bg);
        color: var(--text-pri);
        box-shadow: 0 12px 36px color-mix(in srgb, var(--text-pri) 12%, transparent);
      }
      .option-group + .option-group {
        margin-top: 18px;
      }
      .option-label {
        --font-size: var(--text-9px);
        --margin-top: 0px;
        --margin-bottom: 12px;
        color: var(--text-ter);
      }
      .option-choices {
        flex-wrap: wrap;
        gap: 4px;
      }
      .option-choices button {
        padding: 7px 9px;
        text-align: left;
      }
      .option-choices button[aria-pressed=true] {
        background: var(--hover-color);
        color: var(--text-pri);
      }
      #follow:not([hidden]) {
        margin-bottom: 16px;
      }
      @media (hover: none) {
        .sentence-head {
          opacity: 1;
        }
      }
      @media (max-width: 768px) {
        .source-line .sentence-text {
          --font-size: var(--text-16px);
        }
        .sentence-text {
          --font-size: var(--text-12px);
        }
        .sentence {
          --step-pad-x: 44px;
          --step-pad-y: 29px;
          --step-gap: 16px;
          padding-top: 20px;
          padding-right: 4px;
          padding-bottom: 16px;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .sentence-text,
        .sentence-head {
          transition: none;
        }
      }
    `,
  ];
  static $html = html`
    <section aria-label="Language learning transcript">
      <button id="more" type="button" aria-label="Subtitle options"
        aria-haspopup="dialog" aria-expanded="false" aria-controls="options">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="19" cy="12" r="1.8" fill="currentColor" />
        </svg>
      </button>
      <div id="empty"></div>
      <std-scroll-vertical id="stream"></std-scroll-vertical>
      <div id="status"></div>
      <div id="definition" popover="manual" role="tooltip"></div>
      <div id="options" popover="auto" role="dialog" aria-label="Subtitle options">
        <button id="follow" type="button" hidden>Follow playback</button>
        <div id="option-groups"></div>
      </div>
      <div hidden>
        <select id="placement" aria-label="Transcript position"><option value="below">Below video</option><option value="right">Dock right</option></select>
        <select id="language"
          aria-label="Study language"><option value="zh">Mandarin 中文</option><option value="ja">Japanese 日本語</option><option value="en">English</option></select>
        <select id="track" aria-label="Subtitle track" hidden></select>
        <select id="reading" aria-label="Pronunciation display"></select>
        <select id="targets" aria-label="Translation languages"></select>
      </div>
    </section>
    <div class="scroll-shadow-top" aria-hidden="true"></div>
    <div class="scroll-shadow-bottom" aria-hidden="true"></div>
  `;
}

export namespace LanguageLearningSection {
  export type Placement = "below" | "right";
  export type Track = { id: string; label: string };
  export type Props = {
    provider: StudyProvider;
    language?: Option<StudyLanguage>;
    placement?: Option<Placement>;
    onPlacementChange?: Option<(placement: Placement) => void>;
    onPause?: Option<() => void>;
    onReplay?: Option<(cue: StudyCue) => void>;
    onLanguageChange?: Option<(language: StudyLanguage) => void>;
    onTrackChange?: Option<(id: string) => void>;
  };
}
