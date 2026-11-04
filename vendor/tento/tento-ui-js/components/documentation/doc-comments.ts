import { Tracing } from "@tento-core/tracing";
import { Uuid } from "@tento-core/uuid";

import { Position } from "../../anchor-positioning-utils";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Prosemirror } from "../../ui/prosemirror-import";
import { ContextMenu } from "../context-menu";

import { CommentCard } from "./comment-card";

import { DocComposer } from "./doc-composer";
import { DocCommentsPanel } from "./doc-comments-panel";
import { SelectToolbar } from "./doc-select-toolbar";

/**
 * Generic document-comment feature for `std-documentation` (opt-in per
 * instance). One modality: comments. An operator selects any passage — or
 * hovers a block's left-gutter handle — and comments on it → the comment
 * persists server-side (via an app-supplied {@link DocComments.Client}) where
 * an agent can `cat` it, revise the doc, and the operator completes it.
 *
 * This module does NO network IO itself — the app injects a `Client`. It lives
 * in tento-ui-js (the DOM layer) and must never import LonaApi / app code. The
 * PM runtime (Plugin / Decoration / DecorationSet) is reached through the shared
 * lazy loader (`Prosemirror.get()`), so no new dynamic import is introduced.
 */

// ── PM structural types (derived by indexed access from the real EditorView
//    type the tsconfig maps to the bundle .d.ts — no `any`) ─────────────────
type PmView = Prosemirror.EditorView;
type PmNode = PmView["state"]["doc"];
type PmTransaction = PmView["state"]["tr"];

// The DOM lib's `Selection` is shadowed by `DocComments.Selection` inside the
// namespace; alias the real DOM type here so the shadow-selection helpers can
// still name it.
type DomSelection = Selection;

const PREFIX_CONTEXT = 24;
const BLOCK_SEPARATOR = "\n";
const REPAINT_META = "doc-comments-repaint";

/**
 * One persisted comment — the single review modality (the old
 * highlight / block-flag split is gone). A comment anchors one of two ways:
 * when `blockIndex != null` it is anchored to a whole top-level block and
 * re-anchored by that block's full text ({@link DocComments.reAnchorBlock});
 * otherwise it is a text-range comment anchored by `quote`/`prefix`/`suffix`
 * ({@link DocComments.reAnchorInline}). `body` is the comment note (may be
 * empty only for a legacy highlight folded in as a note-less marking). Legacy
 * stored records carrying a `kind` discriminator
 * ("comment" | "highlight" | "block-flag") are normalized into this shape at
 * the single load boundary — see `normalizeComment`: a highlight keeps its
 * (empty) body and null `blockIndex` so it re-anchors as a text comment, a
 * block-flag keeps its `blockIndex` so it re-anchors as a block comment.
 */
export interface DocComment {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  blockIndex: Option<number>;
  body: string;
  /** Threaded operator↔agent replies, oldest first. Empty for an
   *  un-discussed comment; normalized to `[]` at the load boundary for
   *  comments persisted before threading shipped. */
  replies: readonly DocComments.DocReply[];
  resolved: boolean;
  createdAt: number;
  /** The root message's author identity — absent reads as `operator` (the
   *  legacy prose comments, all authored by the annotating operator). */
  author?: DocComments.Author;
  /** The thread's explicit lifecycle state, the server's primary signal
   *  (`doc_comments.rs::thread_state`): `open` | `addressed` | `resolved`. An
   *  unrecognized / absent value falls through to the `resolved` bool. */
  state?: Option<DocComments.ThreadState>;
  /** A commit-wide thread (the floating "Overall comment…" composer): no
   *  passage/line anchor — the card simply drops the quote row. */
  commitWide?: boolean;
  /** A structured anchor pin for the card-quote slot: a note passage
   *  (`note ¶3`) or a diff line (`src/store.rs:412`) with its side + the
   *  revision it was written against. Absent = the prose-excerpt quote. */
  anchor?: Option<DocComments.AnchorRef>;
}

export namespace DocComments {
  /** A review identity: the operator, or an agent voice. Legacy bare `agent`
   *  reads as the committing session (`agent/owner`); reviewer agents carry a
   *  namespaced id (`agent/security`, `agent/adversarial`, …). */
  export type Author = "operator" | "agent" | `agent/${string}`;

  /** The derived lifecycle state of a thread — mirrors the server
   *  (`doc_comments.rs::thread_state`). */
  export type ThreadState = "open" | "addressed" | "resolved";

  /** A structured thread anchor for the card-quote slot: a note passage or a
   *  diff line, plus the revision pin. */
  export interface AnchorRef {
    /** The passage/line label — `note ¶3`, `src/store.rs:412`. */
    label: string;
    /** The diff side for a line anchor (`old` | `new`); absent for a passage. */
    side?: Option<string>;
    /** The revision (Diff N) the thread was anchored on — the pin. */
    revision?: Option<number>;
  }

  /**
   * One threaded reply on a {@link DocComment}. Operator replies are appended
   * client-side (via the panel's inline composer); agent replies arrive
   * pre-written through `list()` — this module never writes an agent reply.
   */
  export interface DocReply {
    id: string;
    author: Author;
    body: string;
    createdAt: number;
    /** A resolution request: the diff (revision N) the author says fixes the
     *  thread. Renders the "☑ marked as addressed · fixed in diff N" row; a
     *  reply without it is a plain push-back that keeps the thread open. */
    addressedIn?: Option<number>;
  }

  // The comment-voice helpers live in `comment-card.ts` (the leaf both
  // hosts' `static $styles` depend on — see its header for the cycle this
  // breaks); these delegating exports keep the `DocComments.*` API every
  // caller already uses.
  export const authorLabel = CommentCard.authorLabel;
  export const authorInitial = CommentCard.authorInitial;
  export const authorColor = CommentCard.authorColor;
  export const threadState = CommentCard.threadState;

