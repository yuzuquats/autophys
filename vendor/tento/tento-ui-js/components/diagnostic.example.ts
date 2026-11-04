import { Storybook } from "@tento-ui/ui/storybook";
import { Diagnostic } from "./diagnostic";

export class DiagnosticStoryBook extends Storybook.Default {
  title(): string {
    return "Diagnostic";
  }

  tags(): string[] {
    return ["std-diagnostic"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "A message on its own",
        render: () =>
          Diagnostic.makeWith({
            title: "ValidationError: unit rejected after attempt 3/3",
          }),
      },
      {
        title: "With a trace",
        render: () =>
          Diagnostic.makeWith({
            title: "PermissionDenied: tool call blocked by policy",
            detail: [
              "  at harness.dispatch (tento-sh/src/harness.rs:412)",
              "  at lane.run (tento-sh/src/lane.rs:188)",
              "  at unit.execute (tento-sh/src/unit.rs:96)",
              "caused by: policy `fs.write` denies /etc",
            ].join("\n"),
          }),
      },
      {
        title: "A panic — the message is the label",
        render: () =>
          Diagnostic.makeWith({
            title: "panicked at `Option::unwrap()` on a `None` value",
            detail: "tento-spool/src/projection.rs:214",
          }),
      },
      {
        title: "A build failure, verbatim",
        render: () =>
          Diagnostic.makeWith({
            title: "cargo build failed — exit 101",
            detail: [
              "error[E0432]: unresolved import `tento_env::EnvKv`",
              "  --> tento-spool/src/main.rs:9:5",
              "   |",
              " 9 | use tento_env::EnvKv;",
              "   |     ^^^^^^^^^^^^^^^^ no `EnvKv` in the root",
            ].join("\n"),
          }),
      },
      {
        title: "Warning severity — same shape, the rule carries it",
        render: () =>
          Diagnostic.makeWith({
            severity: "warning",
            title: "lane.declare without a handler will be an error in v3",
            detail: '[line 13] (lane.declare "deepseek")',
          }),
      },
      {
        title: "A wide frame scrolls — the columns are never reflowed",
        render: () =>
          Diagnostic.makeWith({
            title: "the unit exited before the lane drained",
            detail: [
              "thread 'tokio-runtime-worker' panicked at tento-spool/src/projection.rs:214:37:",
              "  called `Result::unwrap()` on an `Err` value: Closed(SendError { .. }) while draining lane 2 of 3",
              "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
            ].join("\n"),
          }),
      },
      {
        title: "A long message wraps rather than overflowing",
        render: () =>
          Diagnostic.makeWith({
            title:
              "IoError: failed to write /Users/james/workspace/tento/tento-node-registry/tento-spool.node/html/routes/session-detail.ts (read-only file system)",
          }),
      },
    ];
  }
}
