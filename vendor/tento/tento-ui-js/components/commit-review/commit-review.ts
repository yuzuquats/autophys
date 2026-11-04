// Bare imports register the subcomponents: the named imports below are all
// type-position-only, which esbuild elides — without these the elements in
// $html never upgrade.
import "../button/button";
import "../diff-view/diff-view";
import "../record-header";
import "./artifact-strip";
import "./commit-list";
import "./verdict-bar";

import { Tracing } from "@tento-core/tracing";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Button } from "../button/button";
import { DiffView } from "../diff-view/diff-view";
import { MiniappChrome } from "../shell-layout/miniapp-chrome";
import { RecordHeader } from "../record-header";
import { ArtifactStrip } from "./artifact-strip";
import { ArtifactViewer } from "./artifact-viewer";
import { CommitList } from "./commit-list";
import { CommitNote } from "./commit-note";
import { VerdictBar } from "./verdict-bar";

// Commit-review tool: a rail of queued commit-sets (std-commit-list) beside
// the selected set's structured diff (std-diff-view), with its attached
// reviewer evidence (std-artifact-strip) above and the floating verdict bar
// (std-verdict-bar) overlaying the pane. All data flows through a
// [`CommitReview.Source`] the page supplies at bind() — this component never
// talks to a backend itself. Shell chrome (breadcrumb crumb + reading-room
// auto-hide) is reported through the generic [`MiniappChrome`] protocol, so
// the diff gets the whole pane without a per-page relay.
//
// Selection IS the URL hash (#<id>, or #<id>/<artifact> to also open that
// artifact): clicking a rail card pushes a history entry, the hashchange
// handler drives selection, and the back button returns to the previous set
// — with each set's diff-pane scroll position preserved across the trip.

@component({ name: "std-commit-review" })
export class CommitReview extends LonaWebComponent {
  private $list: CommitList = this.hydrate("set-list");
  private $reload: Button = this.hydrate("reload");
  private $meta: HTMLElement = this.$("meta");
  private $status: HTMLElement = this.$("status");
  private $diffScroll: HTMLElement = this.$("diff-scroll");
  private $artifacts: ArtifactStrip = this.hydrate("artifacts");
  private $diff: DiffView = this.hydrate("diff");
  private $verdict: VerdictBar = this.hydrate("verdict");

  // Shell chrome: the selected commit's message becomes the breadcrumb's
  // last segment, and the diff scroller's direction drives reading-room
  // auto-hide. No-op when the page is not framed.
  private chrome: MiniappChrome.Connection = MiniappChrome.connect({
    crumb: null,
    autoHideOnScroll: this.$diffScroll,
  });

  private source: Option<CommitReview.Source> = null;
  private loadCommits: Option<() => Promise<CommitReview.CommitSet[]>> = null;
  private sets: CommitReview.CommitSet[] = [];
  private selectedId: Option<string> = null;
  /** From a #<id>/<artifact> deep link: auto-open this artifact once loaded. */
  private pendingArtifact: Option<string> = null;
  /** Each set's diff-pane scrollTop, saved on deselect and restored when
   * navigation (e.g. the back button) returns to it. */
  private paneScroll = new Map<string, number>();
  private reloading = false;
  private selectionGeneration = 0;

  constructor() {
    super();
    // A card click only navigates — pushing #<id> creates the history entry
    // and the hashchange handler drives the actual selection.
    this.$list.onSelect = (id) => this.navigateTo(id);
    GESTURE_MANAGER.addPointerEvent(this.$reload, {
      onClick: () => void this.reload(),
    });
  }

