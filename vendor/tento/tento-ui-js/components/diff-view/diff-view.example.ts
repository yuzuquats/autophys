import { Storybook } from "../../ui/storybook";
import { DiffView } from "./diff-view";

const RUST_FILE: DiffView.FileDiff = {
  old_path: "src/registry.rs",
  new_path: "src/registry.rs",
  status: "modified",
  binary: false,
  additions: 3,
  deletions: 1,
  hunks: [
    {
      old_start: 4,
      old_count: 5,
      new_start: 4,
      new_count: 7,
      header: "@@ -4,5 +4,7 @@ impl AppRegistry",
      lines: [
        DiffView.DiffLine.make("context", 4, 4, "impl AppRegistry {", null),
        DiffView.DiffLine.make("context", 5, 5, "  pub fn resolve(&self, app: &str) -> Option<u16> {", [
          DiffView.Token.make(2, 3, "keyword"),
          DiffView.Token.make(6, 7, "function"),
          DiffView.Token.make(29, 6, "type"),
        ]),
        DiffView.DiffLine.make("del", 6, null, "    self.apps.get(app)", null),
        DiffView.DiffLine.make("add", null, 6, "    // All-digit labels are literal ports.", null),
        DiffView.DiffLine.make("add", null, 7, "    if let Ok(port) = app.parse() {", [
          DiffView.Token.make(4, 2, "keyword"),
          DiffView.Token.make(11, 2, "type"),
        ]),
        DiffView.DiffLine.make("add", null, 8, "      return Some(port);", [
          DiffView.Token.make(6, 6, "keyword"),
        ]),
        DiffView.DiffLine.make("context", 7, 9, "  }", null),
      ],
    },
  ],
  new_lines: [
    "//! App registry.",
    "",
    "use std::collections::BTreeMap;",
    "impl AppRegistry {",
    "  pub fn resolve(&self, app: &str) -> Option<u16> {",
    "    // All-digit labels are literal ports.",
    "    if let Ok(port) = app.parse() {",
    "      return Some(port);",
    "  }",
    "}",
  ],
};

const ADDED_FILE: DiffView.FileDiff = {
  old_path: null,
  new_path: "demo/breakout/index.html",
  status: "added",
  binary: false,
  additions: 2,
  deletions: 0,
  hunks: [
    {
      old_start: 0,
      old_count: 0,
      new_start: 1,
      new_count: 2,
      header: "@@ -0,0 +1,2 @@",
      lines: [
        DiffView.DiffLine.make("add", null, 1, "<!DOCTYPE html>", null),
        DiffView.DiffLine.make("add", null, 2, "<title>Breakout</title>", null),
      ],
    },
  ],
};

const BINARY_FILE: DiffView.FileDiff = {
  old_path: "logo-64.png",
  new_path: "logo-64.png",
  status: "modified",
  binary: true,
  additions: 0,
  deletions: 0,
  hunks: [],
};

export class DiffViewStoryBook extends Storybook.Default {
  title(): string {
    return "Diff View";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Modified file — hunks, syntax tokens, expandable context",
        render: () => this.$diff({ files: [RUST_FILE] }, []),
      },
      {
        title: "Added + binary files",
        render: () => this.$diff({ files: [ADDED_FILE, BINARY_FILE] }, []),
      },
      {
        // The panel renders real bytes via a page-supplied `Media`; the story
        // fakes the byte routes with generated SVG data URIs.
        title: "Image files — added renders, modified renders before → after",
        render: () => {
          const files: DiffView.FileDiff[] = [
            {
              old_path: null,
              new_path: "assets/hero.png",
              status: "added",
              binary: true,
              additions: 0,
              deletions: 0,
              hunks: [],
            },
            {
              old_path: "assets/logo.png",
              new_path: "assets/logo.png",
              status: "modified",
              binary: true,
              additions: 0,
              deletions: 0,
              hunks: [],
            },
          ];
          const svg = (label: string, fill: string) =>
            `data:image/svg+xml,${encodeURIComponent(
              `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140">` +
                `<rect width="100%" height="100%" rx="10" fill="${fill}"/>` +
                `<text x="50%" y="55%" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="15">${label}</text>` +
                `</svg>`,
            )}`;
          const $view = DiffView.make();
          $view.bind(
            { files },
            {
              fileSrc: (path, side) =>
                svg(`${path.split("/").pop()} · ${side}`, side === "old" ? "#8b3a3a" : "#2f6b3f"),
            },
          );
          return $view;
        },
      },
      {
        title: "Inline comment thread (hover a gutter to compose)",
        render: () =>
          this.$diff({ files: [RUST_FILE] }, [
            {
              file: "src/registry.rs",
              side: "new",
              line: 6,
              body: "nice — the literal-port escape hatch keeps undeclared services reachable.",
              created_at: 1784000000,
            },
          ]),
      },
      {
        title: "Empty artifact",
        render: () => this.$diff({ files: [] }, []),
      },
    ];
  }

  private $diff(artifact: DiffView.Artifact, comments: DiffView.Comment[]): DiffView {
    const $view = DiffView.make();
    $view.bind(artifact, null);
    if (comments.length > 0) $view.setComments(comments);
    $view.onSubmit = (c) =>
      Promise.resolve([
        ...comments,
        { ...c, created_at: Math.floor(Date.now() / 1000) },
      ]);
    return $view;
  }
}