  /** Mint a commit-wide thread: a comment about the whole change, carrying no
   *  passage anchor and no quote because there is no passage to quote. Stored
   *  in the ordinary note store — `commitWide` is what keeps it out of the
   *  gutter and in the discussion region. */
  export function makeCommitWideComment(body: string, author: Author): DocComment {
    return {
      id: Uuid.make(),
      quote: "",
      prefix: "",
      suffix: "",
      blockIndex: null,
      body,
      replies: [],
      resolved: false,
      createdAt: Date.now(),
      author,
      commitWide: true,
      anchor: null,
    };
  }

  /**
   * The wire shape `Client.list()` yields: identical to {@link DocComment}
   * except `replies` may be absent (comments persisted before threading
   * shipped). {@link normalizeComment} fills it to a required `[]` — the one
   * stored→module normalization boundary in this module.
   */
  export type StoredComment = Omit<DocComment, "replies"> & {
    replies?: readonly DocReply[];
    /** Legacy discriminator from before the modality collapse
     *  ("comment" | "highlight" | "block-flag"). Read-ignored —
     *  `normalizeComment` drops it. */
    kind?: string;
  };

  /**
   * The upsert wire payload: a canonical {@link DocComment} plus one legacy
   * field. The old (still-running) server's typed upsert struct requires a
   * `kind` discriminator; the modality has collapsed to a single comment, so it
   * is always `"comment"`. The new server ignores it and `normalizeComment`
   * drops it on read. Sent as a `DocComment` through the client (an assignable
   * supertype), so the extra field simply rides along in the JSON body — the
   * app's `Client.upsert` needs no change.
   */
  export type UpsertWire = DocComment & { kind: "comment" };

  /**
   * The persistence surface the app supplies (backed by a TypedApi client in
   * the consuming page). `list()` MUST reject (throw) when the endpoint is
   * unreachable so the controller can render an offline state.
   */
  export interface Client {
    list(): Promise<StoredComment[]>;
    upsert(comment: DocComment): Promise<void>;
    remove(id: string): Promise<void>;
  }

  export interface Options {
    docId: string;
    client: Client;
  }

  /** A captured inline selection handed to the mini-toolbar / composer. */
  export interface Selection {
    from: number;
    to: number;
    quote: string;
    prefix: string;
    suffix: string;
    rect: DOMRect;
  }

  /** A resolved PM position span for an anchored annotation. */
  export interface Range {
    from: number;
    to: number;
  }

  // ── Anchoring ────────────────────────────────────────────────────────────

  interface DocText {
    text: string;
    /** `positions[i]` = the PM position immediately BEFORE text char `i`. */
    positions: number[];
  }

  /**
   * Flatten the doc into a single string plus a parallel array mapping each
   * character back to its PM position. Block boundaries emit a `\n` sentinel
   * (its position is the block's start) so prefix/suffix context can span
   * blocks; only quote endpoints need exact positions, and those are real text
   * characters. Mirrors how `link-click.ts` walks node positions, generalized
   * to the whole document.
   */
  function buildDocText(doc: PmNode): DocText {
    let text = "";
    const positions: number[] = [];
    doc.descendants((node: PmNode, pos: number) => {
      if (node.isText) {
        const t = node.text ?? "";
        for (let k = 0; k < t.length; k++) {
          text += t[k];
          positions.push(pos + k);
        }
        return false;
      }
      if (node.isBlock && text.length > 0 && !text.endsWith(BLOCK_SEPARATOR)) {
        text += BLOCK_SEPARATOR;
        positions.push(pos);
      }
      return true;
    });
    return { text, positions };
  }

  /** The top-level blocks, in document order, with their PM ranges + text. */
  export interface TopBlock {
    index: number;
    from: number;
    to: number;
    typeName: string;
    text: string;
  }

  export function topBlocks(doc: PmNode): TopBlock[] {
    const out: TopBlock[] = [];
    let index = 0;
    doc.forEach((node: PmNode, offset: number) => {
      // A block's flag quote is its text; an atom insert node (interactive
      // demo) has no text, so we key it by its schema type name — a stable,
      // deterministic re-anchor handle.
      const raw = node.textContent;
      const text = raw.length > 0 ? raw : node.type.name;
      out.push({
        index,
        from: offset,
        to: offset + node.nodeSize,
        typeName: node.type.name,
        text,
      });
      index++;
    });
    return out;
  }

  /** Index of the first position `>= target`, or `text.length` if none. */
  function charIndexFor(positions: number[], target: number): number {
    for (let i = 0; i < positions.length; i++) {
      if (positions[i] >= target) return i;
    }
    return positions.length;
  }

  /** Capture anchoring context from a live inline selection. */
  export function captureSelection(doc: PmNode, from: number, to: number): {
    quote: string;
    prefix: string;
    suffix: string;
  } {
    const { text, positions } = buildDocText(doc);
    const qs = charIndexFor(positions, from);
    const qe = charIndexFor(positions, to);
    return {
      quote: text.slice(qs, qe),
      prefix: text.slice(Math.max(0, qs - PREFIX_CONTEXT), qs),
      suffix: text.slice(qe, qe + PREFIX_CONTEXT),
    };
  }

  function rangeFromCharSpan(
    positions: number[],
    qs: number,
    qe: number,
  ): Option<Range> {
    if (qe <= qs || qs >= positions.length) return null;
    const lastChar = Math.min(qe, positions.length) - 1;
    return { from: positions[qs], to: positions[lastChar] + 1 };
  }