  // `window` outlives this component: the listener must be removed on detach so
  // a pooled instance stops re-selecting from the hash, which means it must be
  // installed on attach rather than in the constructor. See shell-layout.ts.
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("hashchange", this.handleHashChange);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.handleHashChange);
  }

  private handleHashChange = (): void => {
    this.selectFromHash();
  };

  private navigateTo(id: string): void {
    const hash = DeepLink.format({ id, artifact: null });
    if (location.hash === hash) return;
    location.hash = hash; // pushes a history entry; hashchange selects
  }

  // Resolve the current hash against the bound sets: #<id> selects a set,
  // #<id>/<artifact> also opens that artifact. Empty or unknown hashes fall
  // back to the first set — the default the back button returns to. A
  // `#/<host>/<tail>` hash is the fleet shell's deep-link envelope (the outer
  // URL's tail handed back on load) — unwrap it to the native `#<tail>`.
  private selectFromHash(): void {
    if (this.sets.length === 0) return;
    const raw = location.hash.startsWith("#/")
      ? `#${location.hash.slice(2).split("/").slice(1).join("/")}`
      : location.hash;
    const target = DeepLink.parse(raw);
    const known =
      target != null && this.sets.some((s) => s.id === target.id) ? target : null;
    this.pendingArtifact = known?.artifact ?? null;
    void this.select(known?.id ?? this.sets[0].id, false);
  }

  bind(
    source: CommitReview.Source,
    sets: CommitReview.CommitSet[],
    loadCommits: () => Promise<CommitReview.CommitSet[]>,
  ): void {
    this.source = source;
    this.loadCommits = loadCommits;
    // Submitting an inline comment persists through the source and re-binds
    // the updated thread list.
    this.$diff.onSubmit = (c) => {
      const id = this.selectedId;
      if (id == null) return Promise.resolve([]);
      return source.submitComment(id, c);
    };
    // Approving / requesting changes persists the verdict, then reflects the
    // saved status on the set's rail card.
    this.$verdict.onSubmit = async (r) => {
      const id = this.selectedId;
      if (id == null) return Promise.reject(new Error("no commit selected"));
      const review = await source.submitReview(id, r);
      const set = this.sets.find((s) => s.id === id);
      if (set) set.review_status = review.status;
      this.$list.setStatus(id, review.status);
      return review;
    };
    this.sets = sets;
    this.$list.bind(sets);
    if (sets.length === 0) {
      this.$status.textContent = "the commit queue is empty";
      this.$status.style.display = "";
      this.$meta.replaceChildren();
      this.$artifacts.bind([]);
      this.$diff.bind({ files: [] }, null);
      this.selectedId = null;
      this.$verdict.toggleAttribute("shown", false);
      this.chrome.setCrumb(null);
      this.chrome.setHidden(false);
      return;
    }
    this.$status.style.display = "none";
    this.selectFromHash();
  }

  private async reload(): Promise<void> {
    const source = this.source;
    const loadCommits = this.loadCommits;
    if (source == null || loadCommits == null || this.reloading) return;
    this.reloading = true;
    this.$reload.toggleAttribute("disabled", true);
    try {
      const sets = await loadCommits();
      const previousId = this.selectedId;
      this.sets = sets;
      this.$list.bind(sets);
      if (sets.length === 0) {
        this.bind(source, [], loadCommits);
        return;
      }
      this.$status.style.display = "none";
      const selectedId =
        previousId != null && sets.some((set) => set.id === previousId)
          ? previousId
          : sets[0].id;
      if (selectedId !== previousId) this.selectedId = null;
      await this.select(selectedId, true);
    } catch (e) {
      Tracing.err("net")("reload commit queue failed", e);
      this.$status.textContent = `failed to reload commits: ${e}`;
      this.$status.style.display = "";
    } finally {
      this.reloading = false;
      this.$reload.toggleAttribute("disabled", false);
    }
  }

  private async select(id: string, force: boolean): Promise<void> {
    const source = this.source;
    if (source == null) return;
    if (this.selectedId === id && !force) {
      // Same set (e.g. a hash-only artifact change): don't rebind the pane —
      // just honor a pending artifact deep link.
      if (this.pendingArtifact != null) {
        this.$artifacts.open(this.pendingArtifact);
        this.pendingArtifact = null;
      }
      return;
    }
    if (this.selectedId != null) {
      this.paneScroll.set(this.selectedId, this.$diffScroll.scrollTop);
    }
    this.selectedId = id;
    this.$list.setSelected(id);
    const set = this.sets.find((s) => s.id === id);
    this.chrome.setCrumb(set ? CommitReview.messageSubject(set.message) : null);
    // Report the selection up to the shell: the outer URL gains `/<id>` (so a
    // refresh restores this set, not the list's default) and the tab title
    // names the set. Icon stays null — the registry's declared icon is the
    // right layer for it.
    this.chrome.setRoute(set != null ? id : null);
    this.chrome.setMeta({
      title: set ? `${CommitReview.messageSubject(set.message)} · review` : null,
      icon: null,
    });
    // Resolved-artifact promise, created BEFORE the header binds: the note's
    // inline <std-commit-artifact> figures skeleton against it while the
    // fetch is in flight, with no header re-bind when it lands.
    const artifactsVm: Promise<ArtifactViewer.Artifact[]> = source
      .artifacts(id)
      .then((artifacts) =>
        artifacts.map((a) => ({
          name: a.name,
          kind: a.kind,
          src: source.artifactSrc(id, a.entry),
          url: a.url,
          caption: a.caption,
          text: a.text,
        })),
      );
    // Files-deferred for note → diff navigation: settles when the diff lands,
    // so file-ref chips in the note resolve without a header re-bind. A stale
    // selection simply never resolves — its chips stay inert.
    let filesReady: (files: string[]) => void = () => {};
    const changedFiles = new Promise<string[]>((resolve) => (filesReady = resolve));
    this.bindHeader(set ?? null, {
      artifacts: artifactsVm,
      nav: {
        files: changedFiles,
        onFileClick: (path) => void this.$diff.scrollToFile(path),
      },
    });
    this.$diff.bind({ files: [] }, null);
    this.$artifacts.bind([]);
    this.$verdict.bind({
      status: set ? set.review_status : "pending",
      summary: "",
      reviewed_at: 0,
    });
    this.$verdict.toggleAttribute("shown", true);
    this.chrome.setHidden(false);
    const generation = ++this.selectionGeneration;
    try {
      const [artifact, comments, review, artifacts] = await Promise.all([
        source.diff(id),
        source.comments(id),
        source.review(id),
        artifactsVm,
      ]);
      // Only apply if still the selected set (avoid races on fast clicks).
      if (this.selectedId === id && this.selectionGeneration === generation) {
        // Binary image files render inline from the set's file route.
        this.$diff.bind(artifact, { fileSrc: (path, side) => source.fileSrc(id, path, side) });
        filesReady(DiffView.changedPaths(artifact));
        this.$diff.setComments(comments);
        this.$verdict.bind(review);
        // The chip strip is the appendix: only artifacts the note doesn't
        // already render inline.
        const referenced = CommitNote.referencedArtifacts(set?.note ?? "");
        this.$artifacts.bind(artifacts.filter((a) => !referenced.has(a.name)));
        // Returning to a set restores where the reader left off (0 for a
        // first visit — the pane already clamped there on the empty rebind).
        this.$diffScroll.scrollTop = this.paneScroll.get(id) ?? 0;
        if (this.pendingArtifact != null) {
          this.$artifacts.open(this.pendingArtifact);
          this.pendingArtifact = null;
        }
      }
    } catch (e) {
      if (this.selectedId !== id || this.selectionGeneration !== generation) return;
      Tracing.err("net")(`load diff failed for ${id}`, e);
      this.$status.textContent = `failed to load diff: ${e}`;
      this.$status.style.display = "";
    }
  }

  // Commit header (scrolls with the diff): rebuilt per selection from the
  // pure [`CommitReview.Header.make`] factory.
  private bindHeader(set: Option<CommitReview.CommitSet>, ctx: CommitNote.Ctx): void {
    this.$meta.replaceChildren();
    if (set != null) {
      this.$meta.appendChild(
        CommitReview.Header.make(set, ctx, (seq) => {
          const target = this.sets.find((s) => s.seq === seq);
          if (target != null) this.navigateTo(target.id);
        }),
      );
    }
  }

  static $styles = [
    css`
      /* Fixed viewport-height host so the two columns scroll independently
         (a growing min-height would make the whole iframe scroll as one). */
      :host {
        display: block;
        height: 100dvh;
        overflow: hidden;
        color: var(--text-pri);
      }
      #layout {
        display: flex;
        height: 100%;
      }
      /* Set rail: its own scrollbar, pinned title, does not ride the diff. */
      #sets {
        width: 260px;
        flex-shrink: 0;
        border-right: 1px solid var(--divider);
        overflow-y: auto;
        scrollbar-gutter: stable;
        display: flex;
        flex-direction: column;
      }
      #rail-title {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--bg);
        padding: 14px 12px 10px;
        font-size: 1.05rem;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #reload {
        font-size: 12px;
        font-weight: 400;
        --button-padding: 4px 8px;
      }
      #set-list {
        padding: 0 12px 12px;
      }
      /* Content pane: a column that does NOT scroll — the diff region scrolls
         inside it. The commit header (#meta) is in-flow at the top of the
         scroller, so it scrolls away with the content; the shell breadcrumb
         keeps the commit visible after it does. */
      #pane {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        position: relative; /* anchor for the floating verdict UI */
      }
      #diff-scroll {
        flex: 1;
        overflow-y: auto;
        /* Reserve the scrollbar lane even when content fits — the bar
           popping in on load/selection otherwise shifts the whole pane. */
        scrollbar-gutter: stable;
        /* Bottom clearance so a diff's last lines can scroll above the
           floating verdict bar. NO top padding: it would inset the sticky
           rectangle and pin .dfile-head 12px below the top (top spacing
           lives on #meta instead). */
        /* Named pad so header children (the full-bleed divider) can escape
           it deliberately without hardcoding the value twice. */
        --pane-pad: 20px;
        padding: 0 var(--pane-pad) 96px;
        /* Own stacking context: the diff's sticky file headers carry their
           own z-indexes, which must never escape and compete with the
           floating verdict UI overlaying this pane. */
        isolation: isolate;
      }
      #status {
        color: var(--text-ter);
        padding: 12px;
      }
      /* Commit header: scrolls with the diff (not pinned). Empty ⇒ hidden.
         The identity block (message + agent + its full-bleed rule) is
         std-record-header, shared with the v2 stack shell — this file used to
         carry its own near-copy of that typography, which had already drifted
         from the other one (the sub line was proportional here and mono
         there). The rule reads --pane-pad off #diff-scroll below to reach the
         pane edges. */
      #meta {
        padding: 12px 0 0;
        margin-bottom: 12px;
      }
      #meta:empty {
        display: none;
      }
      /* The dependency row rides the header's default slot, so it stays in
         THIS shadow root under these rules — which is the whole reason it is
         slotted rather than handed over as an adopted element. */
      .meta-deps {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
        font-size: 10.5px;
        color: var(--text-ter);
      }
      .dep-chip {
        font: inherit;
        /* The real face, not var(--mono, …): --mono is defined nowhere in
           this app, so that spelling ships the browser's generic monospace —
           which would now sit one line under a sub line correctly set in SF
           Mono. (The other sites still spelling it that way are a theme-level
           fix, not this one's.) */
        font-family: var(--record-header-sub-font);
        color: var(--text-sec);
        background: none;
        border: 1px solid var(--divider);
        border-radius: 999px;
        padding: 1px 8px;
        cursor: pointer;
      }
      .dep-chip:hover {
        border-color: var(--text-ter);
        background: var(--bg-hover-light);
      }
      /* Markdown note: std-documentation centers its prose in an 800px
         column with editor padding by default — flatten both so it reads as
         part of the header (density comes from its compact preset). */
      .meta-note {
        margin-top: 10px;
        --editor-max-width: none;
        --editor-padding: 0;
      }
      /* Floating verdict bar: bottom-centered over the pane, hidden until a
         set is selected. The host is the positioned anchor the bar's layers
         resolve against; all inner morph/layer CSS lives in std-verdict-bar. */
      #verdict {
        position: absolute;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2;
        width: min(560px, calc(100% - 32px));
        display: none;
      }
      #verdict[shown] {
        display: block;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="layout">
      <aside id="sets">
        <div id="rail-title">
          <span>commit review</span>
          <std-button id="reload" flat thin>reload</std-button>
        </div>
        <std-commit-list id="set-list"></std-commit-list>
      </aside>
      <main id="pane">
        <div id="diff-scroll">
          <div id="meta"></div>
          <std-artifact-strip id="artifacts"></std-artifact-strip>
          <div id="status"></div>
          <std-diff-view id="diff"></std-diff-view>
        </div>
        <std-verdict-bar id="verdict"></std-verdict-bar>
      </main>
    </div>
  `;
}

