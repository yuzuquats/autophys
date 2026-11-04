import { Lazy } from "@tento-core/lazy";

import { CodeBlockView } from "../code/code-block-view";
import { DocComments } from "../documentation/doc-comments";
import { DocCommentsPanel } from "../documentation/doc-comments-panel";
import { Documentation } from "../documentation/documentation";
import { LispExampleView } from "../lisp-example/lisp-example-view";
import { FileRefView } from "../review-notes/file-ref-view";
import { ReviewFence } from "../review-notes/review-fence";
import { ReviewHtml } from "../review-notes/review-html";
import { ReviewNav } from "../review-notes/review-nav";
import { Prosemirror } from "../../ui/prosemirror-import";
import type { ProseMirrorEditor } from "../prosemirror";
import { Exception } from "../exception/exception";
import { ArtifactViewer } from "./artifact-viewer";
import { CommitArtifact } from "./commit-artifact";

// The commit-note flavor of std-documentation: the note markdown may inline
// the set's attached artifacts where the narrative references them, via
//   <std-commit-artifact src="<entry name>"></std-commit-artifact>
// registered through the ProseMirror custom-component pipeline. This serde is
// deliberately scoped here — Documentation's default registry must not grow a
// commit-review dependency (blog/docs notes render through it too).

export namespace CommitNote {
  export type Ctx = {
    /** The set's artifacts, `src` pre-resolved to servable URLs. Header
     * binding is synchronous while artifacts load async — inline figures
     * skeleton until this settles. */
    artifacts: Promise<ArtifactViewer.Artifact[]>;
    /** Diff navigation for file-ref chips and review-steps anchors. Absent on
     * surfaces without a diff pane (storybook, plain rendering) — chips stay
     * inert code spans. */
    nav?: Option<ReviewNav>;
    /** Opt-in prose comments on the note (the review-conversation surface):
     * select a passage / hover a block handle → threaded comment, persisted
     * through the app-supplied client keyed by the set's Change-Id. Absent →
     * exactly the previous read-only note. */
    comments?: Option<DocComments.Options>;
    /** Receives the comments side panel once the note has bound with
     * `comments` (the panel exists only after the async bind). The caller
     * owns placement — this module stays layout-agnostic. */
    onCommentsPanel?: Option<($panel: DocCommentsPanel) => void>;
    /** Builds the opaque-origin harness URL for a `<std-storybook-card
     * example=… class=…>`: the review node bundles that example from the
     * checkout's own source and serves it sandboxed. Absent on surfaces with
     * no live source (the card renders an inert notice). */
    exampleSrc?: Option<(example: string, className: string) => string>;
    /** Builds the ES-module URL for the same token — the example bundled as a
     * plain module rather than a sandboxed page.
     *
     * NO LONGER READ. Importing it mounted the storybook in this document,
     * which put a second build of the component library beside the app's; the
     * registry keeps the first constructor for a name, so the card rendered the
     * APP's component and said nothing. It also imported commit-authored code
     * into the review page's origin — the thing `harness.rs` forbids in its
     * first paragraph, because this page holds verdict submission capability.
     *
     * Kept so the `Source` plumbing behind it can be removed in one piece,
     * rather than half here and half in a file someone else is editing. */
    exampleModuleSrc?: Option<(example: string, className: string) => string>;
  };

  const serde: Lazy<Prosemirror.Markdown.Serde> = new Lazy(async () => {
    const pm = await Prosemirror.get();
    return pm.Markdown.buildSchema(
      [
        {
          id: "lisp_example",
          componentName: "std-lisp-example",
          attributeKeys: new Set(["code"]),
        },
        {
          id: "commit_artifact",
          componentName: "std-commit-artifact",
          attributeKeys: new Set(["src", "title", "height", "collapsed"]),
        },
        {
          id: "review_html",
          componentName: "std-review-html",
          attributeKeys: new Set(["src", "title", "height", "collapsed"]),
        },
        {
          id: "storybook_card",
          componentName: "std-storybook-card",
          attributeKeys: new Set(["example", "class"]),
        },
      ],
      { fileRefs: true },
    );
  });

