import { RelativeTime } from "@tento-chrono";

import { Position } from "../../anchor-positioning-utils";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { Avatar } from "../avatar";
import { ContextMenu } from "../context-menu";
import { ListCellLayout } from "../list/list-cell-layout";

import type { DocComment, DocComments } from "./doc-comments";

// The ONE comment card (plan-reader rev 2 — "one thread card, both homes").
// Extracted from DocCommentsPanel so a second host — the diff view's inline
// thread rows — renders the same anatomy: avatar + `you · 2d` attribution,
// optional quote / structured anchor pin, body, threaded replies behind a
// hairline, and the hover-revealed verb line.
//
// A pure factory returning `div.thread-card`, NOT a custom element, on
// purpose: the panel's collision layout reaches INTO the card from outside —
// it reads `offsetHeight`, re-selects `.thread-card.positioned`, stamps
// `style.top` and `data-anchor-y` on the root — and a shadow boundary would
// break every one of those. The markup travels as a factory and the CSS as an
// exported fragment each host adds to its own `static $styles` (the
// `LonaCardHeader.$style` idiom).
//
// Every affordance is an `Option` callback, and absence means ABSENT — no
// dead chrome: a host whose wire has no replies passes `onReply: null` and
// the card grows no verb line entry and no composer; all-null callbacks
// render attribution + body alone (the diff host's shape).

export namespace CommentCard {
  export interface ViewModel {
    /** The thread root, replies and lifecycle riding on it — the doc-comment
     * vocabulary, which a host with a flatter wire synthesizes into (the
     * `Discussion.row` precedent). */
    comment: DocComment;
    /** One clock per host render, so a list of cards agrees with itself. */
    now: number;
    /** Render the prose-excerpt quote row (stacked/tail contexts). Anchored
     * cards sit beside their highlighted passage and skip it; structured
     * `anchor` pins always render regardless. */
    showQuote: boolean;
    /** Dim the card (the resolved tail). */
    faded: boolean;
    /** Quote/anchor-pin click — scroll to the passage. Null = not clickable. */
    onScrollTo: Option<EmptyFunction>;
    /** Reply verb + inline composer. Null = neither exists. */
    onReply: Option<(body: string) => void>;
    /** Resolve/Reopen verb (label from `comment.resolved`). The HOST applies
     * any operator gate by passing null for a non-operator viewer. */
    onResolve: Option<EmptyFunction>;
    /** "View fix · interdiff" verb, offered on addressed threads. */
    onViewFix: Option<EmptyFunction>;
    /** The ⋯ overflow menu (Delete). Null = no button at all. */
    onRemove: Option<EmptyFunction>;
    /** The card's height changed (reply composer opened/closed) — an
     * absolutely-positioning host relayouts its siblings. */
    onLayoutChange: Option<EmptyFunction>;
  }

  // ── the comment voice ──────────────────────────────────────────────────
  // Author identity + thread lifecycle, moved here from `DocComments` (which
  // now delegates) so this module is a LEAF: the panel reads
  // `CommentCard.$styles` at class-definition time, so this module must be
  // fully evaluated before the panel — which means it cannot value-import
  // `doc-comments` (whose import graph includes the panel). Types still come
  // from `doc-comments` as type-only imports, which erase.

  /** The agent id of an author (`agent/security` → `security`), or null for
   *  the operator / the bare-owner voices. */
  function agentId(author: DocComments.Author): Option<string> {
    if (author === "operator" || author === "agent") return null;
    const id = author.slice("agent/".length);
    return id === "owner" ? null : id;
  }

  /** A short attribution label: `you` (operator), `claude` (the owner agent),
   *  `<id>-agent` (a reviewer agent). */
  export function authorLabel(author: DocComments.Author): string {
    if (author === "operator") return "you";
    const id = agentId(author);
    return id != null ? `${id}-agent` : "claude";
  }

  /** The avatar initial (uppercase) for an author identity. */
  export function authorInitial(author: DocComments.Author): string {
    const label = authorLabel(author);
    return (label.charAt(0) || "?").toUpperCase();
  }