// ── #<id>/<artifact> hash scheme ────────────────────────────────────────────
// Selection and deep links share it: parse() resolves a hash to a target,
// format() is its inverse for navigation pushes.
namespace DeepLink {
  export type Target = { id: string; artifact: Option<string> };

  export function parse(hash: string): Option<Target> {
    const raw = decodeURIComponent(hash.slice(1));
    if (raw === "") return null;
    const slash = raw.indexOf("/");
    if (slash === -1) return { id: raw, artifact: null };
    return { id: raw.slice(0, slash), artifact: raw.slice(slash + 1) };
  }

  export function format(target: Target): string {
    const id = encodeURIComponent(target.id);
    return target.artifact == null
      ? `#${id}`
      : `#${id}/${encodeURIComponent(target.artifact)}`;
  }
}

// The viewmodel + data-source contract. `CommitSet` mirrors the commit-review
// service's queue wire shape (structural typing lets pages bind wire objects
// directly); `Source` is how the page injects its API — this component and
// its subcomponents never import an app lib or call a backend themselves.
export namespace CommitReview {
  export type CommitSet = {
    id: string;
    seq: number;
    agent: string;
    message: string;
    repo: string;
    paths: string[];
    base_head: string;
    /** Markdown — rendered as a documentation block under the header. */
    note: string;
    /** Seqs of queued sets this one must drain after (beyond seq order) —
     * rendered as jump chips under the header. */
    depends_on?: Option<number[]>;
    review_status: VerdictBar.Status;
  };