  function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      count++;
      idx = haystack.indexOf(needle, idx + 1);
    }
    return count;
  }

  /**
   * Re-anchor an inline annotation against the current doc. Search order:
   *   1. exact `prefix + quote + suffix`,
   *   2. `quote` alone if it occurs exactly once,
   *   3. normalized-whitespace unique match,
   * else unanchored (`null`).
   */
  export function reAnchorInline(doc: PmNode, comment: DocComment): Option<Range> {
    if (comment.quote.length === 0) return null;
    const { text, positions } = buildDocText(doc);

    const full = comment.prefix + comment.quote + comment.suffix;
    const fullIdx = text.indexOf(full);
    if (fullIdx !== -1) {
      const qs = fullIdx + comment.prefix.length;
      return rangeFromCharSpan(positions, qs, qs + comment.quote.length);
    }

    if (countOccurrences(text, comment.quote) === 1) {
      const qs = text.indexOf(comment.quote);
      return rangeFromCharSpan(positions, qs, qs + comment.quote.length);
    }

    return reAnchorNormalized(text, positions, comment.quote);
  }

  /** Whitespace-normalized fallback: collapse runs of whitespace, keep an
   *  index map back to the original text, require a unique match. */
  function reAnchorNormalized(
    text: string,
    positions: number[],
    quote: string,
  ): Option<Range> {
    let norm = "";
    const map: number[] = [];
    let inWhitespace = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        if (inWhitespace) continue;
        inWhitespace = true;
        norm += " ";
        map.push(i);
      } else {
        inWhitespace = false;
        norm += ch;
        map.push(i);
      }
    }
    const normQuote = quote.replace(/\s+/g, " ").trim();
    if (normQuote.length === 0) return null;
    if (countOccurrences(norm, normQuote) !== 1) return null;

    const start = norm.indexOf(normQuote);
    const qs = map[start];
    const endNorm = start + normQuote.length - 1;
    const qe = map[Math.min(endNorm, map.length - 1)] + 1;
    return rangeFromCharSpan(positions, qs, qe);
  }

  /** Re-anchor a block comment by matching the block's full text (with a
   *  `blockIndex` tiebreak when several blocks share the same text). */
  export function reAnchorBlock(doc: PmNode, comment: DocComment): Option<Range> {
    const blocks = topBlocks(doc);
    const matches = blocks.filter((b) => b.text === comment.quote);
    if (matches.length === 0) return null;
    if (matches.length === 1) return { from: matches[0].from, to: matches[0].to };
    const byIndex =
      comment.blockIndex != null
        ? matches.find((b) => b.index === comment.blockIndex)
        : null;
    const chosen = byIndex ?? matches[0];
    return { from: chosen.from, to: chosen.to };
  }

  // ── Anchored range (paint model) ─────────────────────────────────────────

  export interface Anchored {
    comment: DocComment;
    range: Option<Range>;
  }

  export function reAnchor(doc: PmNode, comment: DocComment): Anchored {
    // A block comment carries a `blockIndex`; a text comment does not.
    const range =
      comment.blockIndex != null
        ? reAnchorBlock(doc, comment)
        : reAnchorInline(doc, comment);
    return { comment, range };
  }

  /** The single stored→module normalization boundary. Drops the legacy `kind`
   *  discriminator (the modality collapsed to one comment) and fills `replies`
   *  for records persisted before threading shipped. Building the result field
   *  by field keeps the phantom `kind` off the in-memory comment; a stored
   *  highlight (no `blockIndex`) re-anchors as a text comment and a stored
   *  block-flag (with `blockIndex`) re-anchors as a block comment. */
  export function normalizeComment(stored: StoredComment): DocComment {
    const replies: readonly DocReply[] = Array.isArray(stored.replies)
      ? stored.replies
      : [];
    return {
      id: stored.id,
      quote: stored.quote,
      prefix: stored.prefix,
      suffix: stored.suffix,
      blockIndex: stored.blockIndex,
      body: stored.body,
      replies,
      resolved: stored.resolved,
      createdAt: stored.createdAt,
      // Thread-rail fields ride through untouched when present (opaque wire).
      author: stored.author,
      state: stored.state,
      commitWide: stored.commitWide,
      anchor: stored.anchor,
    };
  }

  /**
   * If PM position `pos` sits inside a `code_block`, the node's boundary range
   * (`$pos.before`/`$pos.after` at the code_block's depth), else `null`. Fenced
   * code renders through an atom `std-code` nodeView, so an inline decoration
   * inside it paints nothing — a code annotation must be repainted as a node
   * decoration over the whole block. Depth starts at 1 because a code_block is
   * never the doc root (and `before(0)` would throw).
   */
  export function codeBlockAround(doc: PmNode, pos: number): Option<Range> {
    const $pos = doc.resolve(pos);
    for (let depth = $pos.depth; depth >= 1; depth--) {
      if ($pos.node(depth).type.name === "code_block") {
        return { from: $pos.before(depth), to: $pos.after(depth) };
      }
    }
    return null;
  }

  // ── Code-block shadow selection ──────────────────────────────────────────
  //
  // Fenced code renders through an atom nodeView (`std-code`) with NO
  // contentDOM: the visible text lives in the component's SHADOW root, so a DOM
  // selection there never reaches `view.state.selection`. These helpers recover
  // such a selection and map it back onto the code_block's real PM text
  // positions (the doc DOES hold the code as ordinary text), so highlight /
  // comment works on code exactly as it does on prose.

  /** Chromium exposes a per-shadow-root `getSelection()` (nonstandard, absent
   *  from the DOM lib types) — model it as an augmentation of `ShadowRoot` so we
   *  can feature-detect it without an `any` cast. Extending the base type (vs a
   *  lone optional member) keeps it out of weak-type-mismatch territory. */
  interface ShadowRootWithSelection extends ShadowRoot {
    getSelection?: () => DomSelection | null;
  }

  /** DOM library versions differ on whether this recent API is declared.
   *  Omit its native declaration before adding the optional capability so both
   *  versions type-check, while browsers without it retain the fallback. */
  type SelectionWithComposedRanges = Omit<DomSelection, "getComposedRanges"> & {
    getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
  };

  /** A non-collapsed DOM selection inside a shadow root, normalized to plain
   *  container/offset pairs plus a viewport rect for toolbar placement. */
  interface ShadowSelection {
    startContainer: Node;
    startOffset: number;
    endContainer: Node;
    endOffset: number;
    rect: DOMRect;
  }

  /** A code-block selection resolved to PM positions + a placement rect. */
  export interface CodeSelection {
    from: number;
    to: number;
    rect: DOMRect;
  }

  /** The `std-code` host on the event's composed path that lives inside this
   *  editor's DOM (guards against picking up an unrelated component). */
  function findCodeHost(view: PmView, event: MouseEvent): Option<Element> {
    for (const target of event.composedPath()) {
      if (
        target instanceof Element &&
        target.tagName === "STD-CODE" &&
        view.dom.contains(target)
      ) {
        return target;
      }
    }
    return null;
  }

  /**
   * Read a non-collapsed selection out of a `std-code` shadow root. Chrome takes
   * the primary `shadowRoot.getSelection()` path; the composed-ranges path is
   * the standards fallback — its `StaticRange` carries no rect, so we rebuild a
   * live `Range` over the same endpoints for `getBoundingClientRect()`.
   */
  function readShadowSelection(shadowRoot: ShadowRoot): Option<ShadowSelection> {
    const withSelection: ShadowRootWithSelection = shadowRoot;
    const shadowSel = withSelection.getSelection?.();
    if (shadowSel && shadowSel.rangeCount > 0) {
      const range = shadowSel.getRangeAt(0);
      if (
        !range.collapsed &&
        shadowRoot.contains(range.startContainer) &&
        shadowRoot.contains(range.endContainer)
      ) {
        return {
          startContainer: range.startContainer,
          startOffset: range.startOffset,
          endContainer: range.endContainer,
          endOffset: range.endOffset,
          rect: range.getBoundingClientRect(),
        };
      }
    }

    const docSel: Option<SelectionWithComposedRanges> = document.getSelection();
    if (!docSel) return null;
    const ranges = docSel.getComposedRanges?.({
      shadowRoots: [shadowRoot],
    });
    if (!ranges || ranges.length === 0) return null;
    const sr = ranges[0];
    if (
      sr.collapsed ||
      !shadowRoot.contains(sr.startContainer) ||
      !shadowRoot.contains(sr.endContainer)
    ) {
      return null;
    }
    const live = document.createRange();
    try {
      live.setStart(sr.startContainer, sr.startOffset);
      live.setEnd(sr.endContainer, sr.endOffset);
    } catch (err) {
      Tracing.warn("ui")("doc-comments/shadow-range failed", {
        error: String(err),
      });
      return null;
    }
    return {
      startContainer: sr.startContainer,
      startOffset: sr.startOffset,
      endContainer: sr.endContainer,
      endOffset: sr.endOffset,
      rect: live.getBoundingClientRect(),
    };
  }

  /**
   * Walk a shadow root's text nodes in document order, concatenating their text
   * and locating the selection's start/end as offsets into that string.
   * Syntax-highlight spans split the code into many text nodes; the walk
   * stitches them back. Pure over the DOM — exported so the offset math can be
   * unit-tested. Returns `null` when either endpoint is not a walked text node.
   */
  export function shadowTextOffsets(
    root: ShadowRoot,
    sel: {
      startContainer: Node;
      startOffset: number;
      endContainer: Node;
      endOffset: number;
    },
  ): Option<{ text: string; start: number; end: number }> {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = "";
    let start: Option<number> = null;
    let end: Option<number> = null;
    let node = walker.nextNode();
    while (node) {
      if (node === sel.startContainer) start = text.length + sel.startOffset;
      if (node === sel.endContainer) end = text.length + sel.endOffset;
      text += node.textContent ?? "";
      node = walker.nextNode();
    }
    if (start == null || end == null || end <= start) return null;
    return { text, start, end };
  }

  /**
   * Locate the `code_block` PM node whose nodeView dom is `host`, then map the
   * shadow-space `[start, end)` selection onto real PM text positions.
   * CodeMirror renders each line as a block and drops the inter-line `\n`s that
   * PM keeps in `node.textContent`, so the direct offset only holds when the
   * block's text matches at that span; otherwise we fall back to a UNIQUE
   * substring match of the selected text (safe: a non-unique match is dropped
   * rather than mis-anchored). Never throws.
   */
  function resolveCodeBlockRange(
    view: PmView,
    host: Element,
    shadowText: string,
    start: number,
    end: number,
  ): Option<Range> {
    const quote = shadowText.slice(start, end);
    if (quote.length === 0) return null;
    let found: Option<Range> = null;
    view.state.doc.descendants((node: PmNode, pos: number) => {
      if (found) return false;
      if (node.type.name !== "code_block") return true;
      if (view.nodeDOM(pos) !== host) return true;
      const nodeText = node.textContent;
      if (nodeText.slice(start, end) === quote) {
        found = { from: pos + 1 + start, to: pos + 1 + end };
      } else if (countOccurrences(nodeText, quote) === 1) {
        const idx = nodeText.indexOf(quote);
        found = { from: pos + 1 + idx, to: pos + 1 + idx + quote.length };
      }
      return false;
    });
    return found;
  }

  /** Full capture for a selection made inside a fenced code block: find the
   *  `std-code` host on the event path, read its shadow selection, and resolve
   *  it to PM positions. `null` when there is no usable code selection. */
  export function captureCodeSelection(
    view: PmView,
    event: MouseEvent,
  ): Option<CodeSelection> {
    const host = findCodeHost(view, event);
    if (!host) return null;
    const shadowRoot = host.shadowRoot;
    if (!shadowRoot) return null;
    const sel = readShadowSelection(shadowRoot);
    if (!sel) return null;
    const offsets = shadowTextOffsets(shadowRoot, sel);
    if (!offsets) return null;
    const range = resolveCodeBlockRange(
      view,
      host,
      offsets.text,
      offsets.start,
      offsets.end,
    );
    if (!range) return null;
    return { from: range.from, to: range.to, rect: sel.rect };
  }

  // ── Controller ───────────────────────────────────────────────────────────

  /**
   * Orchestrates the whole flow for one document: builds the PM plugin (handed
   * to the editor via its new `plugins` prop), loads + re-anchors persisted
   * comments, paints decorations, drives the selection mini-toolbar / composer /
   * left-gutter comment handle, and owns the side panel. Kept out of
   * `Documentation` so that component stays thin.
   */
  export class Controller {
    private readonly options: Options;
    private view: Option<PmView> = null;

    private anchored: Anchored[] = [];
    private blocks: TopBlock[] = [];
    private loadFailed = false;

    private readonly $panel: DocCommentsPanel = DocCommentsPanel.make();
    private readonly $toolbar: SelectToolbar = SelectToolbar.make();
    private readonly $composer: DocComposer = DocComposer.make();
    private $handle: Option<HTMLElement> = null;

    private activeSelection: Option<Selection> = null;
    private hoverBlock: Option<TopBlock> = null;

    /** Fixed-position floats registered for scroll tracking: each entry pins
     *  the float's applied position to the doc rect measured in the same
     *  frame, so {@link trackFloats} can translate it as the doc moves. */
    private readonly floatOrigins = new Map<
      HTMLElement,
      { left: number; top: number; viewLeft: number; viewTop: number }
    >();
    private trackRaf: Option<number> = null;

    constructor(options: Options) {
      this.options = options;
      // The panel's gutter cell stretches to the doc height (grid
      // `align-self: stretch`), so a doc reflow surfaces as a panel size
      // change. On that change recompute the anchor ys — only the controller
      // can read them off the live PM view — and re-bind. Wired here, before
      // the page mounts the panel, so the base ResizeObserver arms on connect.
      this.$panel.onRelayout = () => this.renderPanel();
      document.addEventListener("pointerdown", this.onDocPointerDown, true);
    }

    /** Build the PM plugin. Constructed from the loaded module so `Plugin`
     *  and the decoration classes are the same instances the view uses. */
    async makePlugin(): Promise<Prosemirror.Plugin> {
      const { Plugin, Decoration, DecorationSet } = await Prosemirror.get();
      return new Plugin({
        props: {
          decorations: (state) => {
            const decos = this.decoRanges(state.doc).map((r) =>
              r.deco === "node"
                ? Decoration.node(r.from, r.to, { class: r.class })
                : Decoration.inline(r.from, r.to, { class: r.class }),
            );
            return DecorationSet.create(state.doc, decos);
          },
          handleDOMEvents: {
            // The event is threaded through so a selection made inside a
            // `std-code` shadow root (which never reaches `view.state.selection`)
            // can be recovered from its composed path — see `onMouseUp`.
            mouseup: (view, event) => {
              this.onMouseUp(view, event);
              return false;
            },
          },
        },
        view: (editorView) => {
          this.attachView(editorView);
          return {
            destroy: () => this.detachView(),
          };
        },
      });
    }

    /** Element the page mounts into its gutter. Typed as the panel rather than
     *  a bare element so the owner can wire the panel's own hooks
     *  (`onEmptyChange`) without narrowing. */
    panelElement(): DocCommentsPanel {
      return this.$panel;
    }

    /** Anchored comments flattened to decoration specs (decoration type +
     *  range + resolved CSS class). Pure — the plugin closure builds the actual
     *  Decoration/DecorationSet from the loaded module. A block comment paints
     *  as a NODE decoration over the whole block. A text comment paints as an
     *  inline underline, unless it lands inside a `code_block`: PM renders
     *  nothing inside that atom `std-code` nodeView, so an inline decoration
     *  there would paint nothing — repaint it as a NODE decoration on the host. */
    private decoRanges(doc: PmNode): Array<{
      deco: "node" | "inline";
      from: number;
      to: number;
      class: string;
    }> {
      const out: Array<{
        deco: "node" | "inline";
        from: number;
        to: number;
        class: string;
      }> = [];
      for (const entry of this.anchored) {
        const { comment, range } = entry;
        if (!range) continue;
        const resolved = comment.resolved ? " doc-annot--resolved" : "";
        if (comment.blockIndex != null) {
          out.push({
            deco: "node",
            from: range.from,
            to: range.to,
            class: `doc-comment--block${resolved}`,
          });
          continue;
        }
        const block = codeBlockAround(doc, range.from);
        if (block) {
          out.push({
            deco: "node",
            from: block.from,
            to: block.to,
            class: `doc-comment--block${resolved}`,
          });
        } else {
          out.push({
            deco: "inline",
            from: range.from,
            to: range.to,
            class: `doc-comment${resolved}`,
          });
        }
      }
      return out;
    }

    /** Load persisted annotations and paint. Degrades to an offline panel
     *  (empty + composer disabled) when the API is unreachable. */
    async load(): Promise<void> {
      const view = this.view;
      if (!view) return;
      try {
        const stored = await this.options.client.list();
        this.loadFailed = false;
        // Normalize each stored record (drop the legacy `kind`, default the
        // `replies` thread to `[]`) before re-anchoring.
        this.anchored = stored.map((c) =>
          reAnchor(view.state.doc, normalizeComment(c)),
        );
      } catch (err) {
        this.loadFailed = true;
        this.anchored = [];
        Tracing.warn("net")("doc-comments/list failed", {
          docId: this.options.docId,
          error: String(err),
        });
      }
      this.repaint();
      this.renderPanel();
    }

    private attachView(view: PmView): void {
      this.view = view;
      this.blocks = topBlocks(view.state.doc);
      view.dom.addEventListener("mousemove", this.onMouseMove);
      view.dom.addEventListener("mouseleave", this.onMouseLeave);
    }

    private detachView(): void {
      const view = this.view;
      if (view) {
        view.dom.removeEventListener("mousemove", this.onMouseMove);
        view.dom.removeEventListener("mouseleave", this.onMouseLeave);
      }
      this.view = null;
    }

    /** Tear down floating UI + listeners (called from Documentation). */
    destroy(): void {
      this.detachView();
      document.removeEventListener("pointerdown", this.onDocPointerDown, true);
      this.stopTracking();
      this.floatOrigins.clear();
      this.$toolbar.remove();
      this.$composer.remove();
      this.$handle?.remove();
      this.$handle = null;
      this.$panel.remove();
      this.activeSelection = null;
      this.hoverBlock = null;
    }

    // ── Floating-UI lifecycle (outside-click dismiss + scroll tracking) ────

    /** Dismiss the toolbar/composer on any pointer press outside them (the
     *  Notion gesture). Capture phase + `composedPath` so a press inside any
     *  shadow root still resolves containment against the body-appended
     *  floats. Presses inside the handle cluster are inside a float too — its
     *  buttons open the composer themselves. */
    private onDocPointerDown = (event: Event): void => {
      if (!this.$toolbar.isConnected && !this.$composer.isConnected) return;
      const path = event.composedPath();
      if (path.includes(this.$toolbar) || path.includes(this.$composer)) return;
      if (this.$handle != null && path.includes(this.$handle)) return;
      this.dismissToolbar();
      this.$composer.remove();
    };

    /** Pin a float's just-applied `style.left/top` to the doc rect measured in
     *  the same frame, and make sure the tracking loop is running. */
    private registerFloat($el: HTMLElement): void {
      const view = this.view;
      if (!view) return;
      const base = view.dom.getBoundingClientRect();
      this.floatOrigins.set($el, {
        left: parseFloat($el.style.left) || 0,
        top: parseFloat($el.style.top) || 0,
        viewLeft: base.left,
        viewTop: base.top,
      });
      this.ensureTracking();
    }

    private ensureTracking(): void {
      if (this.trackRaf == null) {
        this.trackRaf = requestAnimationFrame(this.trackFloats);
      }
    }

    private stopTracking(): void {
      if (this.trackRaf != null) cancelAnimationFrame(this.trackRaf);
      this.trackRaf = null;
    }

    /** Follow the doc while it scrolls. The floats are viewport-fixed but
     *  their anchors live in the doc — and the pane that scrolls this doc is
     *  inside a shadow root, whose `scroll` events are non-composed, so a
     *  document-level scroll listener never hears it. Instead, while any float
     *  is visible, poll each frame and translate every visible float by the
     *  doc rect's movement since its position was registered. Rigid
     *  translation (not re-anchoring) stays exact for the code-shadow
     *  selection case, whose rect cannot be recomputed via `coordsAtPos`. The
     *  loop parks itself once nothing is visible. */
    private trackFloats = (): void => {
      this.trackRaf = null;
      const view = this.view;
      if (!view) return;
      const cur = view.dom.getBoundingClientRect();
      let anyVisible = false;
      for (const [$el, origin] of this.floatOrigins) {
        if (!$el.isConnected || $el.style.display === "none") continue;
        anyVisible = true;
        $el.style.left = `${origin.left + (cur.left - origin.viewLeft)}px`;
        $el.style.top = `${origin.top + (cur.top - origin.viewTop)}px`;
      }
      if (!anyVisible) return;
      this.trackRaf = requestAnimationFrame(this.trackFloats);
    };

    // ── Selection mini-toolbar ─────────────────────────────────────────────

    private onMouseUp(view: PmView, event: MouseEvent): void {
      if (this.loadFailed) {
        this.dismissToolbar();
        return;
      }
      const sel = view.state.selection;
      if (!sel.empty) {
        const start = view.coordsAtPos(sel.from);
        const end = view.coordsAtPos(sel.to);
        const rect = new DOMRect(
          Math.min(start.left, end.left),
          Math.min(start.top, end.top),
          Math.abs(end.right - start.left),
          Math.abs(end.bottom - start.top),
        );
        this.presentSelection(view, sel.from, sel.to, rect);
        return;
      }
      // An empty PM selection can still be a real DOM selection made inside a
      // fenced code block: `std-code` is an atom nodeView with no contentDOM, so
      // a selection in its shadow root never maps into `view.state.selection`.
      // Recover it from the shadow root and map it onto the block's real text.
      const code = captureCodeSelection(view, event);
      if (!code) {
        this.dismissToolbar();
        return;
      }
      this.presentSelection(view, code.from, code.to, code.rect);
    }

    /** Shared tail for the inline and code-shadow capture paths: anchor the
     *  `[from, to]` span, stash it as the active selection, and pop the
     *  mini-toolbar at `rect`. */
    private presentSelection(
      view: PmView,
      from: number,
      to: number,
      rect: DOMRect,
    ): void {
      const anchor = captureSelection(view.state.doc, from, to);
      if (anchor.quote.trim().length === 0) {
        this.dismissToolbar();
        return;
      }
      this.activeSelection = {
        from,
        to,
        quote: anchor.quote,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        rect,
      };
      this.showToolbar(rect);
    }

    private showToolbar(rect: DOMRect): void {
      if (!this.$toolbar.isConnected) document.body.appendChild(this.$toolbar);
      this.$toolbar.bind({
        onComment: () => this.openComposerForSelection(),
      });
      this.$toolbar.positionAt(rect.left, rect.top - 8);
      this.registerFloat(this.$toolbar);
    }

    private dismissToolbar(): void {
      this.activeSelection = null;
      this.$toolbar.remove();
    }

    private openComposerForSelection(): void {
      const sel = this.activeSelection;
      if (!sel) return;
      this.$toolbar.remove();
      this.showComposer(sel.rect, (body) => this.commitActiveSelection(body));
    }

    /** Commit a text-range comment from the active selection. Body is required
     *  (empty/whitespace submit is a no-op — the composer stays open, matching
     *  reply behavior); the single modality is always a comment. */
    private commitActiveSelection(body: string): void {
      const sel = this.activeSelection;
      if (!sel) return;
      const trimmed = body.trim();
      if (trimmed.length === 0) return;
      const comment: DocComment = {
        id: Uuid.make(),
        quote: sel.quote,
        prefix: sel.prefix,
        suffix: sel.suffix,
        blockIndex: null,
        body: trimmed,
        replies: [],
        resolved: false,
        createdAt: Date.now(),
      };
      this.addAndPersist(comment, { from: sel.from, to: sel.to });
      this.dismissToolbar();
      this.$composer.remove();
    }

    // ── Composer ───────────────────────────────────────────────────────────

    private showComposer(rect: DOMRect, onSubmit: (body: string) => void): void {
      if (!this.$composer.isConnected) document.body.appendChild(this.$composer);
      this.$composer.bind({
        onCancel: () => this.$composer.remove(),
        onSubmit: (body) => {
          onSubmit(body);
        },
      });
      this.$composer.positionAt(rect.left, rect.bottom + 8);
      this.registerFloat(this.$composer);
      this.$composer.focusInput();
    }

    // ── Gutter comment handle (Notion-style) ───────────────────────────────
    //
    // A subtle handle in the LEFT margin of the hovered top-level block, aligned
    // to the block's first line (like Notion's drag handle). Click it to comment
    // on the whole block. Same hover machinery as the old flag affordance
    // (posAtCoords → this.blocks); appearing only on block hover is the whole
    // subtlety budget — once summoned it renders at full strength.

    private onMouseMove = (event: MouseEvent): void => {
      const view = this.view;
      if (!view || this.loadFailed) return;
      const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
      if (!hit) {
        this.hideHandle();
        return;
      }
      const block = this.blocks.find((b) => hit.pos >= b.from && hit.pos < b.to);
      if (!block) {
        this.hideHandle();
        return;
      }
      this.hoverBlock = block;
      this.showHandle(view, block);
    };

    private onMouseLeave = (event: MouseEvent): void => {
      // Keep the handle alive when the pointer moves onto the handle itself.
      const related = event.relatedTarget;
      if (related instanceof Node && this.$handle?.contains(related)) return;
      this.hideHandle();
    };

    /** One 22×22 button of the gutter cluster. Styled inline with global
     *  color tokens (the cluster is body-appended, outside every shadow
     *  scope); quiet fill, brightening under the pointer. */
    private makeHandleButton(
      glyph: string,
      title: string,
      onClick: () => void,
    ): HTMLElement {
      const $btn = document.createElement("button");
      $btn.type = "button";
      $btn.textContent = glyph;
      $btn.title = title;
      $btn.style.display = "flex";
      $btn.style.alignItems = "center";
      $btn.style.justifyContent = "center";
      $btn.style.width = "22px";
      $btn.style.height = "22px";
      $btn.style.padding = "0px";
      $btn.style.borderRadius = "6px";
      $btn.style.border = "1px solid transparent";
      $btn.style.background = "transparent";
      $btn.style.color = "var(--text-sec)";
      $btn.style.fontSize = "15px";
      $btn.style.lineHeight = "1";
      $btn.style.cursor = "pointer";
      $btn.style.transition = "background 120ms ease, color 120ms ease";
      // Hover brighten. mouseenter/leave are hover, not a click gesture, so
      // they stay native (GESTURE_MANAGER owns the click below).
      $btn.addEventListener("mouseenter", () => {
        $btn.style.background = "var(--bg-hover-light, var(--bg-surface))";
        $btn.style.color = "var(--text-pri)";
      });
      $btn.addEventListener("mouseleave", () => {
        $btn.style.background = "transparent";
        $btn.style.color = "var(--text-sec)";
      });
      GESTURE_MANAGER.addPointerEvent($btn, { onClick });
      return $btn;
    }

    /** The Notion-style block cluster — `+` (comment on the block) beside `⋯`
     *  (block overflow menu) — in the block's left margin. Body-appended
     *  (escapes any transformed ancestor for viewport-fixed positioning), so
     *  it sits outside every shadow scope and is styled inline. */
    private ensureHandle(): HTMLElement {
      if (this.$handle) return this.$handle;
      const $handle = document.createElement("div");
      $handle.className = "doc-comment-handle";
      $handle.style.position = "fixed";
      $handle.style.zIndex = "2147483000";
      $handle.style.display = "none";
      $handle.style.alignItems = "center";
      $handle.style.gap = "1px";
      $handle.style.padding = "1px";
      $handle.style.borderRadius = "7px";
      $handle.style.border = "1px solid var(--divider)";
      $handle.style.background = "var(--bg-elevated)";
      $handle.style.boxShadow = "0 1px 4px rgba(0, 0, 0, 0.08)";
      $handle.append(
        this.makeHandleButton("+", "Comment on this block", () =>
          this.commentHoverBlock(),
        ),
        this.makeHandleButton("⋯", "Block actions", () => this.openBlockMenu()),
      );
      document.body.appendChild($handle);
      this.$handle = $handle;
      return $handle;
    }

    /** The `⋯` overflow menu for the hovered block. The block is captured at
     *  open time so a later hover change cannot retarget the menu's actions.
     *  `ContextMenu` positions off a viewport point (see openCardMenu's note). */
    private openBlockMenu(): void {
      const block = this.hoverBlock;
      const $handle = this.$handle;
      if (!block || !$handle) return;
      const rect = $handle.getBoundingClientRect();
      ContextMenu.builder(180)
        .cellRow("Comment on block", null, () =>
          this.showComposer(rect, (body) => this.commitBlockComment(block, body)),
        )
        .cellRow("Copy block text", null, () => {
          void navigator.clipboard?.writeText(block.text);
        })
        .buildAndReveal($handle, {
          position: Position.fromPoint({ x: rect.left, y: rect.bottom + 6 }),
        });
    }

    private showHandle(view: PmView, block: TopBlock): void {
      const dom = view.nodeDOM(block.from);
      if (!(dom instanceof Element)) return;
      const rect = dom.getBoundingClientRect();
      const $handle = this.ensureHandle();
      // In the block's left margin, aligned to its first line — wide enough
      // for both buttons, clamped so a narrow margin never clips it off.
      $handle.style.left = `${Math.max(4, rect.left - 56)}px`;
      $handle.style.top = `${rect.top - 1}px`;
      $handle.style.display = "flex";
      this.registerFloat($handle);
    }

    private hideHandle(): void {
      if (this.$handle) this.$handle.style.display = "none";
      this.hoverBlock = null;
    }

    /** Open the composer at the handle and, on submit, commit a block comment
     *  on the hovered block. The block is captured at click time so a later
     *  hover change cannot retarget the in-flight composer. */
    private commentHoverBlock(): void {
      const block = this.hoverBlock;
      if (!block) return;
      const $handle = this.$handle;
      const rect = $handle
        ? $handle.getBoundingClientRect()
        : new DOMRect(0, 0, 0, 0);
      this.showComposer(rect, (body) => this.commitBlockComment(block, body));
    }

    /** Commit a comment anchored to a whole block. Body is required
     *  (empty/whitespace submit is a no-op — the composer stays open, matching
     *  reply behavior). */
    private commitBlockComment(block: TopBlock, body: string): void {
      const trimmed = body.trim();
      if (trimmed.length === 0) return;
      const comment: DocComment = {
        id: Uuid.make(),
        quote: block.text,
        prefix: "",
        suffix: "",
        blockIndex: block.index,
        body: trimmed,
        replies: [],
        resolved: false,
        createdAt: Date.now(),
      };
      this.addAndPersist(comment, { from: block.from, to: block.to });
      this.hideHandle();
      this.$composer.remove();
    }

    // ── Persistence + paint ────────────────────────────────────────────────

    private addAndPersist(comment: DocComment, range: Range): void {
      this.anchored = [...this.anchored, { comment, range }];
      this.repaint();
      this.renderPanel();
      void this.persist(comment);
    }

    private async persist(comment: DocComment): Promise<void> {
      try {
        // Emit the legacy `kind: "comment"` wire field: the old still-running
        // server's typed upsert struct requires it (the new server ignores it,
        // and `normalizeComment` drops it on read). `UpsertWire` is an
        // assignable supertype of `DocComment`, so the field rides along in the
        // JSON body with no change to the app's `Client`.
        const wire: UpsertWire = { ...comment, kind: "comment" };
        await this.options.client.upsert(wire);
      } catch (err) {
        Tracing.warn("net")("doc-comments/upsert failed", {
          docId: this.options.docId,
          id: comment.id,
          error: String(err),
        });
      }
    }

    private toggleResolved(id: string): void {
      this.anchored = this.anchored.map((entry) =>
        entry.comment.id === id
          ? {
              ...entry,
              comment: { ...entry.comment, resolved: !entry.comment.resolved },
            }
          : entry,
      );
      const entry = this.anchored.find((e) => e.comment.id === id);
      this.repaint();
      this.renderPanel();
      if (entry) void this.persist(entry.comment);
    }

    /** Append an operator reply to a thread and persist the whole comment via
     *  the existing `upsert` path. Empty/whitespace-only bodies are a no-op
     *  (the inline composer stays open). Replies never move an anchor or a
     *  decoration, so only the panel re-renders — no `repaint()`. */
    private appendReply(id: string, body: string): void {
      const trimmed = body.trim();
      if (trimmed.length === 0) return;
      const reply: DocReply = {
        id: Uuid.make(),
        author: "operator",
        body: trimmed,
        createdAt: Date.now(),
      };
      this.anchored = this.anchored.map((entry) =>
        entry.comment.id === id
          ? {
              ...entry,
              comment: {
                ...entry.comment,
                replies: [...entry.comment.replies, reply],
              },
            }
          : entry,
      );
      const entry = this.anchored.find((e) => e.comment.id === id);
      this.renderPanel();
      if (entry) void this.persist(entry.comment);
    }

    private async removeAnnotation(id: string): Promise<void> {
      this.anchored = this.anchored.filter((e) => e.comment.id !== id);
      this.repaint();
      this.renderPanel();
      try {
        await this.options.client.remove(id);
      } catch (err) {
        Tracing.warn("net")("doc-comments/remove failed", {
          docId: this.options.docId,
          id,
          error: String(err),
        });
      }
    }

    private repaint(): void {
      const view = this.view;
      if (!view) return;
      const tr: PmTransaction = view.state.tr.setMeta(REPAINT_META, true);
      view.dispatch(tr);
    }

    private scrollTo(id: string): void {
      const view = this.view;
      const entry = this.anchored.find((e) => e.comment.id === id);
      if (!view || !entry?.range) return;
      const dom = view.domAtPos(entry.range.from).node;
      const $el = dom instanceof Element ? dom : dom.parentElement;
      $el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    private renderPanel(): void {
      this.$panel.bind({
        items: this.panelItems(),
        offline: this.loadFailed,
        onResolve: (id) => this.toggleResolved(id),
        onRemove: (id) => void this.removeAnnotation(id),
        onScrollTo: (id) => this.scrollTo(id),
        onReply: (id, body) => this.appendReply(id, body),
      });
    }

    /** Pair every anchored comment with its panel-relative y-offset (see
     *  {@link anchorY}). The panel rect is read once here so every comment's y
     *  is measured against the same panel top in the same frame. */
    private panelItems(): DocCommentsPanel.Item[] {
      const view = this.view;
      const panelTop = this.$panel.getBoundingClientRect().top;
      return this.anchored.map((anchored) => ({
        anchored,
        y: this.anchorY(view, anchored, panelTop),
      }));
    }

    /** The y-offset (px, panel-relative) of an anchored comment's anchor top,
     *  or `null` when the comment is unanchored or there is no live view. The
     *  anchor's viewport top (`coordsAtPos(range.from).top`, valid for both a
     *  text range and a whole-block range) and the panel top are read in the
     *  same frame, so their difference is scroll-independent — the panel gutter
     *  and the doc share the page scroll, so both move together. */
    private anchorY(
      view: Option<PmView>,
      anchored: Anchored,
      panelTop: number,
    ): Option<number> {
      if (!view || !anchored.range) return null;
      try {
        return view.coordsAtPos(anchored.range.from).top - panelTop;
      } catch (err) {
        // `coordsAtPos` can throw for a position transiently out of range mid
        // reflow; treat as not-yet-placeable rather than crashing the render.
        Tracing.warn("ui")("doc-comments/coords failed", {
          id: anchored.comment.id,
          error: String(err),
        });
        return null;
      }
    }
  }
}