  /** How a bind renders: the read-only document, or the same document
   * flipped editable with its serialized markdown streamed to `onUpdate`. */
  export type Mode = {
    editable: boolean;
    onUpdate: Option<(markdown: string) => void>;
  };

  async function bindNote(
    $note: Documentation,
    markdown: string,
    ctx: Ctx,
    mode: Mode,
  ): Promise<void> {
    const s = await serde.get();
    await $note.bind({
      markdown,
      serde: s,
      editable: mode.editable,
      onUpdate: mode.onUpdate ?? undefined,
      comments: ctx.comments ?? null,
      nodeViews: {
        lisp_example: (node) => new LispExampleView(node),
        code_block: (node) =>
          ReviewFence.dispatch(node, ctx.nav ?? null) ?? new CodeBlockView(node),
        commit_artifact: (node) => new CommitArtifactView(node, ctx),
        review_html: (node) => new ReviewHtmlView(node, ctx),
        storybook_card: (node) => new ReviewStorybookView(node, ctx),
        file_ref: (node) => new FileRefView(node, ctx.nav ?? null),
      },
    });
    // The comments controller (and so its panel) exists only after bind;
    // hand it to the caller for placement.
    const $panel = $note.commentsPanel();
    if ($panel != null) ctx.onCommentsPanel?.($panel);
  }

  /** A compact documentation block rendering `markdown` with inline commit
   * artifacts resolved against `ctx`. */
  export function make(markdown: string, ctx: Ctx): Documentation {
    const $note = Documentation.make();
    $note.toggleAttribute("compact", true);
    void bindNote($note, markdown, ctx, { editable: false, onUpdate: null });
    return $note;
  }

  /** Re-bind an existing note IN PLACE — the plan-page editor's flip: the
   * same element, serde and node views; only the markdown, the editable
   * flag and the comment feature change. Round-trip safety is the point of
   * routing edits through here: this serde is the one that parsed the page,
   * so its custom tags serialize back as themselves. */
  export function rebind(
    $note: Documentation,
    markdown: string,
    ctx: Ctx,
    mode: Mode,
  ): Promise<void> {
    return bindNote($note, markdown, ctx, mode);
  }

  // The names a note references inline. Used to split the artifact list:
  // referenced entries render in the note, the remainder stays on the chip
  // strip (the appendix). A raw-markdown scan, not a doc walk — the tag is
  // block-level and serializer-normalized, so attribute order is stable.
  const SRC_ATTR = /<(?:std-commit-artifact|std-review-html)\b[^>]*\bsrc="([^"]*)"/g;

  export function referencedArtifacts(note: string): Set<string> {
    const names = new Set<string>();
    for (const match of note.matchAll(SRC_ATTR)) {
      if (match[1] !== "") names.add(match[1]);
    }
    return names;
  }
}

class CommitArtifactView {
  dom: CommitArtifact;

  constructor(
    node: ProseMirrorEditor.ProseMirrorNode,
    private ctx: CommitNote.Ctx,
  ) {
    this.dom = CommitArtifact.make();
    this.apply(node);
  }

