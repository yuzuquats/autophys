import { Storybook } from "../../ui/storybook";
import { PageBody } from "./page-body";

import type { DocComment, DocComments } from "../documentation/doc-comments";

// Storybook for std-page-body — the plan page's reading surface (plan-reader
// rev 2): markdown through the note pipeline beside the page's own comment
// gutter, one self-contained element. Both shipped shapes are here: the
// app-token island the diff pane hosts, and the flush variant the project
// page's accordion frames.

const MARKDOWN = `# The reader, in one element

A plan page's file card opens **rendered** — the markdown through the note's
own pipeline — with a toggle back to the raw hunks. This component is what
the injected builder mounts: the document column and its comment gutter,
grid and shadow styles self-contained so it renders identically inside
\`std-diff-file\`'s shadow tree or a project-page accordion.

- The gutter writes the page's own store (\`<cid>/<page>\`).
- Select any text, or hover a block's handle, to comment.

\`\`\`ts
const $page = PageBody.makeWith({ markdown, ctx });
\`\`\`
`;

/** A seeded thread whose quote matches the fixture text, so it anchors and
 *  paints its highlight — the shape a reviewer actually sees. */
const SEEDED: DocComment = {
  id: "pb-story-1",
  quote: "the markdown through the note's\nown pipeline",
  prefix: "opens **rendered** — ",
  suffix: " — with a toggle",
  blockIndex: null,
  body: "This phrasing carried from the plan — keep it in the component docs.",
  replies: [],
  resolved: false,
  createdAt: Date.now() - 60_000,
};

/** An in-memory store: the storybook gutter is fully live — new comments,
 *  replies, resolve and delete all round-trip through this array. */
function memoryComments(seed: readonly DocComment[]): DocComments.Options {
  let items: DocComment[] = [...seed];
  return {
    docId: "storybook/page-body",
    client: {
      list: () => Promise.resolve([...items]),
      upsert: (comment) => {
        items = [...items.filter((c) => c.id !== comment.id), comment];
        return Promise.resolve();
      },
      remove: (id) => {
        items = items.filter((c) => c.id !== id);
        return Promise.resolve();
      },
    },
  };
}

/** The harness mounts examples shrink-to-fit and `std-page-body` has no
 *  intrinsic width — unsized, the document wraps at one character per line.
 *  Every story pins a column width, exactly as a real host's grid does. */
function sized($page: PageBody): PageBody {
  $page.assignStyles({ width: "640px", maxWidth: "100%" });
  return $page;
}

function island(markdown: string, comments: Option<DocComments.Options>): PageBody {
  return sized(
    PageBody.makeWith({
      markdown,
      ctx: { artifacts: Promise.resolve([]), comments },
    }),
  );
}

export class PageBodyStoryBook extends Storybook.Default {
  title(): string {
    return "PageBody (std-page-body)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Island — the diff pane's shape, read-only",
        render: () => island(MARKDOWN, null),
      },
      {
        title: "Commentable — live gutter over an in-memory store",
        render: () => island(MARKDOWN, memoryComments([SEEDED])),
      },
      {
        title: "Flush — the accordion's framing",
        render: () => {
          const $page = island(MARKDOWN, memoryComments([]));
          $page.toggleAttribute("flush", true);
          return $page;
        },
      },
      {
        title: "Loading",
        render: () => sized(PageBody.make().setState("loading README.md…")),
      },
      {
        title: "Failed",
        render: () => sized(PageBody.make().setState("failed to load README.md: 502 from the pages route")),
      },
    ];
  }
}