  /** A stable avatar background per identity: operator = blue, the owner agent
   *  = orange (reserved), every other reviewer agent a stable hue hashed from
   *  its id (so a voice keeps one colour across a thread and across renders). */
  export function authorColor(author: DocComments.Author): string {
    if (author === "operator") return "var(--blue-dimmed)";
    const id = agentId(author);
    if (id == null) return "var(--orange-dimmed)";
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    // Skip the orange band (reserved for the owner) by rotating past it.
    const hue = ((Math.abs(hash) % 300) + 40) % 360;
    return `hsl(${hue} 42% 52%)`;
  }

  /** The derived lifecycle state of a thread: the server's explicit `state`
   *  when recognized, else the `resolved` bool, else `addressed` when a reply
   *  carries `addressedIn`, else `open`. */
  export function threadState(comment: DocComment): DocComments.ThreadState {
    const s = comment.state;
    if (s === "open" || s === "addressed" || s === "resolved") return s;
    if (comment.resolved) return "resolved";
    if (comment.replies.some((r) => r.addressedIn != null)) return "addressed";
    return "open";
  }

  export function make(vm: ViewModel): HTMLElement {
    const { comment } = vm;
    const $card = document.createElement("div");
    const classes = ["thread-card"];
    if (vm.faded) classes.push("thread-card--faded");
    $card.className = classes.join(" ");

    // The card-quote slot. A structured anchor (a diff line / note passage
    // with its revision pin) always renders — it is a compact pin, not the
    // prose excerpt. A commit-wide thread has no quote at all — otherwise it
    // is the plain card (a wash treatment was reviewed and rejected).
    if (comment.commitWide !== true) {
      if (comment.anchor != null) {
        $card.appendChild($anchorPin(comment.anchor, vm.onScrollTo));
      } else if (vm.showQuote && comment.quote.trim().length > 0) {
        // An empty quote earns no row at all — a bare `“”` line is noise, and
        // the card's flattened first-message inset handles the spacing.
        const $quote = document.createElement("div");
        $quote.className = "card-quote";
        const $quoteText = Typography.text(excerpt(comment));
        $quoteText.className = "card-quote-text";
        $quote.appendChild($quoteText);
        const onScrollTo = vm.onScrollTo;
        if (onScrollTo != null) {
          $quote.classList.add("clickable");
          GESTURE_MANAGER.addPointerEvent($quote, { onClick: () => onScrollTo() });
        }
        $card.appendChild($quote);
      }
    }

    $card.appendChild(
      $message(
        comment.author ?? "operator",
        comment.createdAt,
        comment.body,
        vm.now,
        vm.onRemove != null ? $dots(vm.onRemove) : null,
      ),
    );

    // Replies are plain prose rows — a resolution request included. Its
    // claim renders once, as the state line at the card's foot; a body-less
    // claim (the Gerrit "Done" shape) adds no empty message row at all.
    const shown = comment.replies.filter((r) => !(r.addressedIn != null && r.body.length === 0));
    if (shown.length > 0) {
      const $replies = document.createElement("div");
      $replies.className = "card-replies";
      for (const reply of shown) {
        $replies.appendChild($message(reply.author, reply.createdAt, reply.body, vm.now, null));
      }
      $card.appendChild($replies);
    }

    // The thread-frame state (the GitLab shape: "addressed by … in diff N"
    // on the frame, never a badge inside a reply bubble — three decorated
    // forms were reviewed and rejected). Latest claim wins.
    const fix = [...comment.replies].reverse().find((r) => r.addressedIn != null);
    if (fix != null && fix.addressedIn != null) {
      $card.appendChild($stateLine(fix.author, fix.addressedIn, vm.onViewFix));
    }

    const $actions = $actionLine(vm);
    if ($actions != null) $card.appendChild($actions);
    return $card;
  }

  /** The structured anchor pin in the card-quote slot: a diff-line / note
   *  passage label (`src/store.rs:412`, `note ¶3`) with an optional side and
   *  the revision it was written against (`new · diff 4`). */
  function $anchorPin(
    anchor: DocComments.AnchorRef,
    onScrollTo: Option<EmptyFunction>,
  ): HTMLElement {
    const $pin = document.createElement("div");
    $pin.className = "card-quote card-anchor";
    const $label = Typography.text(anchor.label);
    $label.className = "anchor-label";
    $pin.appendChild($label);
    const pins: string[] = [];
    if (anchor.side != null && anchor.side !== "") pins.push(anchor.side);
    if (anchor.revision != null) pins.push(`diff ${anchor.revision}`);
    if (pins.length > 0) {
      const $meta = Typography.text(pins.join(" · "));
      $meta.className = "anchor-meta";
      $pin.appendChild($meta);
    }
    if (onScrollTo != null) {
      $pin.classList.add("clickable");
      GESTURE_MANAGER.addPointerEvent($pin, { onClick: () => onScrollTo() });
    }
    return $pin;
  }

