import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { Epoch, RelativeTime } from "@tento-chrono";

// A VALUE import, not `import type`: it is what registers `std-section-head`,
// and a type-only import would leave the template's element inert.
import { SectionHead } from "../section-head";
import { CommentCard } from "../documentation/comment-card";
import { DocComments } from "../documentation/doc-comments";
import type { DocComment } from "../documentation/doc-comments";
import type { DiffView } from "../diff-view/diff-view";
import type { RevisionCompare } from "./revision-compare";
import type { VerdictBar } from "./verdict-bar";
import { DiscussionActivity as Activity } from "./discussion-activity";
import { DiscussionPresentation as Presentation } from "./discussion-presentation";

// The change pane's third region (review-column → "three regions, three
// ordering rules"). The note+gutter and the diff both order their contents by
// POSITION — a prose comment's `y` in the gutter is its anchor, a diff
// comment's row is its line. A statement about the whole change has no position
// in either, which is why the verdict has only ever existed as a floating
// composer and why `commitWide` was declared and never written.
//
// This region orders by TIME as one forum conversation: authored prose gets a
// full comment card, while revisions and verdicts stay lightweight events on
// the same rail. A revision capture has no prose at all, and it is often the
// most load-bearing event in the log — "claude revised the change · Diff 3" is
// what explains why the request above it stopped applying. A log of comments
// alone makes the reader reconstruct that from timestamps.
//
// It never mutates review state: the only control expands a dense run of
// structural activity, and an optional callback synchronizes a selected Diff
// with the Versions strip. The floating verdict bar remains the sole writer.
// That split is the whole design — the bar WRITES, the region READS. The list
// is a HISTORY, and the current state is the bar's to report.
//
// Self-hides on an empty log, so an unreviewed commit with no overall comments
// costs zero layout.

@component({ name: "std-discussion" })
export class Discussion extends LonaWebComponent {
  private $head: SectionHead = this.hydrate("head");
  private $log: HTMLElement = this.$("log");
  private onSelectRevision: Option<(n: number) => void> = null;

  /** Construct + bind in one call — the house pattern for a component whose
   * every caller does exactly that (cf. `RevisionCompare.makeWith`). */
  static makeWith(vm: Discussion.ViewModel): Discussion {
    return Discussion.make().bind(vm);
  }

  bind(vm: Discussion.ViewModel): this {
    // Bound here rather than in the constructor so it survives recycling: the
    // shared header clears its title on recycle, and every use of this
    // component goes through `bind`.
    //
    // Title only — no count, and nothing in the meta slot. The slot used to
    // carry "everything that happened · newest last", which told the reader
    // what the rows below already show them; a header is not the place to
    // narrate a list's ordering. A count is the affordance that would earn
    // that space, and it is not added here on the way past.
    this.$head.bind({ title: "Discussion", count: null });
    const events = [...vm.events].sort(Discussion.compare);
    const entries = Discussion.group(events);
    this.onSelectRevision = vm.onSelectRevision ?? null;
    this.toggleAttribute("hidden", events.length === 0);
    this.$log.replaceChildren();
    if (events.length === 0) return this;
    // One `now` per render measures every relative time in the log.
    const now = Epoch.currentMse();
    for (const entry of entries) {
      this.$log.appendChild(Discussion.$row(entry, now, this.onSelectRevision));
    }
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        margin-top: 18px;
      }

      :host([hidden]) {
        display: none;
      }

