import { Epoch, Time } from "@tento-chrono";

import { Storybook } from "../../ui/storybook";
import { Discussion } from "./discussion";

// Storybook for the discussion region — the change pane's time-ordered log.
// Review-state read-only, so every case is a pure viewmodel. Dense revision
// runs disclose their children; production also wires each child to Versions.

// One `now` for the whole file, so every story's relative label ("2h", "40m")
// is stable and consistent whenever the storybook is opened. Offsets come from
// chrono's own constants rather than locally-declared millisecond maths.
const NOW = Epoch.currentMse();

const CLAUDE = {
  kind: "agent" as const,
  id: "local:claude:s-8f2c",
  provider: "claude",
  session_ref: "s-8f2c",
  label: "Claude",
  host: "local",
};

const JAMES = {
  kind: "operator" as const,
  id: "local:operator",
  provider: "local",
  session_ref: null,
  label: "James Kao",
  host: "local",
};

/** Nothing has happened yet — the region self-hides, so the card is blank. */
const EMPTY: Discussion.Event[] = [];

/** The common case on a reviewed change: one verdict, carrying its summary. */
const ONE_VERDICT: Discussion.Event[] = [
  {
    kind: "verdict",
    status: "changes_requested",
    author: "operator",
    at: NOW - 2 * Time.MS_PER_HR,
    revision: 1,
    summary: "two of the three claims are inferred; say which.",
  },
];

/** A verdict answered by a commit-wide comment, which is the exchange the
 *  `Comment` action exists to make possible. */
const VERDICT_AND_REPLY: Discussion.Event[] = [
  {
    kind: "verdict",
    status: "changes_requested",
    author: "operator",
    at: NOW - 2 * Time.MS_PER_HR,
    revision: 1,
    summary: "two of the three claims are inferred; say which.",
  },
  {
    kind: "comment",
    thread: Discussion.makeThread({
      id: "c1",
      author: "agent",
      body:
        "the 126ms is a single full walk over 6,025 commits, not a percentile. " +
        "(addressed in Diff 2)",
      at: NOW - 40 * Time.MS_PER_MIN,
      replies: [
        {
          id: "r1",
          author: "agent/security",
          body:
            "the grep patterns are line-anchored, so a quoted cid cannot answer for a record. no escaping gap.",
          createdAt: NOW - 12 * Time.MS_PER_MIN,
        },
        {
          id: "r2",
          author: "operator",
          body:
            "good — keep that evidence in the note, not only in this reply.",
          createdAt: NOW - 8 * Time.MS_PER_MIN,
        },
      ],
    }),
  },
  {
    kind: "verdict",
    status: "approved",
    author: "operator",
    at: NOW - 5 * Time.MS_PER_MIN,
    revision: 2,
    summary: "",
  },
];

/** The whole log: the capture that opened the draft, a verdict, a thread
 *  anchored to a note passage, two diff-line comments, and the revision that
 *  answered them. The anchored thread also renders in the gutter — position and
 *  time answer different questions. */
const EVERY_KIND: Discussion.Event[] = [
  {
    kind: "revision",
    n: 1,
    trigger: "initial",
    actor: CLAUDE,
    scope: { patch: { files_changed: 3, additions: 84, deletions: 2 } },
    at: NOW - 4 * Time.MS_PER_HR,
  },
  {
    kind: "revision",
    n: 2,
    trigger: "revise",
    actor: CLAUDE,
    scope: { patch: { files_changed: 2, additions: 12, deletions: 7 } },
    at: NOW - 25 * Time.MS_PER_MIN,
  },
  {
    kind: "verdict",
    status: "changes_requested",
    author: "operator",
    at: NOW - 3 * Time.MS_PER_HR,
    revision: 1,
    summary: "two of the three claims are inferred; say which.",
  },
  {
    kind: "comment",
    thread: {
      ...Discussion.makeThread({
        id: "c3",
        author: "operator",
        body: "is this the p99 or the mean?",
        at: NOW - 2 * Time.MS_PER_HR,
        replies: [],
      }),
      commitWide: false,
      quote: "the third was keyed off the sha",
      anchor: { label: "note ¶2", revision: 1 },
    },
  },
  {
    kind: "code",
    comment: {
      file: "tento-node-registry/commit-review.node/src/stack.rs",
      side: "new",
      line: 1302,
      body: "this seems bad — why can't we use Option<>",
      created_at: Math.floor((NOW - 90 * Time.MS_PER_MIN) / 1000),
    },
  },
  {
    kind: "code",
    comment: {
      file: "tento-node-registry/commit-review.node/src/stack.rs",
      side: "new",
      line: 1310,
      body: "remove",
      created_at: Math.floor((NOW - 90 * Time.MS_PER_MIN) / 1000),
    },
  },
  {
    kind: "comment",
    thread: Discussion.makeThread({
      id: "c4",
      author: "agent",
      body: "both answered in Diff 2.",
      at: NOW - 20 * Time.MS_PER_MIN,
      replies: [],
    }),
  },
];