  /** A set's attached artifact, as the service lists it (`entry` is relative
   * to the set's artifact root; resolved to a URL via `Source.artifactSrc`). */
  export type Artifact = {
    name: string;
    kind: ArtifactStrip.Kind;
    entry: string;
    url?: Option<string>;
    caption?: Option<string>;
    text?: Option<string>;
  };

  export type Source = {
    diff(id: string): Promise<DiffView.Artifact>;
    comments(id: string): Promise<DiffView.Comment[]>;
    submitComment(id: string, comment: DiffView.NewComment): Promise<DiffView.Comment[]>;
    review(id: string): Promise<VerdictBar.Review>;
    submitReview(id: string, review: VerdictBar.NewReview): Promise<VerdictBar.Review>;
    artifacts(id: string): Promise<Artifact[]>;
    /** Resolve an artifact `entry` to a same-origin URL for iframe/img src. */
    artifactSrc(id: string, entry: string): string;
    /** Resolve a changed file's path + side to a same-origin URL (the set's
     * `/file/{side}/{path}` route) — the diff-view's inline-image bytes. */
    fileSrc(id: string, path: string, side: DiffView.CommentSide): string;
  };

  /** First line of a set's message — the title every compact surface shows.
   * Commit-shaped sets carry a teaching-note body after the subject line in
   * the same `message` field (mirrors `StackLog.messageSubject`; kept local
   * so the queue viewer doesn't pull the stack-log bundle). */
  export function messageSubject(message: string): string {
    const line = message.split("\n", 1)[0].trim();
    return line !== "" ? line : "(no message)";
  }

