import { ColumnsIcon } from "../../ui/icons";
import { Storybook } from "../../ui/storybook";
import { IconButton } from "../icon-button";
import { ReviewInbox } from "./inbox";

// Storybook for the review inbox. The component never fetches — the owner
// binds assembled items — so an example is a fabricated working set: turn
// sections, an expandable project (click the chevron live), all three rungs
// of the agent column (an assigned agent, presence, commit recency), a parked
// row, and two pinned ones — including a project that is parked and pinned at
// once. Each card mounts the inbox at the rail's default 300px.

const NOW = Math.floor(Date.now() / 1000);
const H = 3600;

function member(
  key: string,
  title: string,
  handle: string,
  status: "pending" | "approved" | "changes_requested",
  ageH: number,
  changeId: Option<string>,
  mirroredFrom: Option<string> = null,
): ReviewInbox.Member {
  return {
    key,
    repo: "tento",
    title,
    shape: "circle",
    hollow: false,
    status,
    handle,
    href: `#/local/tento/${handle.replace("-", "").toLowerCase()}`,
    since: NOW - ageH * H,
    // The `Change-Id` trailer. Null for the untagged drafts below — their
    // handle is a sha9 precisely because there is no cid to hang one on.
    changeId,
    mirroredFrom,
    // A project's own commit: one level in, and a commit rather than the
    // header row a master project's member project gets.
    depth: 1,
    container: false,
  };
}

/** A working set that exercises every section: a changes_requested project
 * and a blocked one under "Needs you", a watched project with the agent, a
 * settled draft — and the third example parks one of them. */
