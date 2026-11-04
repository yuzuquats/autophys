import { assertEquals } from "@std/assert";

import { DiscussionPresentation as Presentation } from "./discussion-presentation.ts";

Deno.test("system copy separates actor, action, diff, and time", () => {
  assertEquals(
    Presentation.line("Codex revised the change · Diff 3 · 8m", "Codex"),
    [
      { kind: "author", text: "Codex" },
      { kind: "action", text: "revised the change" },
      { kind: "ref", text: "Diff 3" },
      { kind: "meta", text: "8m" },
    ],
  );
});

Deno.test("every rail node is the action, never the actor", () => {
  assertEquals(Presentation.eventNode("revision"), {
    text: "↻",
    label: "Revision activity",
    status: "revision",
  });
  assertEquals(Presentation.eventNode("approved").text, "✓");
  assertEquals(Presentation.eventNode("changes_requested").text, "!");
  assertEquals(Presentation.commentNode("comment").text, "“");
  assertEquals(Presentation.commentNode("code").label, "Commented on code");
});

Deno.test("addressed replies receive an explicit forum action", () => {
  assertEquals(Presentation.replyAction(null), "replied");
  assertEquals(Presentation.replyAction(4), "marked this addressed");
});
