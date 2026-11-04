import { assertEquals, assertStringIncludes } from "@std/assert";

import { DiscussionActivity as Activity } from "./discussion-activity.ts";

const ACTOR: Activity.ActorRef = {
  kind: "agent",
  id: "local:codex:thread-123456789",
  provider: "codex",
  session_ref: "thread-123456789",
  label: "Codex",
  host: "local",
};

function revision(
  n: number,
  trigger: Activity.Trigger,
  actor: Option<Activity.ActorRef> = ACTOR,
): Activity.Revision {
  return { kind: "revision", n, trigger, actor, scope: null, at: n * 1_000 };
}

Deno.test("the noisy thirteen-diff history becomes two top-level rows", () => {
  const triggers: Activity.Trigger[] = [
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
  ];
  const entries = Activity.group(
    triggers.map((trigger, i) => revision(i + 1, trigger)),
  );
  assertEquals(entries.length, 2);
  assertEquals(entries[0].kind, "revision-group");
  assertEquals(entries[1].kind, "revision-group");
  if (entries[1].kind === "revision-group") {
    assertEquals(entries[1].revisions.length, 12);
    assertStringIncludes(
      Activity.summary(entries[1].revisions, 14_000),
      "Codex made 12 updates · Diffs 2–13",
    );
  }
});

Deno.test("conversation and concrete actor changes split activity", () => {
  const other = {
    ...ACTOR,
    id: "local:claude:session-b",
    provider: "claude",
    label: "Claude",
  };
  const entries = Activity.group([
    revision(2, "revise"),
    revision(3, "note-only"),
    { kind: "comment" as const },
    revision(4, "revise"),
    revision(5, "revise", other),
  ]);
  assertEquals(entries.map((entry) => entry.kind), [
    "revision-group",
    "comment",
    "revision-group",
    "revision-group",
  ]);
});

Deno.test("legacy activity is impersonal, and carries no warning about it", () => {
  const legacy = revision(8, "note-only", null);
  assertEquals(
    Activity.revisionLabel(null, "note-only"),
    "Draft updated the review note",
  );
  const summary = Activity.summary([legacy], 9_000);
  assertStringIncludes(summary, "Draft updated the review note · Diff 8 · ");
  assertEquals(summary.includes("unattributed"), false);
  assertEquals(Activity.detail(legacy, 9_000).includes("unattributed"), false);
});

Deno.test("summary and detail carry accountable actor, range, scope, and session", () => {
  const first = {
    ...revision(2, "revise"),
    scope: { patch: { files_changed: 2, additions: 7, deletions: 3 } },
  };
  const second = {
    ...revision(3, "note-only"),
    scope: { note: { additions: 4, deletions: 1 } },
  };
  assertStringIncludes(
    Activity.summary([first, second], 4_000),
    "Codex made 2 updates · Diffs 2–3 · 1 code, 1 note",
  );
  assertStringIncludes(Activity.detail(first, 4_000), "2 files, +7 −3");
  assertStringIncludes(Activity.detail(first, 4_000), "thread-123456789");
});

Deno.test("a single update says what changed and carries its diffstat", () => {
  const note = {
    ...revision(4, "note-only"),
    scope: { note: { additions: 12, deletions: 3 } },
  };
  assertStringIncludes(
    Activity.summary([note], 5_000),
    "Codex updated the review note · Diff 4 · note +12 −3",
  );
  assertStringIncludes(
    Activity.detail(note, 5_000),
    "updated the review note · note +12 −3",
  );
});