  /** The thread's addressed state, as one quiet system sentence at the
   *  card's foot — `addressed by claude in diff 5` — hairline-separated from
   *  the conversation. `diff N` is the interdiff link when the host wires
   *  `onViewFix`; without it the sentence is inert (absence means absent). */
  function $stateLine(
    author: DocComments.Author,
    revision: number,
    onViewFix: Option<EmptyFunction>,
  ): HTMLElement {
    const $line = document.createElement("div");
    $line.className = "state-line";
    const $lead = Typography.text(`addressed by ${authorLabel(author)} in`);
    $lead.className = "state-text";
    $line.appendChild($lead);
    const $ref = Typography.text(`diff ${revision}`);
    $ref.className = "state-ref";
    if (onViewFix != null) {
      $ref.classList.add("clickable");
      GESTURE_MANAGER.addPointerEvent($ref, { onClick: () => onViewFix() });
    }
    $line.appendChild($ref);
    return $line;
  }

  /** One message — the root comment or a reply — in the shared shell: a stock
   *  {@link ListCellLayout} attribution row (author avatar + `you · 2d`) over
   *  the body. The content column carries a min-height so rows with and
   *  without an accessory land at the same height. */
  function $message(
    author: DocComments.Author,
    createdAt: number,
    body: string,
    now: number,
    $accessory: Option<HTMLElement>,
  ): HTMLElement {
    const $row = document.createElement("div");
    $row.className = "message";
    const metaText = `${authorLabel(author)} · ${RelativeTime.compact(createdAt, now)}`;
    const $head = ListCellLayout.makeText(metaText, {
      $icon: $avatar(author),
      $accessory: $accessory ?? undefined,
      size: "default",
      contentMargin: "0px",
      justify: "center",
    });
    $head.classList.add("message-head-cell");
    $row.appendChild($head);
    if (body.length > 0) {
      const $body = Typography.text(body);
      $body.className = "message-body";
      $row.appendChild($body);
    }
    return $row;
  }

  /** The author avatar in the attribution row's icon slot: a 20px shadowless
   *  initial circle, a stable color per identity. */
  function $avatar(author: DocComments.Author): HTMLElement {
    return Avatar.makeWithInitials({
      initials: authorInitial(author),
      backgroundColor: authorColor(author),
      color: "var(--text-sec-on-solid)",
      size: "20",
      shadow: false,
    });
  }

  /** The persistent ⋯ overflow button; clicking reveals the overflow
   *  {@link ContextMenu} (just "Delete" for now). */
  function $dots(onRemove: EmptyFunction): HTMLElement {
    const $btn = document.createElement("button");
    $btn.type = "button";
    $btn.className = "card-dots";
    $btn.title = "More";
    $btn.textContent = "⋯";
    GESTURE_MANAGER.addPointerEvent($btn, {
      onClick: () => {
        // `ContextMenu` positions as `position: fixed`, so it takes a viewport
        // POINT aligned under the button's right edge (the anchored Position.*
        // constants are transform/edge-based and render off-screen here).
        const rect = $btn.getBoundingClientRect();
        ContextMenu.builder(140)
          .cellRow("Delete", null, () => onRemove())
          .buildAndReveal($btn, {
            position: Position.fromPoint({
              x: Math.max(4, rect.right - 140),
              y: rect.bottom + 6,
            }),
          });
      },
    });
    return $btn;
  }

