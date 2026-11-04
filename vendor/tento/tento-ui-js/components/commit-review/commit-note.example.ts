import { Storybook } from "../../ui/storybook";
import { ArtifactViewer } from "./artifact-viewer";
import { CommitArtifact } from "./commit-artifact";
import { CommitNote } from "./commit-note";

// Storybooks for the rich commit note and its artifact figure — one storybook
// per component, each rendering ONLY that component (review-note purity rule).
// The CommitNote story shows the component doing its one job: rendering an
// inline artifact. No demonstration prose — that belongs in note bodies, never
// in the story. Everything here is self-contained (data-URL image, resolved
// promise).

const FIGURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="150">
  <rect width="640" height="150" fill="#10131a"/>
  <text x="16" y="28" fill="#e8ebf2" font-family="system-ui" font-size="14" font-weight="600">Fix diff-view sticky header z-index leak</text>
  <text x="16" y="46" fill="#8b93a7" font-family="ui-monospace" font-size="11">claude-a7</text>
  <line x1="0" y1="58" x2="640" y2="58" stroke="#2a2f3a"/>
  <text x="16" y="88" fill="#aab2c5" font-family="system-ui" font-size="12">mock header figure</text>
</svg>`;

function mockArtifacts(): Promise<ArtifactViewer.Artifact[]> {
  return Promise.resolve([
    {
      name: "header-after.svg",
      kind: "image",
      src: `data:image/svg+xml;utf8,${encodeURIComponent(FIGURE_SVG)}`,
      url: null,
      caption: null,
      text: null,
    },
    {
      name: "notes.md",
      kind: "text",
      src: "",
      url: null,
      caption: null,
      text: "inline text artifact — capped by the server, rendered as-is.",
    },
  ]);
}

export class CommitNoteStoryBook extends Storybook.Default {
  title(): string {
    return "CommitNote";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Inline artifact",
        render: () =>
          this.flatten(
            CommitNote.make(
              `<std-commit-artifact src="header-after.svg" title="the refreshed header"></std-commit-artifact>`,
              { artifacts: mockArtifacts() },
            ),
          ),
      },
    ];
  }

  /** Flatten std-documentation's centered 800px editor column so the block
   * reads like the review header's note. Styles land on the component element
   * itself — stories carry no wrapper markup. */
  private flatten($doc: HTMLElement): HTMLElement {
    $doc.style.maxWidth = "640px";
    $doc.style.setProperty("--editor-max-width", "none");
    $doc.style.setProperty("--editor-padding", "0");
    return $doc;
  }
}

export class CommitArtifactStoryBook extends Storybook.Default {
  title(): string {
    return "std-commit-artifact";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Image figure",
        render: () => this.artifact({ src: "header-after.svg", title: "the refreshed header" }),
      },
      {
        title: "Text artifact (always expanded)",
        render: () => this.artifact({ src: "notes.md", title: "no collapsed state exists" }),
      },
      {
        title: "Unknown src fails loud",
        render: () => this.artifact({ src: "missing.png" }),
      },
    ];
  }

  private artifact(attrs: Record<string, string>): HTMLElement {
    const $a = CommitArtifact.make();
    for (const [key, value] of Object.entries(attrs)) {
      $a.setAttribute(key, value);
    }
    $a.bind({ artifacts: mockArtifacts() });
    $a.style.maxWidth = "640px";
    return $a;
  }
}

// These storybooks are the ui.lona.so showcase for the commit-review
// components. The review-note card now builds a commit's OWN example from
// source (see review-note-primitives.md → std-storybook-card), so they are no
// longer registered into the review bundle.
