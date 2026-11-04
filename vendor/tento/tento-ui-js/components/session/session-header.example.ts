import { Storybook } from "@tento-ui/ui/storybook";
import { SessionHeader } from "./session-header";

/** Values are taken from real records on the tento-spool catalog (captured
 * 2026-08-05) rather than invented — truncation only bites at real lengths. */
export class SessionHeaderStoryBook extends Storybook.Default {
  title(): string {
    return "Session Header";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title:
          "A bare terminal — owner as the title, the session's own label below",
        render: () =>
          SessionHeader.makeWith({
            title: "Terminals",
            number: "#16734",
            description:
              "we have tree-sitter baked into our shell. can we use it to…",
            status: { label: "live", state: "progress" },
            onMore: () => {},
          }),
      },
      {
        title: "A spool session — the title is the job it serves",
        render: () =>
          SessionHeader.makeWith({
            title: "Summarize news for 2026-08-05",
            number: "#72225",
            description: "Research the most important news for 2026-08-05…",
            status: { label: "live", state: "progress" },
            onMore: () => {},
          }),
      },
      {
        title: "Offline",
        render: () =>
          SessionHeader.makeWith({
            title: "Pack camera upload",
            number: "#92317",
            description: "metadata lookup",
            status: { label: "offline", state: "error" },
            onMore: () => {},
          }),
      },
      {
        title: "Dead",
        render: () =>
          SessionHeader.makeWith({
            title: "Pack camera upload",
            number: "#91847",
            description: "failed pack",
            status: { label: "dead", state: "error" },
            onMore: () => {},
          }),
      },
      {
        title: "Long title and long description — both clamp to one line",
        render: () =>
          SessionHeader.makeWith({
            title:
              "Research the most important news for 2026-08-05 and summarize each story with a source link",
            number: "#72225",
            description:
              "Find and summarize the most important current stories, with source links.",
            status: { label: "live", state: "progress" },
            onMore: () => {},
          }),
      },
      {
        title: "No description — the cell collapses to tag and title",
        render: () =>
          SessionHeader.makeWith({
            title: "Terminals",
            number: "#49917",
            description: "",
            status: { label: "live", state: "progress" },
            onMore: () => {},
          }),
      },
      {
        title: "No number — no tag, and the title leads",
        render: () =>
          SessionHeader.makeWith({
            title: "Classify Fallen Leaves",
            number: "",
            description: "inspect matches",
            status: { label: "live", state: "progress" },
            onMore: () => {},
          }),
      },
      {
        title: "Nothing behind the accessory yet",
        render: () =>
          SessionHeader.makeWith({
            title: "Terminals",
            number: "#680",
            description: "",
            status: { label: "live", state: "progress" },
            onMore: null,
          }),
      },
    ];
  }
}