  /** The action line: quiet dot-separated verb links, hidden until the card
   *  is hovered / focused. Renders NOTHING (returns null) when no verb is
   *  wired — an all-null host gets no dead hover chrome. */
  function $actionLine(vm: ViewModel): Option<HTMLElement> {
    const $line = document.createElement("div");
    $line.className = "card-actions";
    const parts: HTMLElement[] = [];

    const onReply = vm.onReply;
    if (onReply != null) {
      parts.push($verb("Reply", () => openReplyComposer($line, onReply, vm.onLayoutChange)));
    }
    // No View fix verb here: the fix PIN on the addressed reply carries the
    // interdiff affordance inline — a second hover-only copy is noise.
    const onResolve = vm.onResolve;
    if (onResolve != null) {
      parts.push($verb(vm.comment.resolved ? "Reopen" : "Resolve", () => onResolve()));
    }
    if (parts.length === 0) return null;

    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        const $dot = Typography.text("·");
        $dot.className = "dot";
        $line.appendChild($dot);
      }
      $line.appendChild(parts[i]);
    }
    return $line;
  }

  /** Swap the verb line for the inline reply composer. Cancel restores the
   *  verbs in place; Send routes through `onReply` (the host re-renders, so
   *  the composer is discarded). Both paths fire `onLayoutChange` — opening
   *  grows the card, and an absolutely-positioning host must push siblings. */
  function openReplyComposer(
    $line: HTMLElement,
    onReply: (body: string) => void,
    onLayoutChange: Option<EmptyFunction>,
  ): void {
    const $card = $line.parentElement;
    if (!$card) return;
    const $composer = $replyComposer(
      (body) => {
        onReply(body);
        onLayoutChange?.();
      },
      () => {
        $composer.remove();
        $line.style.display = "";
        $card.classList.remove("thread-card--editing");
        onLayoutChange?.();
      },
    );
    $line.style.display = "none";
    $card.classList.add("thread-card--editing");
    $card.insertBefore($composer, $line.nextSibling);
    const $ta = $composer.querySelector("textarea");
    $ta?.focus();
    onLayoutChange?.();
  }

  /** A minimal inline reply composer: a borderless textarea inside a 1px
   *  divider frame with quiet Cancel / Send text links. */
  function $replyComposer(
    onSend: (body: string) => void,
    onCancel: EmptyFunction,
  ): HTMLElement {
    const $composer = document.createElement("div");
    $composer.className = "reply-composer";

    const $ta = document.createElement("textarea");
    $ta.className = "reply-input";
    $ta.rows = 2;
    $ta.placeholder = "Reply…";
    $composer.appendChild($ta);

    const $row = document.createElement("div");
    $row.className = "composer-actions";
    const $cancel = $verb("Cancel", () => onCancel());
    $cancel.classList.add("verb--quiet");
    const $send = $verb("Send", () => onSend($ta.value));
    $row.append($cancel, $send);
    $composer.appendChild($row);
    return $composer;
  }

  function $verb(label: string, onClick: EmptyFunction): HTMLElement {
    const $v = Typography.text(label);
    $v.className = "verb";
    GESTURE_MANAGER.addPointerEvent($v, { onClick: () => onClick() });
    return $v;
  }

  const EXCERPT_LEN = 80;

  function excerpt(comment: DocComment): string {
    const marker = comment.blockIndex != null ? "¶ " : "";
    const q = comment.quote.replace(/\s+/g, " ").trim();
    if (q.length <= EXCERPT_LEN) return `${marker}${q}`;
    return `${marker}${q.slice(0, EXCERPT_LEN)}…`;
  }

  /** The card-anatomy styles, added by each HOST to its own `static $styles`
   *  (the `LonaCardHeader.$style` idiom) — the card renders in whatever
   *  shadow root its host mounts it in. Host-owned layout rules
   *  (`.thread-card.positioned` sizing, tails, sections) stay with the host. */
  export const $styles = css`
    .thread-card {
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px 18px;
      border: 1px solid var(--divider);
      border-radius: 12px;
      background: var(--bg);
    }

    .thread-card--faded {
      opacity: 0.6;
    }

    .thread-card--editing {
      z-index: 1;
    }

    .card-dots {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--text-ter);
      font-size: var(--text-10px);
      line-height: 1;
      cursor: pointer;
    }

    .card-dots:hover {
      background: var(--hover-color);
      color: var(--text-pri);
    }

    .card-quote {
      min-width: 0;
      padding-left: 8px;
      padding-block: 4px;
      border-left: 2px solid color-mix(in srgb, var(--blue) 45%, transparent);
    }

    .card-quote.clickable {
      cursor: pointer;
    }

    .card-quote-text {
      --font-size: var(--text-10px);
      --line-height-ratio: 1.4;
      --margin-top: 0px;
      --margin-bottom: 0px;
      font-style: italic;
      color: var(--text-sec);
    }

    .card-quote-text::before {
      content: "“";
    }

    .card-quote-text::after {
      content: "”";
    }

    .card-quote.clickable:hover .card-quote-text {
      color: var(--blue);
    }

    /* Structured anchor pin (diff line / note passage + revision pin): the
       label reads as a code handle, the pins as quiet mono metadata. */
    .card-anchor {
      display: flex;
      align-items: baseline;
      gap: 6px;
      flex-wrap: wrap;
    }

    .anchor-label {
      --font-size: var(--text-9px);
      --line-height-ratio: 1.4;
      --margin-top: 0px;
      --margin-bottom: 0px;
      font-family: var(--mono, monospace);
      color: var(--text-sec);
    }

    .card-anchor.clickable:hover .anchor-label {
      color: var(--blue);
    }

    .anchor-meta {
      --font-size: var(--text-8px);
      --line-height-ratio: 1.4;
      --margin-top: 0px;
      --margin-bottom: 0px;
      font-family: var(--mono, monospace);
      color: var(--text-ter);
    }

    /* The addressed state line at the card's foot — thread-frame state, one
       quiet sentence over a hairline. */
    .state-line {
      display: flex;
      align-items: baseline;
      gap: 4px;
      margin-top: 2px;
      padding-top: 8px;
      border-top: 1px solid var(--divider);
    }

    .state-text,
    .state-ref {
      --font-size: var(--text-8px);
      --line-height-ratio: 1.4;
      --margin-top: 0px;
      --margin-bottom: 0px;
      color: var(--text-ter);
    }

    .state-ref.clickable {
      cursor: pointer;
      color: var(--text-sec);
    }

    .state-ref.clickable:hover {
      color: var(--blue);
      text-decoration: underline;
    }

    .message {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .message-head-cell {
      --list-cell-padding: 6px 0px;
      --list-cell-layout-hover-color: transparent;
      --cell-align: center;
    }

    .message-head-cell .list-cell-content {
      min-height: 24px;
    }

    /* No quote row above: the card's own padding and the attribution cell's
       top padding double up (operator-reported as too much air) — flatten
       the first row's top, and drop the accessory min-height slack so the
       20px avatar sits at exactly the card's padding: the top inset then
       mirrors the bottom one. */
    .thread-card > .message:first-child .message-head-cell {
      --list-cell-padding: 0px 0px 6px;
    }

    .thread-card > .message:first-child .message-head-cell .list-cell-content {
      min-height: 20px;
    }

    .message-head-cell p {
      color: var(--text-sec);
    }

    .message-body {
      --font-size: var(--text-10px);
      --line-height-ratio: 1.5;
      --margin-top: 0px;
      --margin-bottom: 0px;
      color: var(--text-pri);
      white-space: pre-wrap;
    }

    .card-replies {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 2px;
      padding-top: 10px;
      border-top: 1px solid var(--divider);
    }

    .card-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .thread-card:hover .card-actions,
    .thread-card:focus-within .card-actions {
      opacity: 1;
    }

    .verb {
      --font-size: var(--text-8px);
      --margin-top: 0px;
      --margin-bottom: 0px;
      color: var(--blue);
      cursor: pointer;
    }

    .verb:hover {
      text-decoration: underline;
    }

    .verb--quiet {
      color: var(--text-ter);
    }

    .dot {
      --font-size: var(--text-8px);
      --margin-top: 0px;
      --margin-bottom: 0px;
      color: var(--text-ter);
    }

    .reply-composer {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      border: 1px solid var(--divider);
      border-radius: 8px;
    }

    .reply-input {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
      min-height: 44px;
      padding: 0px;
      border: none;
      background: transparent;
      color: var(--text-pri);
      font: inherit;
      font-size: var(--text-10px);
    }

    .reply-input:focus {
      outline: none;
    }

    .composer-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }
  `;
}