  /** Everything after the subject line — the teaching-note body, if any. */
  export function messageBody(message: string): string {
    const nl = message.indexOf("\n");
    return nl < 0 ? "" : message.slice(nl + 1).trim();
  }


  // The commit header block: message line, agent subline, a full-bleed
  // divider, and the markdown note (what/why, drain instructions, dependency
  // callouts) as a compact documentation block that can inline the set's
  // artifacts ([`CommitNote`]). Pure factory — the owning class binds/clears
  // it into #meta (`bindHeader`).
  export namespace Header {
    export function make(
      set: CommitSet,
      ctx: CommitNote.Ctx,
      onSelectSeq: Option<(seq: number) => void>,
    ): HTMLElement {
      const $header = document.createElement("div");
      const $identity = RecordHeader.makeWith({
        // No pip: this shell only ever shows the drain queue, and nothing is
        // committed yet for anyone to have decided about. The set's id still
        // goes on top — the line's job is the record's address, and it has one
        // whether or not there is a state to draw beside it.
        status: { icon: null, label: set.id },
        title: messageSubject(set.message),
        subs: [set.agent],
        warn: null,
      });
      $header.appendChild($identity);
      const deps = set.depends_on ?? [];
      if (deps.length > 0) {
        const $deps = document.createElement("div");
        $deps.className = "meta-deps";
        const $label = document.createElement("span");
        $label.textContent = "drains after";
        $deps.appendChild($label);
        for (const seq of deps) {
          const $chip = document.createElement("button");
          $chip.type = "button";
          $chip.className = "dep-chip";
          $chip.textContent = `#${seq}`;
          if (onSelectSeq != null) {
            GESTURE_MANAGER.addPointerEvent($chip, {
              onClick: () => onSelectSeq(seq),
            });
          }
          $deps.appendChild($chip);
        }
        // The header's default slot: above its rule, below the sub line —
        // where this row already sat, and still under this file's stylesheet.
        $identity.appendChild($deps);
      }
      const body = messageBody(set.message);
      if (body !== "") {
        const $body = CommitNote.make(body, ctx);
        $body.classList.add("meta-note");
        $header.appendChild($body);
      }
      if (set.note !== "") {
        const $note = CommitNote.make(set.note, ctx);
        $note.classList.add("meta-note");
        $header.appendChild($note);
      }
      return $header;
    }
  }
}