/** A verdict and a comment written in the same tick — the case the sort
 *  comparator's tie-break exists for. The verdict must read first. */
const SAME_TIMESTAMP: Discussion.Event[] = [
  {
    kind: "comment",
    thread: Discussion.makeThread({
      id: "c2",
      author: "operator",
      body: "…and the same goes for the tail case.",
      at: NOW - Time.MS_PER_HR,
      replies: [],
    }),
  },
  {
    kind: "verdict",
    status: "changes_requested",
    author: "operator",
    at: NOW - Time.MS_PER_HR,
    revision: 1,
    summary: "the orphan probe needs a test that fails without the fix.",
  },
];

/** Every revision trigger, so the four verbs can be read against each other —
 *  and the last one carries no author, which is the impersonal fallback a
 *  cross-repo member takes. */
const REVISION_VERBS: Discussion.Event[] = [
  {
    kind: "revision",
    n: 1,
    trigger: "initial",
    actor: CLAUDE,
    scope: null,
    at: NOW - 3 * Time.MS_PER_HR,
  },
  {
    kind: "revision",
    n: 2,
    trigger: "revise",
    actor: CLAUDE,
    scope: null,
    at: NOW - 2 * Time.MS_PER_HR,
  },
  {
    kind: "revision",
    n: 3,
    trigger: "absorb",
    actor: CLAUDE,
    scope: null,
    at: NOW - Time.MS_PER_HR,
  },
  {
    kind: "revision",
    n: 4,
    trigger: "note-only",
    actor: null,
    scope: null,
    at: NOW - 10 * Time.MS_PER_MIN,
  },
];

/** The production-shaped legacy history that motivated grouping: one initial
 * observation plus twelve updates with no recorded actor collapses to two
 * top-level rows while every Diff remains available inside the disclosure. */
const DENSE_LEGACY: Discussion.Event[] = [
  "initial",
  "note-only",
  "revise",
  "revise",
  "revise",
  "note-only",
  "revise",
  "note-only",
  "note-only",
  "note-only",
  "note-only",
  "note-only",
  "note-only",
].map((trigger, index) => ({
  kind: "revision" as const,
  n: index + 1,
  trigger: trigger as Discussion.Trigger,
  actor: null,
  scope: null,
  at: NOW - (13 - index) * Time.MS_PER_HR,
}));

/** The same production-shaped run with concrete mutation attribution. The
 * grouped label names the actor; the rail glyph is the same ↻ as the legacy
 * run, because the rail says what happened and the row says who. */
const DENSE_ATTRIBUTED: Discussion.Event[] = DENSE_LEGACY.map((event) => ({
  ...event,
  actor: JAMES,
}));

export class DiscussionStoryBook extends Storybook.Default {
  title(): string {
    return "Discussion (std-discussion)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Empty — the region self-hides",
        render: () => Discussion.makeWith({ events: EMPTY }),
      },
      {
        title: "One verdict, with a summary",
        render: () => Discussion.makeWith({ events: ONE_VERDICT }),
      },
      {
        title: "Forum thread — review, attached replies, and approval",
        render: () => Discussion.makeWith({ events: VERDICT_AND_REPLY }),
      },
      {
        title: "PR conversation — comment cards between activity events",
        render: () => Discussion.makeWith({ events: EVERY_KIND }),
      },
      {
        title: "Revision verbs — all four triggers, last with no recorded actor",
        render: () => Discussion.makeWith({ events: REVISION_VERBS }),
      },
      {
        title: "Dense legacy history — 13 Diffs, two activity rows",
        render: () => Discussion.makeWith({ events: DENSE_LEGACY }),
      },
      {
        title: "Dense attributed history — one accountable actor",
        render: () => Discussion.makeWith({ events: DENSE_ATTRIBUTED }),
      },
      {
        title: "Same timestamp — verdict sorts first",
        render: () => Discussion.makeWith({ events: SAME_TIMESTAMP }),
      },
    ];
  }
}
