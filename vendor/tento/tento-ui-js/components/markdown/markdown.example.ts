import { Storybook } from "@tento-ui/ui/storybook";
import { Markdown } from "./markdown";

export class MarkdownStoryBook extends Storybook.Default {
  title(): string {
    return "Markdown";
  }

  tags(): string[] {
    return ["std-markdown"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "A paragraph — no marks, nothing changes",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "Prompt path confirmed. Let me round-trip the render registry file the same way, since the shell UI hot-loads through a separate status channel.",
          })),
      },
      {
        title: "Inline code — the 57% case, and the reason for all of this",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "**Prompt hot-reload**: a comment tweak to `prompt.tsh` was picked up within a second (`applied`, generation 8 → 9).",
          })),
      },
      {
        title: "A bullet list",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "Yes — it's back and fully working. I round-tripped all three paths:\n\n- prompt hot-reload applied within a second\n- render hot-load applied *immediately*\n- a broken save was rejected whole, leaving `generation` untouched",
          })),
      },
      {
        title: "A nested ordered list",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "The rewrite runs in three passes:\n\n1. resolve the plan commit by `Change-Id`\n2. rebuild everything above it\n   - one commit per primitive\n   - foreign commits replayed by path-diff\n3. guard the delta, then move the ref",
          })),
      },
      {
        title: "A fenced block — code scrolls, the column holds",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "The guard that caught it:\n\n```bash\ngit diff --no-renames --name-status \"$oldtip\" \"$parent\" > /tmp/rw-delta.txt\n[ \"$adds\" = \"24\" ] && [ \"$dels\" = \"22\" ] || { echo GUARD; exit 1; }\n```\n\nWithout `--no-renames` the counts move under you.",
          })),
      },
      {
        title: "A GFM table — the serde already parsed these",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "Coalesced by `messageId`, the corpus looks like this:\n\n| construct   | messages | share |\n| ----------- | -------- | ----- |\n| inline code | 183      | 57.2% |\n| bullet list | 29       | 9.1%  |\n| bold        | 26       | 8.1%  |",
          })),
      },
      {
        title: "Strikethrough, and a blockquote",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "~~Tables are not lowered~~ — they are, and so is this.\n\n> The second markdown parser is the one that disagrees with the first.",
          })),
      },
      {
        title: "Headings, and a link",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "## What changed\n\nThe lowering is `std-prosemirror`'s, not ours.\n\n### Why\n\nMeasured against the live corpus — see [the taxonomy page](https://tento.localhost/stack/) for the counts.",
          })),
      },
      {
        title: "Emphasis does not eat arithmetic or snake_case",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "The budget is 2 * 3 * 4 slots, and the field is called unit_started_at — neither is emphasis.",
          })),
      },
      {
        title: "An unbroken path wraps rather than overflowing",
        render: () =>
          Storybook.fill(Markdown.makeWith({
            text:
              "Wrote /Users/james/workspace/tento/tento-node-registry/tento-spool.node/html/routes/session-detail.ts",
          })),
      },
    ];
  }
}
