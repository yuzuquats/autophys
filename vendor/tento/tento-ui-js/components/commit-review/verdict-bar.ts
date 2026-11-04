import "../round";
import "../editable-text";

import { Tracing } from "@tento-core/tracing";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LonaIcons, XIcon } from "../../ui/icons";
import { EditableText } from "../editable-text";

const SUMMARY_PLACEHOLDER = "Overall comment on this commit…";

// The floating verdict UI: collapsed it is a bar showing the status dot plus
// the summary clamped to two lines; clicked, it morphs into the full comment
// card (summary editor + approve / request-changes). Persistence is the
// owner's job — `onSubmit` resolves with the saved review, which the bar then
// re-binds and collapses back on.
//
// A statically-sized anchor (the host, sized by the in-flow expanded card)
// holds a bottom-pinned std-round surface plus two stacked content layers.
// The Round owns the surface entirely — squircle corners, fill, and
// drop-shadow. Expanding transitions the Round's HEIGHT; its internal
// squircle (no-transition by default) regenerates the rounded path each frame
// to match, so the morph needs no clip-path or border-radius CSS from us. The
// Round is absolutely positioned, so resizing it relayouts nothing else: the
// anchor and both content layers (which just crossfade) never move.

@component({ name: "std-verdict-bar" })
export class VerdictBar extends LonaWebComponent {
  private $collapsed: HTMLElement = this.$("collapsed-layer");
  private $statusDot: HTMLElement = this.$("status-dot");
  private $summaryPreview: HTMLElement = this.$("summary-preview");
  private $pill: HTMLElement = this.$("pill");
  private $time: HTMLElement = this.$("time");
  private $summary: EditableText = this.hydrate("summary");
  private $inputSurface: HTMLElement = this.$("input-surface");
  private $btnApprove: HTMLElement = this.$("btn-approve");
  private $btnRequest: HTMLElement = this.$("btn-request");
  private $btnComment: HTMLElement = this.$("btn-comment");
  private $btnClose: HTMLElement = this.$("btn-close");
  private $mirrorNote: HTMLElement = this.$("mirror-note");
  private $error: HTMLElement = this.$("error");

  /** Set by the owner: persist a verdict, resolve with the saved review. */
  onSubmit: Option<(review: VerdictBar.NewReview) => Promise<VerdictBar.Review>> = null;

  /** Set through {@link setCommentSink}: persist a body with NO verdict. */
  private commentSink: Option<(body: string) => Promise<void>> = null;

  /** Set through {@link setMirroredFrom}: the host a mirrored draft was
   *  replayed from. Non-null puts the bar in read-only mode. */
  private mirroredFrom: Option<string> = null;

