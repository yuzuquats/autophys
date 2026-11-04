import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Storybook } from "../../ui/storybook";
import { CommentCard } from "./comment-card";

import type { DocComment } from "./doc-comments";

// Storybook for the one thread card (dev-comment-card-demo). The card is a
// pure FACTORY styled by its host — each real host adds `CommentCard.$styles`
// to its own `static $styles` (the doc-comments panel, the diff view's thread
// rows) — so the stories render inside a minimal demo host that does exactly
// that. The demo host IS the contract, demonstrated.

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const noop = (): void => {};

/** The minimal host: adds the card's style fragment to its own sheet and
 *  mounts the factory's output. The `dark` variant pins the same Dark+ tokens
 *  the diff host remaps (`CommentThread.$styles`, diff-view.ts), so the card
 *  reads against both palettes it ships in — the card itself is token-pure. */
@component({ name: "dev-comment-card-demo" })
export class CommentCardDemo extends LonaWebComponent {
  static makeWith(vm: CommentCard.ViewModel, dark: boolean): CommentCardDemo {
    const $demo = CommentCardDemo.make();
    $demo.toggleAttribute("dark", dark);
    $demo.$("root").appendChild(CommentCard.make(vm));
    return $demo;
  }

  static $styles = [
    CommentCard.$styles,
    css`
      :host {
        display: block;
        max-width: 380px;
      }

      /* Mirror of the diff host's remap — kept byte-close on purpose so the
         story shows what the diff row actually ships. */
      :host([dark]) {
        --bg: #252526;
        --divider: #3c3c3c;
        --text-pri: #d4d4d4;
        --text-sec: #a6a6a6;
        --text-ter: #858585;
        --blue: #569cd6;
        --green: #6a9955;
        --hover-color: #2d2d30;
        --blue-dimmed: #264f78;
        --orange-dimmed: #6b3d00;
      }

      :host([dark]) #root {
        padding: 12px;
        background: #1e1e1e;
        border-radius: 8px;
      }
    `,
  ];

  static $html = html`<div id="root"></div>`;
}

/** Base view-model: every affordance absent. Stories opt verbs IN, mirroring
 *  how a host wires only what its store supports. */
function vm(
  comment: DocComment,
  over: Partial<CommentCard.ViewModel>,
): CommentCard.ViewModel {
  return {
    comment,
    now: NOW,
    showQuote: false,
    faded: false,
    onScrollTo: null,
    onReply: null,
    onResolve: null,
    onViewFix: null,
    onRemove: null,
    onLayoutChange: null,
    ...over,
  };
}

/** The diff row's shape: a bare line comment, no quote, no verbs — the card
 *  renders attribution + body alone, no dead hover chrome. */
const LINE: DocComment = {
  id: "c-line",
  quote: "",
  prefix: "",
  suffix: "",
  blockIndex: null,
  body: "This lock ordering can deadlock against the writer path — take the ledger lock first.",
  replies: [],
  resolved: false,
  createdAt: NOW - 2 * MINUTE,
  author: "operator",
};

/** A prose comment with its excerpt quote — the stacked/tail contexts where
 *  the card is not beside its highlighted passage. */
const QUOTED: DocComment = {
  id: "c-quoted",
  quote: "the panel holds a handful of cards and every mutation re-binds",
  prefix: "since ",
  suffix: ", a clear-and-rebuild keeps the render trivially correct.",
  blockIndex: null,
  body: "Worth a measurement note here — at what card count does this stop being cheap?",
  replies: [],
  resolved: false,
  createdAt: NOW - 3 * HOUR,
  author: "operator",
};

/** A structured anchor in place of the prose excerpt: a diff line with its
 *  side + revision pin. */
const ANCHORED: DocComment = {
  id: "c-anchored",
  quote: "",
  prefix: "",
  suffix: "",
  blockIndex: null,
  body: "Off-by-one when the hunk ends exactly at the context window.",
  replies: [],
  resolved: false,
  createdAt: NOW - 1 * HOUR,
  author: "operator",
  anchor: { label: "src/store.rs:412", side: "new", revision: 4 },
};

/** A threaded, ADDRESSED thread: a push-back reply, then a resolution request
 *  carrying `addressedIn`. The reply renders as plain prose; the claim shows
 *  once, as the footer state line (`addressed by claude in diff 5`), whose
 *  `diff 5` is the interdiff link because the story wires `onViewFix`. */
const ADDRESSED: DocComment = {
  id: "c-addressed",
  quote: "a comment anchors one of two ways",
  prefix: "",
  suffix: " — a whole block, or a text range.",
  blockIndex: null,
  body: "This phrasing reads as if there is a third path. Trim it?",
  replies: [
    {
      id: "r-push",
      author: "operator",
      body: "Still reads ambiguous to me after the first pass.",
      createdAt: NOW - 50 * MINUTE,
    },
    {
      id: "r-fix",
      author: "agent",
      body: "Dropped the second clause entirely.",
      createdAt: NOW - 20 * MINUTE,
      addressedIn: 5,
    },
  ],
  resolved: false,
  createdAt: NOW - 2 * HOUR,
  author: "operator",
};

/** A resolved thread as the resolved tail renders it: faded, quote shown,
 *  the verb reading `Reopen`. */
const RESOLVED: DocComment = {
  id: "c-resolved",
  quote: "the re-anchoring falls back to a unique whitespace-normalized match",
  prefix: "",
  suffix: "",
  blockIndex: null,
  body: "Confirmed — the tie case unanchors rather than guessing.",
  replies: [],
  resolved: true,
  createdAt: NOW - 3 * DAY,
  author: "operator",
};

/** A commit-wide thread: no quote slot at all — otherwise the plain card. */
const COMMIT_WIDE: DocComment = {
  id: "c-wide",
  quote: "",
  prefix: "",
  suffix: "",
  blockIndex: null,
  body: "Overall: the shape is right; land it after the storybook sweep.",
  replies: [],
  resolved: false,
  createdAt: NOW - 10 * MINUTE,
  author: "operator",
  commitWide: true,
};

export class CommentCardStoryBook extends Storybook.Default {
  title(): string {
    return "CommentCard (factory · div.thread-card)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Bare — all verbs absent (the diff row's shape)",
        render: () => CommentCardDemo.makeWith(vm(LINE, {}), false),
      },
      {
        title: "Quote + full verb line (hover the card)",
        render: () =>
          CommentCardDemo.makeWith(
            vm(QUOTED, {
              showQuote: true,
              onScrollTo: noop,
              onReply: () => {},
              onResolve: noop,
              onRemove: noop,
            }),
            false,
          ),
      },
      {
        title: "Structured anchor pin",
        render: () =>
          CommentCardDemo.makeWith(vm(ANCHORED, { onScrollTo: noop }), false),
      },
      {
        title: "Addressed thread — footer state line",
        render: () =>
          CommentCardDemo.makeWith(
            vm(ADDRESSED, {
              showQuote: true,
              onReply: () => {},
              onResolve: noop,
              onViewFix: noop,
            }),
            false,
          ),
      },
      {
        title: "Resolved — the faded tail, Reopen verb",
        render: () =>
          CommentCardDemo.makeWith(
            vm(RESOLVED, { showQuote: true, faded: true, onResolve: noop }),
            false,
          ),
      },
      {
        title: "Commit-wide thread — no quote slot",
        render: () =>
          CommentCardDemo.makeWith(vm(COMMIT_WIDE, { onReply: () => {} }), false),
      },
      {
        title: "Dark+ — the diff host's token remap",
        render: () => CommentCardDemo.makeWith(vm(LINE, {}), true),
      },
    ];
  }
}
