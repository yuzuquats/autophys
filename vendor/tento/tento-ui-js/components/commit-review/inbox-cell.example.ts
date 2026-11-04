import { Storybook } from "../../ui/storybook";
import { InboxCell } from "./inbox-cell";

// Storybook for the inbox's primary cell. The cell binds a presentational
// model — the inbox has already folded its turn/hold state into `quiet` and
// formatted the caption fragments — so an example is a model, not an inbox.
// Each card wraps the cell in a 300px "row" (the rail's default width) and
// passes that wrapper as the cell's $row, so the hover chevron swap works
// live on the expandable examples.

function $cell(model: InboxCell.Model): HTMLElement {
  const $row = document.createElement("div");
  $row.style.width = "300px";
  $row.style.padding = "6px 10px";
  const $c = InboxCell.make();
  // A live toggle on expandable models: clicking the chevron flips
  // `expanded`, exactly the re-bind the inbox performs.
  const onToggle = model.expandable
    ? () => {
        model = { ...model, expanded: !model.expanded };
        $c.bind(model, $row, onToggle);
      }
    : null;
  $c.bind(model, $row, onToggle);
  $row.appendChild($c);
  return $row;
}

/** A project row on the operator's turn: full-strength title, caption
 * carrying the placed fields, hover offers the disclosure chevron. */
const PROJECT: InboxCell.Model = {
  title: "commit-review-inbox",
  // The owner formats fragments; only an id carries an href.
  caption: [
    { text: "mono", href: null },
    { text: "1 plan", href: null },
  ],
  pips: [
    { state: "approved", hollow: true },
    { state: "pending", hollow: false },
    { state: "changes_requested", hollow: false },
  ],
  blocked: false,
  shape: "hexagon",
  hollow: true,
  status: "changes_requested",
  child: false,
  depth: 0,
  quiet: false,
  expandable: true,
  expanded: false,
};

/** A member commit spliced under an open project: indented one medallion,
 * secondary title, lighter register all the way down. */
const CHILD: InboxCell.Model = {
  title: "feat(commit-review): watcher presence",
  caption: [{ text: "L-142", href: "#/local/mono/l142" }],
  pips: [],
  blocked: false,
  shape: "circle",
  hollow: false,
  status: "pending",
  child: true,
  depth: 1,
  quiet: true,
  expandable: false,
  expanded: false,
};

/** With the agent (not your turn) — quiet, and the caption names the
 * watching identity, which is the whole reason presence beats inference. */
const WATCHED: InboxCell.Model = {
  title: "model-usage-limits",
  caption: [
    { text: "tento", href: null },
    { text: "watched by claude/commit-inbox", href: null },
  ],
  pips: [],
  blocked: false,
  shape: "hexagon",
  hollow: true,
  status: "pending",
  child: false,
  depth: 0,
  quiet: true,
  expandable: true,
  expanded: false,
};

/** Blocked rides the caption unconditionally — it is the one thing the
 * medallion palette cannot say — and brings the caption line into
 * existence even when no placed field fills it. */
const BLOCKED: InboxCell.Model = {
  title: "render-next-reverify",
  caption: [],
  pips: [],
  blocked: true,
  shape: "square",
  hollow: false,
  status: "changes_requested",
  child: false,
  depth: 0,
  quiet: false,
  expandable: false,
  expanded: false,
};

/** Nothing in the caption and not blocked: the cell collapses to its
 * one-line form and the title centers in the row. */
const ONE_LINE: InboxCell.Model = {
  title: "fix(so.lona): timezone prewarm signature",
  caption: [],
  pips: [],
  blocked: false,
  shape: "circle",
  hollow: false,
  status: "approved",
  child: false,
  depth: 0,
  quiet: true,
  expandable: false,
  expanded: false,
};

export class InboxCellStoryBook extends Storybook.Default {
  title(): string {
    return "InboxCell (std-review-inbox-cell)";
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Project — hover swaps medallion for chevron", render: () => $cell(PROJECT) },
      { title: "Child — indented, quiet", render: () => $cell(CHILD) },
      { title: "With the agent — watcher named in caption", render: () => $cell(WATCHED) },
      { title: "Blocked — caption exists just to say so", render: () => $cell(BLOCKED) },
      { title: "One-line — empty caption collapses", render: () => $cell(ONE_LINE) },
    ];
  }
}
