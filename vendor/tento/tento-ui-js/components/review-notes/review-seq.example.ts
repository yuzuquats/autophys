import { Storybook } from "../../ui/storybook";
import { SeqParser } from "../../review-dsl/seq-parser";
import { ReviewSeq } from "./review-seq";

/** Message labels knock a hole in the lifelines they cross by stroking the
 * text in the surface colour, which only disappears if that colour is the one
 * actually behind the diagram. In a note that is the page background; here it
 * is the storybook card's wash, so the story says so — the same one line a
 * real placer on a tinted surface would write. It lands on the component
 * element itself; the story carries no wrapper. */
function $seq(src: string): HTMLElement {
  const r = SeqParser.parse(src);
  if (!r.ok) {
    throw new Error(`fixture failed: line ${r.error.line}: ${r.error.message}`);
  }
  const $el = ReviewSeq.make();
  $el.bind({ seq: r.value });
  $el.style.setProperty("--seq-surface", "var(--bg-hover-opaque)");
  return $el;
}

const RELAY = `sequenceDiagram
  participant B as Browser
  participant L as tento.localhost
  participant N as commit-review node
  B->>L: GET /stack/?host=yuzuquats
  L-->>B: page shell + root.js
  B->>L: /data/yuzuquats/commit-review/api/stack/mono
  L->>N: ssh bridge → 127.0.0.1:8795
  N-->>L: drafts + public json
  L-->>B: relayed bytes
  Note over B,N: byte routes stay untyped — the relay is a pipe`;

const SELF_AND_CONTROL = `sequenceDiagram
  autonumber
  A->>A: debounce 300ms
  A->>S: persist
  alt conflict
    S-->>A: 409 + server copy
  end
  S-->>A: ok`;

const LONG_LABELS = `sequenceDiagram
  participant Browser as Browser with a deliberately long actor label
  participant Review as Commit review service
  Browser->>Review: resolve the changed file and scroll the matching diff row without overlapping the lifeline
  Review-->>Browser: return a descriptive response that wraps inside the measured message span`;

export class ReviewSeqStoryBook extends Storybook.Default {
  title(): string {
    return "ReviewSeq (std-review-seq)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Relay round-trip",
        render: () => $seq(RELAY),
      },
      {
        title: "Self-message + skipped control flow",
        render: () => $seq(SELF_AND_CONTROL),
      },
      {
        title: "Long actors and messages wrap",
        render: () => $seq(LONG_LABELS),
      },
    ];
  }
}