function items(): ReviewInbox.Item[] {
  return [
    {
      kind: "project",
      project: "commit-review-inbox",
      key: "project:commit-review-inbox",
      repo: "mono",
      place: "mono",
      title: "commit-review-inbox",
      plans: 1,
      drafts: 2,
      handle: null,
      href: null,
      status: "changes_requested",
      shape: "hexagon",
      hollow: true,
      turn: "yours",
      since: NOW - 30 * H,
      lastActivity: NOW - 2 * H,
      watcher: null,
      blocked: false,
      held: false,
      holdable: true,
      pin: null,
      pinnable: true,
      // A project's subject is its slug, not a commit.
      changeId: null,
      // A round with requested changes on a host that serves the route: the
      // hand-off has a brief to give.
      assignable: true,
      assignment: null,
      mirroredFrom: null,
      members: [
        member(
          "draft:21f9aea0d",
          "feat(commit-review): review inbox",
          "L-142",
          "changes_requested",
          30,
          "I4c1d9a0f2b7e8d31",
        ),
        member(
          "draft:88d8ff9aa",
          "feat(skills): watch-review self-identifies",
          "L-143",
          "pending",
          2,
          "I7a3f5c28e90b641d",
        ),
      ],
    },
    {
      kind: "project",
      project: "render-next-reverify",
      key: "project:render-next-reverify",
      repo: "mono",
      place: "mono",
      title: "render-next-reverify",
      plans: 1,
      drafts: 0,
      handle: null,
      href: null,
      status: "pending",
      shape: "hexagon",
      hollow: true,
      turn: "yours",
      since: NOW - 8 * H,
      lastActivity: NOW - 8 * H,
      watcher: null,
      blocked: true,
      held: false,
      holdable: true,
      // Pinned FIRST in wall-clock terms, so it sorts above the parked one
      // above despite its younger commits — the pinned section orders by the
      // ask, not by the work.
      pin: {
        slug: "render-next-reverify",
        reason: "blocked on the verdict — nothing else can land under it",
        by: "claude/render-next",
        pinned_at: NOW - 9 * H,
      },
      pinnable: true,
      changeId: null,
      // Nothing has been asked of this project yet — a fresh agent would
      // arrive with no brief — and one already holds the round besides.
      assignable: false,
      // The top rung of the agent ladder: the same agent that asked for the
      // pin holds the round, and its stamp is fresh enough to read live.
      assignment: {
        spool_id: "review-revisions",
        id: "01k5f8rq2m7xvb3n6d0yhc4t9e",
        subject_kind: "project",
        subject_id: "render-next-reverify",
        engine: "claude",
        state: "running",
        updated_at: new Date((NOW - 180) * 1000).toISOString(),
      },
      mirroredFrom: null,
      members: [],
    },
    {
      kind: "project",
      project: "model-usage-limits",
      key: "project:model-usage-limits",
      repo: "tento",
      place: "tento",
      title: "model-usage-limits",
      plans: 1,
      drafts: 2,
      handle: null,
      href: null,
      status: "pending",
      shape: "hexagon",
      hollow: true,
      turn: "theirs",
      since: NOW - 6 * H,
      lastActivity: NOW - 1 * H,
      watcher: "claude/commit-inbox",
      blocked: false,
      // Parked AND pinned: the operator put this down, an agent has since
      // asked for it back. The pinned section wins the row, the `Hold`/
      // `Resume` verb still reads `Resume`, and the medallion keeps saying
      // what it always said.
      held: true,
      holdable: true,
      pin: {
        slug: "model-usage-limits",
        reason: "the provider-capacity draft gates the whole rollout",
        by: "claude/model-usage",
        pinned_at: NOW - 5 * H,
      },
      pinnable: true,
      changeId: null,
      assignable: true,
      // Watched, not assigned: presence is the middle rung, and the column
      // must not read it as a claim.
      assignment: null,
      mirroredFrom: null,
      members: [
        member(
          "draft:54e1fc37a",
          "feat(model-usage): provider capacity",
          "D-6120",
          "changes_requested",
          6,
          "Ib62d4f109c7a85e3",
        ),
      ],
    },
    {
      kind: "project",
      project: "mirror-draft",
      key: "project:mirror-draft",
      repo: "mono",
      place: "rwc-01 · mono",
      title: "mirror-draft",
      plans: 1,
      drafts: 3,
      handle: null,
      href: null,
      status: "pending",
      shape: "hexagon",
      hollow: true,
      // Pending would normally place this under Needs you. Mirrored identity
      // outranks that turn, so the story pins the new section contract.
      turn: "yours",
      since: NOW - 4 * H,
      lastActivity: NOW - 1 * H,
      watcher: null,
      blocked: false,
      held: false,
      holdable: false,
      pin: null,
      pinnable: false,
      changeId: null,
      // Borrowed work: the hand-off belongs to the host that owns it, the
      // same reason the pin and the hold are dropped above.
      assignable: false,
      assignment: null,
      mirroredFrom: "jameskao@macbookpro",
      members: [
        member(
          "draft:e7e3a7166",
          "feat(skills): mirror-draft",
          "e7e3a7166",
          "pending",
          4,
          null,
          "jameskao@macbookpro",
        ),
        member(
          "draft:1669f5c5a",
          "feat(commit-review): mirrored drafts are readonly",
          "1669f5c5a",
          "pending",
          3,
          null,
          "jameskao@macbookpro",
        ),
      ],
    },
    {
      kind: "member",
      project: null,
      key: "draft:0425235c4",
      repo: "mono",
      place: "mono",
      title: "fix(so.lona): error fallback ships empty",
      plans: null,
      drafts: null,
      // The one row with no handle: an untagged commit, which has no cid
      // to hang one on, so it keeps its sha9.
      handle: "0425235c4",
      // An untagged commit has no handle, so it addresses by inner row key.
      href: "#/local/mono/draft:0425235c4",
      status: "approved",
      shape: "circle",
      hollow: false,
      turn: "settled",
      since: NOW - 11 * H,
      lastActivity: NOW - 11 * H,
      watcher: null,
      blocked: false,
      held: false,
      holdable: false,
      pin: null,
      pinnable: false,
      // Untagged, as the sha9 handle above says: no cid to address.
      changeId: null,
      assignable: false,
      assignment: null,
      mirroredFrom: null,
      members: [],
    },
  ];
}

/** The header row of a member project inside a master's roll: a grouping, so
 * it draws the hollow hexagon and leads with its ordinal — the position the
 * master plan's `Member:` trailers gave it, which is the order being read. */
function memberProject(
  slug: string,
  ordinal: number,
  status: "pending" | "approved" | "changes_requested" | "ready",
  ageH: number,
): ReviewInbox.Member {
  return {
    key: `project:${slug}`,
    repo: "mono",
    title: `${ordinal}. ${slug}`,
    shape: "hexagon",
    hollow: true,
    status,
    handle: "",
    href: null,
    since: NOW - ageH * H,
    changeId: null,
    mirroredFrom: null,
    depth: 1,
    container: true,
  };
}

/** A commit of a member project: one level deeper than the master's own. */
function nestedMember(
  key: string,
  title: string,
  handle: string,
  status: "pending" | "approved" | "changes_requested",
  ageH: number,
  changeId: Option<string>,
): ReviewInbox.Member {
  return { ...member(key, title, handle, status, ageH, changeId), depth: 2 };
}