  private apply(node: ProseMirrorEditor.ProseMirrorNode): void {
    for (const key of ["src", "title", "height", "collapsed"]) {
      const value = (node.attrs[key] as string) || "";
      if (value !== "") this.dom.setAttribute(key, value);
      else this.dom.removeAttribute(key);
    }
    this.dom.bind({ artifacts: this.ctx.artifacts });
  }

  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "commit_artifact") return false;
    this.apply(node);
    return true;
  }

  destroy(): void {
    this.dom = null as any;
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

class ReviewHtmlView {
  dom: ReviewHtml;

  constructor(
    node: ProseMirrorEditor.ProseMirrorNode,
    private ctx: CommitNote.Ctx,
  ) {
    this.dom = ReviewHtml.make();
    this.apply(node);
  }

  private apply(node: ProseMirrorEditor.ProseMirrorNode): void {
    for (const key of ["src", "title", "height", "collapsed"]) {
      const value = (node.attrs[key] as string) || "";
      if (value !== "") this.dom.setAttribute(key, value);
      else this.dom.removeAttribute(key);
    }
    this.dom.bind({ artifacts: this.ctx.artifacts });
  }

  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "review_html") return false;
    this.apply(node);
    return true;
  }

  destroy(): void {
    this.dom = null as any;
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

/** The notice a card falls back to (no token, no source, a failed import, or a
 * condition the review node reported as data) — the note never renders a broken
 * embed silently.
 *
 * This is `<std-exception>`, not a local `div.artifact-view > pre`, and the
 * difference is visible: the headline lands on the red bar every other error in
 * the product uses, and `detail` lands in the syntax-highlighted code well
 * instead of being flattened into the same grey paragraph. A bun diagnostic is
 * the common case here, and it is forty lines of paths and quoted specifiers.
 *
 * Exported so `ReviewCardNoticeStoryBook` can render the real thing rather than
 * a copy of it. The copy is the point of that storybook — these strings are what
 * a reviewer actually reads when a card will not build, and half of them are
 * composed in Rust, where nothing shows them to anyone. */
export function $notice(message: string, detail: Option<string>): HTMLElement {
  return Exception.makeWith({ message, trace: { detail } });
}

/** `<std-storybook-card example="…/foo.example.ts" class="FooStoryBook">`:
 * renders the component the reviewed commit implements, built from the
 * checkout's own source, in the opaque-origin harness frame.
 *
 * The frame is not a fallback and not a compromise — it is the only
 * arrangement in which each custom element name has exactly one constructor. A
 * card mounted in THIS document brings a second build of the component library
 * with it, and the registry keeps whichever constructor registered first,
 * which is always the app because the app is the page. The card then renders
 * the app's component while sitting beside a diff claiming to change it, and
 * says nothing.
 *
 * Both historical objections to the frame are answered. It takes the app's
 * live design tokens over `postMessage`, so it is not stuck with a mirrored
 * palette (`harness.rs`), and it reports its content height, so the frame hugs
 * the figure rather than reading as a fixed foreign box. What remains is that
 * anything overflowing the component's own bounds — a popover, a tooltip —
 * clips at the frame edge, which is inherent to a separate document. */
class ReviewStorybookView {
  dom: HTMLElement;

  constructor(
    node: ProseMirrorEditor.ProseMirrorNode,
    private ctx: CommitNote.Ctx,
  ) {
    this.dom = document.createElement("div");
    this.apply(node);
  }

  private apply(node: ProseMirrorEditor.ProseMirrorNode): void {
    const example = (node.attrs.example as string) || "";
    const className = (node.attrs.class as string) || "";
    if (example === "" || className === "") {
      this.dom.replaceChildren(
        $notice(
          "std-storybook-card is missing an attribute",
          'It needs example="<path/to/x.example.ts>" and class="<StoryBook>", both relative to the repo the note belongs to.',
        ),
      );
      return;
    }
    // The frame, always. The card runs in its own document because that is the
    // only place its build can own the tags it registers — see the class
    // comment. There is no inline path to fall back to any more.
    const src = this.ctx.exampleSrc?.(example, className) ?? null;
    if (src == null) {
      this.dom.replaceChildren(
        $notice(
          "storybook example unavailable on this surface",
          "A live card is built from a checkout by the review node. This surface has no source behind it, so there is nothing to build.",
        ),
      );
      return;
    }
    this.dom.replaceChildren(
      ArtifactViewer.$view({
        name: "storybook",
        kind: "component",
        src,
        url: null,
        caption: null,
        text: null,
      }),
    );
  }

  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "storybook_card") return false;
    this.apply(node);
    return true;
  }

  destroy(): void {
    this.dom = null as any;
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}