  private expanded = false;
  private collapsedRo: Option<ResizeObserver>;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$btnApprove, {
      onClick: () => void this.submit("approved"),
    });
    GESTURE_MANAGER.addPointerEvent(this.$btnRequest, {
      onClick: () => void this.submit("changes_requested"),
    });
    GESTURE_MANAGER.addPointerEvent(this.$btnComment, {
      onClick: () => void this.comment(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$collapsed, {
      onClick: () => this.setExpanded(true),
    });
    GESTURE_MANAGER.addPointerEvent(this.$btnClose, {
      onClick: () => this.setExpanded(false),
    });
    GESTURE_MANAGER.addPointerEvent(this.$inputSurface, {
      onClick: () => this.$summary.controller.focus(),
    });
    this.$btnClose.appendChild(LonaIcons.$svg(XIcon));
    // Editable without stealing focus (chat-composer pattern); plain Enter
    // blurs, Shift+Enter inserts a newline.
    this.$summary.bind(null, SUMMARY_PLACEHOLDER);
    this.$summary.enableEditing(false);
    // The editable-text controller lets Escape bubble (it swallows other keys).
    this.$summary.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.setExpanded(false);
    });
    // The collapsed bar hugs its clamped preview text (1 vs 2 lines); the
    // surface's collapsed height tracks the measured height via --collapsed-h.
    this.collapsedRo = new ResizeObserver(() => {
      const h = this.$collapsed.offsetHeight;
      if (h > 0) this.style.setProperty("--collapsed-h", `${h}px`);
    });
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.collapsedRo?.observe(this.$collapsed);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.collapsedRo?.disconnect();
  }

  // Report the current verdict — the status dot, the pill and the timestamp.
  // NOT the summary prose: the discussion log records that now, and a composer
  // pre-filled with text already on the record is an invitation to post it a
  // second time. The bar WRITES, the log READS; this is that split applied to
  // the bar's own contents.
  //
  // Clearing the draft here is not housekeeping, it is a correctness step. The
  // bar is a hydrated singleton the pane reuses across selections, so an
  // uncleared box would follow the reader onto the next change and `Comment`
  // would file their half-typed thought against the wrong commit.
  bind(review: VerdictBar.Review): void {
    this.clearError();
    this.clearDraft();
    this.$pill.className = `pill ${review.status}`;
    this.$pill.textContent = VerdictBar.STATUS_LABEL[review.status];
    this.$statusDot.dataset.status = review.status;
    this.$time.textContent =
      review.reviewed_at > 0 ? new Date(review.reviewed_at * 1000).toLocaleString() : "";
    this.syncPreview();
  }

  // Expand the bar into the comment card / collapse it back. Only the
  // std-round surface animates (its height) plus layer opacity — the anchor
  // and both content layers never move, so nothing relayouts.
  private setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.syncPreview();
    this.toggleAttribute("expanded", expanded);
    if (expanded) this.$summary.controller.focus();
  }

  /** Empty the composer and mirror that into the collapsed preview. Every path
   *  that finishes with the bar ends here — bind, comment, and (through bind)
   *  approve / request-changes — so there is exactly one answer to "what is in
   *  the box after something is submitted": nothing. */
  private clearDraft(): void {
    this.$summary.bindText(null);
    this.syncPreview();
  }

  /** A rejected write must be visible where the reviewer acted. Network and
   *  record-identity failures used to exist only in tracing, so the buttons
   *  re-enabled and an Approve click appeared to do literally nothing. */
  private showError(error: unknown, fallback: string): void {
    const detail =
      error == null ? "" : error instanceof Error ? error.message.trim() : String(error).trim();
    this.$error.textContent = detail === "" ? fallback : `${fallback}: ${detail}`;
    this.$error.toggleAttribute("hidden", false);
  }

  private clearError(): void {
    this.$error.textContent = "";
    this.$error.toggleAttribute("hidden", true);
  }

  // Mirror the (possibly unsaved) summary draft into the collapsed preview.
  //
  // A mirrored selection has no composer to mirror, so the bar spends its one
  // line of prose on the only thing left to say: where the real draft lives.
  // Carried in the placeholder register (`.empty` — italic, tertiary) because
  // it is chrome, not somebody's words.
  private syncPreview(): void {
    if (this.mirroredFrom != null) {
      this.$summaryPreview.textContent = VerdictBar.mirrorNotice(this.mirroredFrom);
      this.$summaryPreview.classList.toggle("empty", true);
      return;
    }
    const draft = (this.$summary.text ?? "").trim();
    this.$summaryPreview.textContent = draft.length > 0 ? draft : SUMMARY_PLACEHOLDER;
    this.$summaryPreview.classList.toggle("empty", draft.length === 0);
  }

  /** The bound draft's `Mirrored-From:` source, or null for a draft this host
   *  owns. Non-null makes the bar READ-ONLY: the composer and all three
   *  actions go away and a one-line notice takes their place, because a
   *  verdict cast here would land in this host's `.reviews/` store and never
   *  reach the machine the work is actually being done on.
   *
   *  Same shape as {@link setCommentSink} — the owner declares what the
   *  selection can support and the bar withholds the controls it cannot back,
   *  rather than offering a button that writes into the void. The submit paths
   *  re-check the flag: hiding a control is presentation, and the refusal is
   *  the contract. */
  setMirroredFrom(source: Option<string>): void {
    this.mirroredFrom = source;
    this.toggleAttribute("mirrored", source != null);
    this.$mirrorNote.textContent = source != null ? VerdictBar.mirrorNotice(source) : "";
    // A reader who had the card open on their own draft must not be left
    // staring at an empty card when the selection moves to a mirrored one.
    if (source != null) this.setExpanded(false);
    this.syncPreview();
  }

  /** The commit-wide comment sink, and whether the action is offered at all.
   *  Null hides the button: the queue, foreign and sha-keyed surfaces have no
   *  note store to write a thread into, and a button that cannot write is
   *  worse than no button. */
  setCommentSink(sink: Option<(body: string) => Promise<void>>): void {
    this.commentSink = sink;
    this.$btnComment.toggleAttribute("hidden", sink == null);
  }

  // Comment: say something about the change WITHOUT casting a verdict. This is
  // the producer `commitWide` was declared for and never had — an agent
  // answering a change request finally has somewhere to put the answer that is
  // neither a passage it is not about nor the next commit message.
  //
  // The verdict is untouched, so unlike `submit` there is nothing to re-bind:
  // the body is cleared and the bar collapses, and the owner's reload brings
  // the new thread back through the discussion region.
  private async comment(): Promise<void> {
    const sink = this.commentSink;
    if (sink == null || this.mirroredFrom != null) {
      this.showError(null, "This selection cannot accept comments here");
      return;
    }
    const body = (this.$summary.text ?? "").trim();
    if (body === "") return;
    this.clearError();
    this.$btnComment.toggleAttribute("disabled", true);
    try {
      await sink(body);
      this.clearDraft();
      this.setExpanded(false);
    } catch (e) {
      Tracing.err("net")("submit comment failed", e);
      this.showError(e, "Comment was not saved");
    } finally {
      this.$btnComment.toggleAttribute("disabled", false);
    }
  }

  // Approve / request-changes: hand the verdict + summary to the owner, then
  // reflect the saved review and collapse back to the bar. `bind` empties the
  // composer, so a submitted summary does not sit there afterwards looking like
  // an unsent draft — it is on the record, and the log is where it reads.
  private async submit(status: VerdictBar.Status): Promise<void> {
    const onSubmit = this.onSubmit;
    // A mirrored draft is read-only here even if a stale keystroke or a
    // programmatic caller reaches this path — see setMirroredFrom.
    if (onSubmit == null || this.mirroredFrom != null) {
      this.showError(null, "This selection cannot be reviewed here");
      return;
    }
    const summary = (this.$summary.text ?? "").trim();
    this.clearError();
    this.$btnApprove.toggleAttribute("disabled", true);
    this.$btnRequest.toggleAttribute("disabled", true);
    try {
      const review = await onSubmit({ status, summary });
      this.bind(review);
      this.setExpanded(false);
    } catch (e) {
      Tracing.err("net")("submit review failed", e);
      this.showError(e, "Verdict was not saved");
    } finally {
      this.$btnApprove.toggleAttribute("disabled", false);
      this.$btnRequest.toggleAttribute("disabled", false);
    }
  }

  static $styles = [
    css`
      /* The host is the statically-sized anchor (always expanded-card-sized);
         it must never eat pointer events itself — only the currently-active
         layer opts back in. The owner positions + shows/hides the host. */
      :host {
        display: block;
        pointer-events: none;
        --collapsed-h: 64px;
      }
      #surface {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: var(--collapsed-h);
        pointer-events: none;
        transition: height 0.28s ease;
        /* The squircle anchors its animating path to the box's top-left;
           flipping the (vertically symmetric) surface puts that anchor at
           the visual bottom, so the morph grows upward from the bottom
           edge. The shadow offset in the markup is negated to compensate. */
        transform: scaleY(-1);
      }
      :host([expanded]) #surface {
        height: 100%;
      }
      /* Expanded card: the in-flow layer that defines the anchor's size. */
      #expanded-layer {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px 14px;
        box-sizing: border-box;
        opacity: 0;
        transform: translateY(6px);
        pointer-events: none;
        transition: opacity 0.16s ease, transform 0.16s ease;
      }
      :host([expanded]) #expanded-layer {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
        transition-delay: 0.1s;
      }
      /* Collapsed bar content: status dot + clamped summary preview. */
      #collapsed-layer {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 16px 18px;
        min-height: 56px;
        box-sizing: border-box;
        cursor: pointer;
        pointer-events: auto;
        transition: opacity 0.12s ease 0.14s;
      }
      :host([expanded]) #collapsed-layer {
        opacity: 0;
        pointer-events: none;
        transition-delay: 0s;
      }
      #status-dot {
        flex-shrink: 0;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--text-ter);
      }
      #status-dot[data-status="approved"] {
        background: var(--green);
      }
      #status-dot[data-status="changes_requested"] {
        background: var(--orange);
      }
      #summary-preview {
        flex: 1;
        font-size: 13px;
        line-height: 16px;
        color: var(--text-pri);
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #summary-preview.empty {
        color: var(--text-ter);
        font-style: italic;
      }
      #head {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #head-spacer {
        flex: 1;
      }
      .ibtn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: none;
        color: var(--text-ter);
        cursor: pointer;
      }
      .ibtn:hover {
        background: var(--bg-hover-light);
        color: var(--text-pri);
      }
      .ibtn svg {
        width: 14px;
        height: 14px;
      }
      .pill {
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--divider);
        color: var(--text-ter);
      }
      .pill.approved {
        color: var(--green);
        border-color: var(--green);
      }
      .pill.changes_requested {
        color: var(--orange);
        border-color: var(--orange);
      }
      #time {
        font-size: 11px;
        color: var(--text-ter);
      }
      #input-surface {
        width: 100%;
        cursor: text;
      }
      #summary {
        width: 100%;
        min-height: 96px;
        box-sizing: border-box;
        color: var(--text-pri);
        --padding-inline: 10px;
        --padding-block: 8px;
      }
      #actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      #error {
        color: var(--red, #c43d3d);
        font-size: 12px;
        line-height: 16px;
      }
      #error[hidden] {
        display: none;
      }
      /* Hidden where the selection has no note store — see setCommentSink. */
      #btn-comment[hidden] {
        display: none;
      }
      /* Comment casts no verdict, so it reads quieter than the two that do. */
      #btn-comment {
        margin-right: auto;
        color: var(--text-sec);
      }
      .rbtn {
        padding: 6px 14px;
        border-radius: 6px;
        border: 1px solid var(--divider);
        background: var(--bg-elevated);
        color: var(--text-pri);
        font-size: 13px;
        cursor: pointer;
      }
      .rbtn.primary {
        background: var(--green);
        border-color: var(--green);
        color: #fff;
      }
      .rbtn[disabled] {
        opacity: 0.5;
        cursor: default;
      }
      /* Read-only (mirrored) mode: the composer and the whole action row are
         removed from the card — not disabled. A greyed-out Approve still
         reads as "you could vote here if you tried harder", and this host
         genuinely cannot. What is left is the verdict the source host has
         recorded (pill + time, still true and still worth reading) plus one
         line saying where to go instead. */
      :host([mirrored]) #input-surface,
      :host([mirrored]) #actions {
        display: none;
      }
      #mirror-note {
        display: none;
        font-size: 12px;
        line-height: 16px;
        color: var(--text-ter);
        font-style: italic;
      }
      :host([mirrored]) #mirror-note {
        display: block;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-round id="surface" bg="var(--bg-elevated)"
      radius="24" shadow="0 -2px 10px var(--black12)"></std-round>
    <div id="expanded-layer">
      <div id="head">
        <span id="pill" class="pill pending">not reviewed</span>
        <span id="time"></span>
        <span id="head-spacer"></span>
        <button id="btn-close" type="button" class="ibtn" title="Collapse"></button>
      </div>
      <std-round id="input-surface" bg="var(--bg-surface-light)" radius="10">
        <std-editable-text id="summary"></std-editable-text>
      </std-round>
      <div id="mirror-note"></div>
      <div id="error" role="status" hidden></div>
      <div id="actions">
        <button id="btn-comment" type="button" class="rbtn">Comment</button>
        <button id="btn-request" type="button" class="rbtn">Request changes</button>
        <button id="btn-approve" type="button" class="rbtn primary">Approve</button>
      </div>
    </div>
    <div id="collapsed-layer">
      <span id="status-dot" data-status="pending"></span>
      <span id="summary-preview" class="empty">Overall comment on this commit…</span>
    </div>
  `;
}

// The viewmodel: an overall review verdict, mirroring the commit-review
// service's review.json wire shape so pages bind wire objects directly.
export namespace VerdictBar {
  export type Status = "pending" | "approved" | "changes_requested";

  export type Review = {
    status: Status;
    summary: string;
    reviewed_at: number;
    /** The revision (Diff N) this verdict was written against — places a
     * `changes_requested` on the revision strip. Absent on legacy records. */
    revision?: Option<number>;
  };

  export type NewReview = {
    status: Status;
    summary: string;
  };

  /** The one line a mirrored draft gets instead of verdict controls. One
   *  definition, because the collapsed bar and the expanded card both say it
   *  and they must not drift into two different explanations of the same
   *  refusal. */
  export function mirrorNotice(source: string): string {
    return `mirrored from ${source} — review it at the source`;
  }

  export const STATUS_LABEL: Record<Status, string> = {
    pending: "not reviewed",
    approved: "approved",
    changes_requested: "changes requested",
  };
}