/** A MASTER PROJECT — a project whose plan declares an ordered `Member:` roll.
 * Opening it splices the whole group in reading order: the master's own plan,
 * then each member project (numbered as the plan numbers it) followed by that
 * project's commits. The members have no top-level rows of their own; the
 * master's row speaks for them, and its medallion aggregates their turns. */
function masterItems(): ReviewInbox.Item[] {
  return [
    {
      kind: "project",
      project: "sdk-2.0",
      key: "project:sdk-2.0",
      repo: "mono",
      place: "mono",
      title: "sdk-2.0",
      plans: 3,
      drafts: 3,
      handle: null,
      href: null,
      status: "pending",
      shape: "hexagon",
      hollow: true,
      turn: "yours",
      since: NOW - 40 * H,
      lastActivity: NOW - 1 * H,
      watcher: null,
      blocked: false,
      held: false,
      holdable: true,
      pin: null,
      pinnable: true,
      changeId: null,
      assignable: false,
      assignment: null,
      mirroredFrom: null,
      members: [
        member(
          "draft:9a10bb4c1",
          "docs(sdk-2.0): the spine",
          "L-201",
          "approved",
          40,
          "I0d5b93c7fa12e6c8",
        ),
        memberProject("sdk(0)-render-pipeline", 1, "changes_requested", 30),
        nestedMember(
          "draft:31c0aa77e",
          "docs(sdk(0)): the render pipeline plan",
          "L-202",
          "approved",
          30,
          "I5e8c1470ab39df26",
        ),
        nestedMember(
          "draft:7b21cf904",
          "feat(sdk(0)): one paint per frame",
          "L-203",
          "changes_requested",
          28,
          "I93a7e02fc5d8b164",
        ),
        memberProject("sdk(1)-substrate", 2, "pending", 12),
        nestedMember(
          "draft:c40e91ab2",
          "docs(sdk(1)): the substrate plan",
          "L-204",
          "pending",
          12,
          "I2fb84d6ea071c95d",
        ),
      ],
    },
  ];
}

function $inbox(setup?: (i: ReviewInbox) => void): HTMLElement {
  const $wrap = document.createElement("div");
  $wrap.style.width = "300px";
  const $i = ReviewInbox.make();
  $i.bind(items());
  setup?.($i);
  $wrap.appendChild($i);
  return $wrap;
}

function $masterInbox(): HTMLElement {
  const $wrap = document.createElement("div");
  $wrap.style.width = "300px";
  const $i = ReviewInbox.make();
  $i.bind(masterItems());
  $wrap.appendChild($i);
  return $wrap;
}

/** The inbox with a trigger for its columns menu, wired the way the app wires
 * it. The component draws no chrome for it — the rail head owns the button —
 * so a card that wants to exercise column placement has to supply an anchor,
 * exactly as the owner does. Same `std-icon-button`, so the card also shows
 * what the trigger is meant to look like. */
function $inboxWithColumns(): HTMLElement {
  const $wrap = document.createElement("div");
  $wrap.style.width = "300px";
  const $head = document.createElement("div").assignStyles({
    display: "flex",
    justifyContent: "flex-end",
    padding: "0 8px 4px",
  });
  const $button = IconButton.make().bindIcon(ColumnsIcon, {
    squarish: true,
    ariaLabel: "Choose columns",
  });
  const $i = ReviewInbox.make();
  $i.bind(items());
  $i.bindColumnsTrigger($button);
  $head.appendChild($button);
  $wrap.append($head, $i);
  return $wrap;
}

export class ReviewInboxStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewInbox (std-review-inbox)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "The working set — sections, presence, a blocked row",
        render: () => $inbox(),
      },
      {
        title: "On hold — parking outranks the turn model",
        render: () => $inbox(),
      },
      {
        title: "Pinned — the ask outranks the parking, and carries its reason",
        render: () => $inbox(),
      },
      {
        title: "Compact — the 52px rail keeps the medallions",
        render: () => $inbox(($i) => $i.setCompact(true)),
      },
      {
        title: "Master project — the plan's roll is the reading order",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Open sdk-2.0: its own plan first, then each member project in the " +
        // "order its `Member:` trailers declare, numbered, with that " +
        // "project's commits nested under it. The members have no rows of " +
        // "their own — the master speaks for them.",
        render: () => $masterInbox(),
      },
      {
        title: "Column placement — the owner supplies the trigger",
        render: () => $inboxWithColumns(),
      },
    ];
  }
}