      #log {
        display: flex;
        flex-direction: column;
        padding-top: 16px;
      }

      .ev {
        position: relative;
        min-width: 0;
        padding-bottom: 18px;
      }

      .ev:last-child {
        padding-bottom: 0px;
      }

      details.activity {
        min-width: 0;
      }

      details.activity > summary {
        min-width: 0;
        cursor: pointer;
        list-style: none;
        color: var(--text-sec);
      }

      details.activity > summary::-webkit-details-marker {
        display: none;
      }

      .activity-summary {
        min-width: 0;
      }

      .activity-toggle,
      .activity-toggle-open {
        --font-size: var(--caption-size);
        --line-height-ratio: 1.2;
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--blue);
      }

      .activity-toggle-open {
        display: none;
      }

      details.activity[open] .activity-toggle {
        display: none;
      }

      details.activity[open] .activity-toggle-open {
        display: block;
      }

      .activity-items {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-width: 620px;
        margin: 8px auto 0px;
        padding: 5px;
        border: 1px solid var(--divider);
        border-radius: 8px;
        background: color-mix(in srgb, var(--bg-surface-light) 62%, transparent);
      }

      .activity-item {
        appearance: none;
        width: 100%;
        padding: 5px 7px;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--text-sec);
        font: inherit;
        text-align: left;
      }

      .activity-item-text {
        --font-size: var(--caption-size);
        --line-height-ratio: 1.35;
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: inherit;
      }

      button.activity-item {
        cursor: pointer;
      }

      button.activity-item:hover,
      button.activity-item:focus-visible {
        background: var(--bg-surface-light);
        color: var(--text-pri);
        outline: none;
      }

      /* GitHub-style conversation anatomy. One rail carries both authored
        cards and lightweight structural activity. */
      #log {
        position: relative;
      }

      #log::before {
        content: "";
        position: absolute;
        top: 16px;
        bottom: 10px;
        left: 14px;
        width: 1px;
        background: var(--divider);
      }

      .forum-event {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr);
        gap: 10px;
        align-items: start;
        padding-bottom: 18px;
      }

      .forum-event:last-child {
        padding-bottom: 0px;
      }

      .timeline-node {
        position: relative;
        z-index: 1;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        margin: 2px 0 0 4px;
        border: 1px solid color-mix(in srgb, var(--divider) 72%, var(--text-ter));
        border-radius: 999px;
        background: var(--bg);
        color: var(--text-sec);
      }

      .timeline-node[data-status="approved"] {
        border-color: color-mix(in srgb, var(--green) 62%, var(--divider));
        background: color-mix(in srgb, var(--green-dimmed) 28%, var(--bg));
        color: var(--green);
      }

      .timeline-node[data-status="changes_requested"] {
        border-color: color-mix(in srgb, var(--orange) 62%, var(--divider));
        background: color-mix(in srgb, var(--orange-dimmed) 25%, var(--bg));
        color: var(--orange);
      }

      .timeline-node-text,
      .forum-inline-avatar-text {
        --font-size: var(--text-8px);
        --line-height-ratio: 1;
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-weight: 650;
      }

      .forum-thread {
        min-width: 0;
      }

      .forum-card {
        position: relative;
        box-sizing: border-box;
        min-width: 0;
        overflow: visible;
        border: 1px solid var(--divider);
        border-radius: 8px;
        background: var(--bg);
      }

      .forum-card-head {
        position: relative;
        display: flex;
        align-items: baseline;
        gap: 5px;
        min-width: 0;
        padding: 7px 10px;
        border-bottom: 1px solid var(--divider);
        border-radius: 7px 7px 0 0;
        background: color-mix(in srgb, var(--bg-surface-light) 72%, var(--bg));
        flex-wrap: wrap;
      }

      .forum-author,
      .forum-action,
      .forum-meta,
      .forum-ref {
        --font-size: var(--small-size);
        --line-height-ratio: 1.25;
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      .forum-author {
        color: var(--text-pri);
        font-weight: 650;
      }

      .forum-action,
      .forum-meta {
        color: var(--text-sec);
      }

      .forum-meta::before,
      .forum-ref::before {
        content: "·";
        margin-right: 5px;
        color: var(--text-ter);
      }

      .forum-ref {
        padding: 1px 5px;
        border: 1px solid var(--divider);
        border-radius: 999px;
        color: var(--text-sec);
        font-family: var(--font-mono, ui-monospace, monospace);
      }

      .forum-ref::before {
        content: none;
      }

      .forum-anchor {
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
        padding: 6px 10px;
        border-bottom: 1px solid var(--divider);
        background: color-mix(in srgb, var(--bg-surface-light) 42%, var(--bg));
        font-family: var(--font-mono, ui-monospace, monospace);
        color: var(--text-ter);
      }

      .forum-anchor-label,
      .forum-anchor-side {
        --font-size: var(--caption-size);
        --line-height-ratio: 1.2;
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      .forum-anchor-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .forum-anchor-side {
        flex: none;
        padding: 0 4px;
        border: 1px solid var(--divider);
        border-radius: 999px;
      }

      .forum-card-body {
        --font-size: var(--p-size);
        --line-height-ratio: 1.5;
        --margin-top: 0px;
        --margin-bottom: 0px;
        padding: 10px 11px;
        color: var(--text-pri);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .forum-replies {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 7px;
        margin: 8px 0 0 10px;
        padding-left: 8px;
        border-left: 1px solid var(--divider);
      }

      .forum-reply-card {
        border-radius: 7px;
      }

      .forum-reply-card::before {
        content: "";
        position: absolute;
        top: 13px;
        left: -9px;
        width: 8px;
        height: 1px;
        background: var(--divider);
      }

      .forum-reply-card .forum-card-head {
        align-items: center;
        border-radius: 6px 6px 0 0;
      }

      .forum-inline-avatar {
        box-sizing: border-box;
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border: 1px solid color-mix(in srgb, var(--divider) 45%, transparent);
        border-radius: 999px;
        color: var(--text-sec-on-solid);
      }

      .forum-inline-avatar[data-kind="agent"] {
        border-radius: 5px;
      }

      .forum-system-content {
        min-width: 0;
        padding-top: 2px;
      }

      .forum-system-line {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        min-height: 20px;
        flex-wrap: wrap;
      }

      .forum-system-line .forum-author {
        font-weight: 600;
      }

      .forum-system-line .forum-action {
        color: var(--text-sec);
      }

      .forum-review-card {
        margin-top: 8px;
      }

      .forum-review-card .forum-card-head {
        align-items: center;
      }

      .forum-review-card[data-status="approved"] {
        border-color: color-mix(in srgb, var(--green) 32%, var(--divider));
      }

      .forum-review-card[data-status="changes_requested"] {
        border-color: color-mix(in srgb, var(--orange) 34%, var(--divider));
      }

      .forum-system details.activity > summary {
        display: block;
      }

      .forum-system .activity-items {
        max-width: none;
        margin: 7px 0 0;
        padding: 5px;
      }

      .revision-activity[data-attributed="true"] .activity-items {
        /* Match the summary text after its 18px actor avatar + 5px gap. */
        margin-left: 23px;
      }

      .forum-system .activity-toggle,
      .forum-system .activity-toggle-open {
        margin-left: 3px;
      }

      @media (max-width: 768px) {
        #log::before {
          left: 11px;
        }

        .forum-event {
          grid-template-columns: 24px minmax(0, 1fr);
          gap: 8px;
          padding-bottom: 15px;
        }

        .timeline-node {
          width: 18px;
          height: 18px;
          margin-left: 2px;
        }

        .forum-card-head {
          gap: 4px;
          padding: 6px 8px;
        }

        .forum-card--root > .forum-card-head::before,
        .forum-card--root > .forum-card-head::after {
          top: 6px;
        }

        .forum-anchor {
          padding: 5px 8px;
        }

        .forum-card-body {
          padding: 8px 9px;
        }

        .forum-replies {
          margin-left: 5px;
          padding-left: 7px;
        }
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <std-section-head id="head"></std-section-head>
      <div id="log"></div>
    </div>
  `;
}

// Everything below is a pure function of an Event: no DOM, no `this`, no
// clock beyond the `now` handed in. The component above is assembly only, so
// every rule about what the log SAYS is reachable and checkable from here —
// which also keeps the store's defensiveness (below) in one place instead of
// scattered through a DOM builder.

/** What a verdict event says the reviewer did. */
const VERDICT_VERB: Record<VerdictBar.Status, string> = {
  pending: "opened this for review",
  approved: "approved this change",
  changes_requested: "requested changes",
};

/** Ranks an event kind for the tie-break when two events share a timestamp.
 *  A revision is what the rest of the log is responding to, and a verdict is
 *  coarser than the prose under it, so they read in that order. */
const KIND_RANK: Record<Discussion.Event["kind"], number> = {
  revision: 0,
  verdict: 1,
  comment: 2,
  code: 3,
};

export namespace Discussion {
  /** One entry in the log — everything that has happened to a change and
   *  everything said about it, whatever store it lives in. A `revision` is a
   *  capture under `.reviews/<cid>/revisions/`; a verdict is flattened out of
   *  `review.json`; a `comment` is a thread from the note store (commit-wide OR
   *  anchored to a passage); a `code` is a diff-line comment.
   *
   *  Anchored threads appear here AND in their own column — deliberately. The
   *  gutter shows a comment beside the passage it is about, which is what you
   *  need while reading the note; the log shows the conversation in the order
   *  it happened, which is what you need to catch up. Neither substitutes. */
  export type Event =
    | {
      kind: "revision";
      /** The revision number — `Diff N` on the actor line. */
      n: number;
      trigger: Trigger;
      /** Concrete mutation provenance. Null is honest legacy/fallback data;
       *  Git authorship and current ownership must never stand in. */
      actor: Option<RevisionCompare.ActorRef>;
      scope: Option<RevisionCompare.Scope>;
      /** Mutation time when known, otherwise observation time; millis. */
      at: number;
    }
    | {
      kind: "verdict";
      status: Status;
      author: Author;
      at: number;
      /** The revision (Diff N) the verdict was cast against, when known. */
      revision: Option<number>;
      summary: string;
    }
    | { kind: "comment"; thread: Thread }
    | { kind: "code"; comment: CodeComment };

  /** Read-only review history. Selecting a revision changes only the view. */
  export interface ViewModel {
    /** Chronological, oldest first. `bind` sorts defensively, so a caller that
     *  merges two sources need not pre-order them. */
    events: Event[];
    /** Synchronize an expanded Diff with the Versions selector. */
    onSelectRevision?: Option<(n: number) => void>;
  }

  export type RevisionEvent = Extract<Event, { kind: "revision" }>;

  export type RevisionGroup = Activity.RevisionGroup<RevisionEvent>;

  export type Entry = Event | RevisionGroup;

  /** The log's own vocabulary for the records it carries.
   *
   *  The `Event` union names three stores' records, so every caller that builds
   *  an event has to name them too — and before these existed the only way was
   *  to reach past this namespace into `DocComment["author"]`-style indexed
   *  access on another module's type. That is the tell that a namespace is
   *  unfinished: it publishes a shape without publishing the shape's parts.
   *
   *  These are aliases, not wrappers. The store still owns the records; this
   *  owns what to call them here. */
  export type Thread = DocComment;
  export type ThreadReply = DocComments.DocReply;
  export type Author = DocComments.Author;
  export type Trigger = RevisionCompare.Trigger;
  export type Status = VerdictBar.Status;
  export type CodeComment = DiffView.Comment;

  /** The fields a caller of {@link makeThread} chooses. Everything else about
   *  a thread record — eleven fields of it — is the store's, and spelling them
   *  out at a call site is a second place to update when the shape moves. */
  export interface ThreadSpec {
    id: string;
    author: Author;
    body: string;
    /** When it was said, in unix **millis** (the note store's unit). */
    at: number;
    replies: readonly ThreadReply[];
  }

  /** Build the thread a `comment` event carries.
   *
   *  A namespace that names a type should be able to make one. `Thread` is
   *  published here, so this is too — otherwise every caller has to reach past
   *  it to `DocComments` and then patch the three fields the store's factory
   *  does not take. */
  export function makeThread(spec: ThreadSpec): Thread {
    return {
      ...DocComments.makeCommitWideComment(spec.body, spec.author),
      id: spec.id,
      createdAt: spec.at,
      replies: [...spec.replies],
    };
  }

  /** One event, projected to exactly what a row renders — and nothing about
   *  how. Four kinds collapse to one shape here, which is why {@link
   *  Discussion.$event} branches on none of them.
   *
   *  `body: null` is a real answer, not a missing one: a revision has no prose
   *  and a verdict cast without a summary has none either, and both still
   *  render as a row. */
  export interface Row {
    /** The rail dot's `data-status`. */
    status: string;
    /** `you requested changes · 2h · Diff 1`. */
    actor: string;
    anchor: Option<Row.Anchor>;
    body: Option<string>;
    replies: readonly Row.Reply[];
  }

  /** The row's own parts, nested under it rather than loose in the namespace:
   *  they describe the projection, not the stores, and `Reply` beside
   *  {@link ThreadReply} at one level would be two different things wearing
   *  nearly the same name. */
  export namespace Row {
    /** What a comment is attached to, as the chip renders it. */
    export interface Anchor {
      label: string;
      /** The diff side (`old` | `new`) for a line anchor; absent for a passage. */
      side: Option<string>;
    }

    /** A reply under a thread's body card. */
    export interface Reply {
      actor: string;
      body: string;
    }
  }

  /** One row, assembled from the projection {@link row} already
   *  made. Four event kinds reach this method and it branches on none of them:
   *  every question about what a row SAYS — the verb, the chip, whether there
   *  is a body at all — was answered in the namespace, where it can be checked
   *  without a DOM. What is left here is placement. */
  export function $row(
    event: Entry,
    now: number,
    onSelectRevision: Option<(n: number) => void> = null,
  ): HTMLElement {
    if (event.kind === "revision-group") {
      return $revisionGroup(event, now, onSelectRevision);
    }
    if (event.kind === "revision" || event.kind === "verdict") {
      return $systemRow(event, now);
    }
    return $messageRow(event, now);
  }

  function $messageRow(
    event: Extract<Event, { kind: "comment" | "code" }>,
    now: number,
  ): HTMLElement {
    const $row = document.createElement("div");
    $row.className = "ev forum-event forum-message";
    const author: Author = event.kind === "code"
      ? "operator"
      : event.thread.author ?? "operator";
    const at = event.kind === "code"
      ? event.comment.created_at * 1000
      : event.thread.createdAt;
    const revision = event.kind === "comment"
      ? event.thread.anchor?.revision ?? null
      : null;
    const anchor = event.kind === "code"
      ? {
        label: `${event.comment.file}:${event.comment.line}`,
        side: event.comment.side,
      }
      : threadAnchor(event.thread);
    const body = event.kind === "code"
      ? event.comment.body ?? ""
      : event.thread.body ?? "";

    const $thread = document.createElement("div");
    $thread.className = "forum-thread";
    $thread.appendChild(
      $forumCard({
        author,
        action: event.kind === "code" ? "commented on code" : "commented",
        at,
        revision,
        anchor,
        body,
        root: true,
        now,
      }),
    );

    if (event.kind === "comment" && (event.thread.replies ?? []).length > 0) {
      const $replies = document.createElement("div");
      $replies.className = "forum-replies";
      for (const reply of event.thread.replies ?? []) {
        const $reply = $forumCard({
          author: reply.author,
          action: Presentation.replyAction(reply.addressedIn ?? null),
          at: reply.createdAt,
          revision: reply.addressedIn ?? null,
          anchor: null,
          body: reply.body ?? "",
          root: false,
          now,
        });
        $reply.classList.add("forum-reply-card");
        $replies.appendChild($reply);
      }
      $thread.appendChild($replies);
    }

    $row.append($eventNode(event), $thread);
    return $row;
  }

  interface ForumCardSpec {
    author: Author;
    action: string;
    at: number;
    revision: Option<number>;
    anchor: Option<Row.Anchor>;
    body: string;
    root: boolean;
    now: number;
  }

  function $forumCard(spec: ForumCardSpec): HTMLElement {
    const $card = document.createElement("div");
    $card.className = spec.root ? "forum-card forum-card--root" : "forum-card";
    const $head = document.createElement("div");
    $head.className = "forum-card-head";
    $head.appendChild($authorInlineAvatar(spec.author));
    $head.append(
      $forumText("forum-author", DocComments.authorLabel(spec.author)),
      $forumText("forum-action", spec.action),
      $forumText("forum-meta", RelativeTime.compact(spec.at, spec.now)),
    );
    if (spec.revision != null) {
      $head.appendChild($forumText("forum-ref", `Diff ${spec.revision}`));
    }
    $card.appendChild($head);
    if (spec.anchor != null) $card.appendChild($forumAnchor(spec.anchor));
    if (spec.body !== "") {
      $card.appendChild($forumText("forum-card-body", spec.body));
    }
    return $card;
  }

  function $systemRow(
    event: Extract<Event, { kind: "revision" | "verdict" }>,
    now: number,
  ): HTMLElement {
    const r = row(event, now);
    const $row = document.createElement("div");
    $row.className = "ev forum-event forum-system";
    $row.dataset.status = r.status;
    const $content = document.createElement("div");
    $content.className = "forum-system-content";
    $content.appendChild($systemLine(event, r.actor));
    if (event.kind === "verdict" && r.body != null) {
      const $review = $forumCard({
        author: event.author,
        action: "left a review",
        at: event.at,
        revision: event.revision,
        anchor: null,
        body: r.body,
        root: false,
        now,
      });
      $review.classList.add("forum-review-card");
      $review.dataset.status = event.status;
      $content.appendChild($review);
    }
    $row.append($eventNode(event), $content);
    return $row;
  }

  function $systemLine(event: Entry, text: string): HTMLElement {
    const $line = document.createElement("div");
    $line.className = "forum-system-line";
    const actor = entryActor(event);
    const verdictAuthor = event.kind === "verdict" ? event.author : null;
    if (actor != null) {
      $line.appendChild($actorInlineAvatar(actor));
    } else if (verdictAuthor != null) {
      $line.appendChild($authorInlineAvatar(verdictAuthor));
    }
    const actorLabel = actor != null
      ? Discussion.actorLabel(actor)
      : verdictAuthor != null
      ? DocComments.authorLabel(verdictAuthor)
      : null;
    for (const part of Presentation.line(text, actorLabel)) {
      const cls = part.kind === "author"
        ? "forum-author"
        : part.kind === "action"
        ? "forum-action"
        : part.kind === "ref"
        ? "forum-ref"
        : "forum-meta";
      $line.appendChild($forumText(cls, part.text));
    }
    return $line;
  }

  function threadAnchor(thread: Thread): Option<Row.Anchor> {
    const target = threadTarget(thread);
    if (target == null) return null;
    return { label: target, side: thread.anchor?.side ?? null };
  }

  function $forumAnchor(anchor: Row.Anchor): HTMLElement {
    const $anchor = document.createElement("div");
    $anchor.className = "forum-anchor";
    $anchor.title = anchor.label;
    $anchor.appendChild($forumText("forum-anchor-label", anchor.label));
    if (anchor.side != null && anchor.side !== "") {
      $anchor.appendChild($forumText("forum-anchor-side", anchor.side));
    }
    return $anchor;
  }

  function $forumText(cls: string, text: string): HTMLElement {
    const $text = Typography.text(text);
    $text.className = cls;
    return $text;
  }

  function $authorInlineAvatar(author: Author): HTMLElement {
    const $avatar = document.createElement("span");
    $avatar.className = "forum-inline-avatar";
    $avatar.dataset.kind = author === "operator" ? "operator" : "agent";
    $avatar.style.background = CommentCard.authorColor(author);
    $avatar.title = DocComments.authorLabel(author);
    $avatar.appendChild(
      $forumText("forum-inline-avatar-text", DocComments.authorInitial(author)),
    );
    return $avatar;
  }

  function $actorInlineAvatar(actor: RevisionCompare.ActorRef): HTMLElement {
    const $avatar = document.createElement("span");
    $avatar.className = "forum-inline-avatar";
    $avatar.dataset.kind = actor.kind === "operator" ? "operator" : "agent";
    $avatar.style.background = actor.kind === "operator"
      ? "var(--blue-dimmed)"
      : "var(--orange-dimmed)";
    $avatar.title = actorTooltip(actor);
    $avatar.appendChild(
      $forumText("forum-inline-avatar-text", initials(actor.label)),
    );
    return $avatar;
  }

  function entryActor(event: Entry): Option<RevisionCompare.ActorRef> {
    if (event.kind === "revision-group") {
      return event.revisions[0]?.actor ?? null;
    }
    if (event.kind === "revision") return event.actor;
    return null;
  }

  function $eventNode(event: Entry): HTMLElement {
    const spec = eventNodeSpec(event);
    const $node = document.createElement("div");
    $node.className = "timeline-node";
    $node.dataset.status = spec.status;
    $node.title = spec.label;
    $node.setAttribute("aria-label", spec.label);
    $node.appendChild($forumText("timeline-node-text", spec.text));
    return $node;
  }

  function eventNodeSpec(event: Entry): Presentation.NodeSpec {
    if (event.kind === "verdict") return Presentation.eventNode(event.status);
    if (event.kind === "comment" || event.kind === "code") {
      return Presentation.commentNode(event.kind);
    }
    return Presentation.eventNode("revision");
  }

  function $revisionGroup(
    group: RevisionGroup,
    now: number,
    onSelectRevision: Option<(n: number) => void>,
  ): HTMLElement {
    const $row = document.createElement("div");
    $row.className = "ev forum-event forum-system revision-activity";
    $row.dataset.status = "revision";
    $row.dataset.attributed = entryActor(group) == null ? "false" : "true";

    const $details = document.createElement("details");
    $details.className = "activity forum-system-content";
    const $summary = document.createElement("summary");
    const $label = $systemLine(
      group,
      activitySummary(group.revisions, now),
    );
    $label.classList.add("activity-summary");
    const $show = Typography.text("Details");
    $show.className = "activity-toggle";
    const $hide = Typography.text("Hide");
    $hide.className = "activity-toggle-open";
    $label.append($show, $hide);
    $summary.appendChild($label);
    const $items = document.createElement("div");
    $items.className = "activity-items";
    for (const revision of group.revisions) {
      const text = revisionDetail(revision, now);
      const $item = onSelectRevision == null
        ? document.createElement("div")
        : document.createElement("button");
      $item.className = "activity-item";
      const $itemText = Typography.text(text);
      $itemText.className = "activity-item-text";
      $item.appendChild($itemText);
      $item.title = revision.actor?.id ?? "Actor unavailable";
      const selectRevision = onSelectRevision;
      if ($item instanceof HTMLButtonElement && selectRevision != null) {
        $item.type = "button";
        GESTURE_MANAGER.addPointerEvent($item, {
          onClick: () => selectRevision(revision.n),
        });
      }
      $items.appendChild($item);
    }
    $details.append($summary, $items);
    $row.append($eventNode(group), $details);
    return $row;
  }

  function actorTooltip(actor: RevisionCompare.ActorRef): string {
    const facts = [actor.label, actor.provider, actor.host];
    if (actor.session_ref != null) facts.push(actor.session_ref);
    return facts.join(" · ");
  }

  function initials(label: string): string {
    const words = label.trim().split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return `${words[0][0]}${words.at(-1)?.[0] ?? ""}`.toUpperCase();
  }

  /** The whole content decision for one event, in one place. */
  export function row(event: Event, now: number): Row {
    if (event.kind === "revision") {
      // A revision is not something anyone said — it is the change moving
      // under the conversation — so it has no body card and nothing to quote.
      // That is the whole difference between a log of comments and a log of
      // what happened: the events with nothing to read are exactly the ones
      // that explain why the comments around them stopped applying.
      return {
        status: "revision",
        actor: actorLine(
          revisionLabel(event.actor, event.trigger),
          event.at,
          event.n,
          now,
        ),
        anchor: null,
        body: null,
        replies: [],
      };
    }

    if (event.kind === "verdict") {
      const label = `${DocComments.authorLabel(event.author)} ${
        VERDICT_VERB[event.status]
      }`;
      return {
        status: event.status,
        actor: actorLine(label, event.at, event.revision, now),
        anchor: null,
        // A verdict with no summary is still an event — it just has nothing to
        // quote, so it renders as the actor line alone.
        body: event.summary !== "" ? event.summary : null,
        replies: [],
      };
    }

    if (event.kind === "code") {
      // A diff-line comment carries no author and no id — it is a flat record
      // stamped by the server — so the actor line names the operator, which is
      // the only voice that writes one today.
      const c = event.comment;
      return {
        status: "code",
        actor: actorLine("you commented", c.created_at * 1000, null, now),
        anchor: { label: `${c.file}:${c.line}`, side: c.side },
        body: c.body ?? "",
        replies: [],
      };
    }

    const thread = event.thread;
    const label = `${
      DocComments.authorLabel(thread.author ?? "operator")
    } commented`;
    // An anchored thread says WHAT it is about; a commit-wide one is about the
    // change, which this region already says, so it gets no chip.
    const target = threadTarget(thread);
    return {
      status: "comment",
      actor: actorLine(
        label,
        thread.createdAt,
        thread.anchor?.revision ?? null,
        now,
      ),
      anchor: target != null
        ? { label: target, side: thread.anchor?.side ?? null }
        : null,
      body: thread.body ?? "",
      replies: (thread.replies ?? []).map((reply) => ({
        actor: actorLine(
          `${DocComments.authorLabel(reply.author)} replied`,
          reply.createdAt,
          null,
          now,
        ),
        body: reply.body ?? "",
      })),
    };
  }

  /** The quiet meta line: `you requested changes · 2h · Diff 1`. The revision
   *  pin is dropped rather than rendered as `Diff null` when the record does
   *  not carry one — legacy verdicts and every reply are in that case. */
  export function actorLine(
    label: string,
    at: number,
    revision: Option<number>,
    now: number,
  ): string {
    const parts = [label, RelativeTime.compact(at, now)];
    if (revision != null) parts.push(`Diff ${revision}`);
    return parts.join(" · ");
  }

  /** What a thread is attached to, for the anchor chip. `null` = the whole
   *  change (a commit-wide thread), which needs no chip because the region it
   *  sits in already says so.
   *
   *  Every field is read defensively. The note store is schema-agnostic by
   *  design — the server holds a thread as opaque JSON — so records written
   *  before a field existed simply lack it, whatever the TypeScript type
   *  promises. Records in the wild carry as little as
   *  `{id, author, body, createdAt, state}`, and a bare `thread.quote.trim()`
   *  took the whole change pane down with a TypeError on one of them. That is
   *  why this lives here and not in the DOM builder: one place to look for
   *  what the log assumes about a stored record, and one place to fix. */
  export function threadTarget(thread: Thread): Option<string> {
    if (thread.commitWide === true) return null;
    const label = thread.anchor?.label ?? "";
    if (label !== "") return label;
    const quote = (thread.quote ?? "").trim();
    if (quote !== "") {
      return `“${quote.length > 48 ? `${quote.slice(0, 48)}…` : quote}”`;
    }
    return "the note";
  }

  /** When did this happen — the sort key, and the value the actor line
   *  renders, normalized to millis.
   *
   *  The two stores disagree on unit and it is silent when you get it wrong:
   *  a note thread's `createdAt` is millis, while a diff comment's
   *  `created_at` and a verdict's `reviewed_at` are unix SECONDS. A missed
   *  conversion sorts the event to 1970 and labels it decades old. */
  export function eventAt(event: Event): number {
    if (event.kind === "verdict" || event.kind === "revision") return event.at;
    if (event.kind === "code") return event.comment.created_at * 1000;
    return event.thread.createdAt;
  }

  /** `Codex revised the change`, or impersonal legacy wording where capture
   *  carries no actor. Kept out of the component so the phrasing is one
   *  testable function rather than a branch inside a DOM builder. */
  export function revisionLabel(
    actor: Option<RevisionCompare.ActorRef>,
    trigger: Trigger,
  ): string {
    return Activity.revisionLabel(actor, trigger);
  }

  export function actorLabel(actor: RevisionCompare.ActorRef): string {
    return Activity.actorLabel(actor);
  }

  /** Collapse only adjacent structural activity. A comment or verdict is a
   *  chronology boundary, and an actor change is an accountability boundary.
   *  The initial observation always stands alone from later updates. */
  export function group(events: readonly Event[]): Entry[] {
    return Activity.group(events) as Entry[];
  }

  export function activitySummary(
    revisions: readonly RevisionEvent[],
    now: number,
  ): string {
    return Activity.summary(revisions, now);
  }

  export function revisionDetail(revision: RevisionEvent, now: number): string {
    return Activity.detail(revision, now);
  }

  /** Oldest first. Two events CAN share a timestamp — a verdict and the
   *  comment submitted with it are written in the same tick, and a diff
   *  comment is stamped in whole seconds so two in the same second collide by
   *  construction — so the order falls through to the kind rank and then to a
   *  stable key, never to the input order. */
  export function compare(a: Event, b: Event): number {
    const byTime = eventAt(a) - eventAt(b);
    if (byTime !== 0) return byTime;
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    return sortKey(a).localeCompare(sortKey(b));
  }

  /** A stable within-kind tie-break. Note threads have an id; diff comments
   *  have none, so their anchor stands in for one. */
  function sortKey(event: Event): string {
    if (event.kind === "comment") return event.thread.id;
    if (event.kind === "code") {
      return `${event.comment.file}:${
        String(event.comment.line).padStart(9, "0")
      }`;
    }
    // Revisions are captured in whole seconds too, and a burst of absorbs into
    // one draft can land two in the same second; `n` is monotonic, so it is the
    // only key here that is also the true order.
    if (event.kind === "revision") return String(event.n).padStart(9, "0");
    return "";
  }
}
