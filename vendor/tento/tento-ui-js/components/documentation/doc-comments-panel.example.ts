import { Storybook } from "../../ui/storybook";
import { DocCommentsPanel } from "./doc-comments-panel";

import type { DocComment, DocComments } from "./doc-comments";

// Storybook for the doc-comments side panel — the vertical stack of comment
// cards beside a document. The card in a commit note shows the component only.

function $make(vm: DocCommentsPanel.ViewModel): DocCommentsPanel {
  const $el = DocCommentsPanel.make();
  $el.bind(vm);
  return $el;
}

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A fixture item. A non-null `range` marks the comment as *anchored*: the panel
 *  places its card absolutely at the explicit panel-relative `y` and runs the
 *  collision sweep against the other anchored cards. There is no live PM view to
 *  measure here, so the range is a placeholder — only its presence (anchored vs
 *  not) drives the layout path. `range: null` marks it *unanchored*: the card
 *  drops into the "no longer anchors" tail and `y` is ignored. */
function item(
  comment: DocComment,
  y: number,
  range: DocComments.Range | null = { from: 0, to: 0 },
): DocCommentsPanel.Item {
  const anchored: DocComments.Anchored = { comment, range };
  return { anchored, y };
}

const AGENT_REPLY: DocComments.DocReply = {
  id: "reply-1",
  author: "agent",
  body: "Good catch — tightened the wording and dropped the redundant clause.",
  createdAt: NOW - 20 * MINUTE,
};

/** A plain unresolved text comment — anchored, so it lands among the positioned
 *  cards. */
const PLAIN: DocComment = {
  id: "c-plain",
  quote: "the re-anchoring falls back to a unique whitespace-normalized match",
  prefix: "when the exact context is gone, ",
  suffix: ", else the comment is unanchored.",
  blockIndex: null,
  body: "Can we spell out what happens when two candidates tie here?",
  replies: [],
  resolved: false,
  createdAt: NOW - 2 * HOUR,
};

/** An unresolved comment whose anchor was lost (`range: null` at the call site) —
 *  exercises the "⚠ no longer anchors" tail. */
const UNANCHORED: DocComment = {
  id: "c-unanchored",
  quote: "a passage that has since been edited away",
  prefix: "",
  suffix: "",
  blockIndex: null,
  body: "The line this pointed at was rewritten — does the note still apply?",
  replies: [],
  resolved: false,
  createdAt: NOW - 5 * HOUR,
};

/** A resolved comment (lands in the collapsible resolved tail). */
const RESOLVED: DocComment = {
  id: "c-resolved",
  quote: "the panel holds a handful of cards and every mutation re-binds",
  prefix: "since ",
  suffix: ", a clear-and-rebuild keeps the render trivially correct.",
  blockIndex: null,
  body: "Confirmed the clear-and-rebuild is cheap at this card count.",
  replies: [],
  resolved: true,
  createdAt: NOW - 3 * DAY,
};

/** An unresolved comment with a threaded operator→agent reply — anchored just
 *  below PLAIN so the collision sweep has to push it down. */
const THREADED: DocComment = {
  id: "c-threaded",
  quote: "a comment anchors one of two ways",
  prefix: "",
  suffix: " — a whole block, or a text range.",
  blockIndex: null,
  body: "This phrasing reads as if there is a third path. Trim it?",
  replies: [AGENT_REPLY],
  resolved: false,
  createdAt: NOW - 40 * MINUTE,
};

const THREAD: DocCommentsPanel.ViewModel = {
  // PLAIN and THREADED are anchored at near-identical y (0 and 24) so the
  // collision sweep must push THREADED to `CARD_GAP` below PLAIN's bottom —
  // the layout the panel exists to solve. UNANCHORED shows the lost-anchor
  // tail; RESOLVED the resolved tail.
  items: [
    item(PLAIN, 0),
    item(THREADED, 24),
    item(UNANCHORED, 0, null),
    item(RESOLVED, 240),
  ],
  offline: false,
  onResolve: () => {},
  onRemove: () => {},
  onScrollTo: () => {},
  onReply: () => {},
};

/** The state most changes are in, and the one the panel had no story for: no
 *  comments at all. The panel occupies a reserved 320px column whether or not
 *  it has anything to show, so this must render the column's identity and say
 *  what is true of it — not nothing. */
const EMPTY: DocCommentsPanel.ViewModel = { ...THREAD, items: [] };

/** One comment, so the header's count can be read against the empty case. */
const ONE: DocCommentsPanel.ViewModel = { ...THREAD, items: [item(PLAIN, 0)] };

/** The panel's own health, which is a different claim from "no comments" and
 *  keeps its own note under the same header. */
const OFFLINE: DocCommentsPanel.ViewModel = { ...THREAD, items: [], offline: true };

export class DocCommentsPanelStoryBook extends Storybook.Default {
  title(): string {
    return "DocCommentsPanel (std-doc-comments-panel)";
  }

  // With no `onRelayout` wired these all render STACKED (see `render`), so the
  // header flows above the list. The anchored path — header out of flow at
  // `top: 0`, cards floored at its height — only exists against a live PM view
  // and is verified in the pane, not here.
  examples(): Storybook.Example[] {
    return [
      { title: "Empty — the column says what it is", render: () => $make(EMPTY) },
      { title: "One comment", render: () => $make(ONE) },
      { title: "Comment thread", render: () => $make(THREAD) },
      { title: "Offline", render: () => $make(OFFLINE) },
    ];
  }
}

// → review-notes would cycle), so name it from here at module scope.
