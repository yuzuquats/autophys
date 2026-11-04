import "../code/code";
import "./doc-comments";
import "../lisp-example/lisp-example";
import "../rich-text-editor/rich-text-editor";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { ProseMirrorEditor } from "../prosemirror";
import { RichTextEditor } from "../rich-text-editor/rich-text-editor";
import { Code } from "../code/code";
import { CodeBlockView } from "../code/code-block-view";
import { highlightText, SYNTAX_TOKEN_STYLE } from "../code/languages/highlight";
import type { Tokenizer } from "../code/languages/tokenizer";
import { DocComments } from "./doc-comments";
import { DocCommentsPanel } from "./doc-comments-panel";
import { LispExampleView } from "../lisp-example/lisp-example-view";
import { Prosemirror } from "../../ui/prosemirror-import";
import { Typography } from "../../ui/typography";
import { Lazy } from "@tento-core/lazy";
import { Scrollbars } from "../scrollbars";
import { MARKDOWN_TABLE_STYLE } from "./table-style";

@component({
  name: "std-documentation",
})
export class Documentation extends LonaWebComponent {
  private $editor: RichTextEditor = this.hydrate("editor");
  private commentsController: Option<DocComments.Controller> = null;

  static serde: Lazy<Prosemirror.Markdown.Serde> = new Lazy(async () => {
    const pm = await Prosemirror.get();
    return pm.Markdown.buildSchema(
      [Documentation.LISP_INSERT],
      { fileRefs: false },
    );
  });

  async bind({
    markdown,
    serde: _serde,
    nodeViews,
    inserts,
    comments,
    editable,
    onUpdate,
    inlineCodeLanguage,
  }: Documentation.Props = {}): Promise<this> {
    const extra = inserts ?? [];
    const serde = _serde ??
      (extra.length > 0
        ? await Documentation.buildSerde(extra)
        : await Documentation.serde.get());

    // An editable bind needs ProseMirror's own base rules (caret, gap
    // cursor, whitespace handling) in THIS shadow tree — the slotted editor
    // composes here, where the document-level sheet the rich-text editor
    // injects cannot reach. Keyed, so repeat binds are free.
    if (editable) {
      const { DEFAULT_STYLE } = await Prosemirror.get();
      this.addStyle("default-prosemirror", css(DEFAULT_STYLE));
    }

    // Annotation feature is opt-in: when `comments` is absent this branch is
    // skipped entirely and the editor binds exactly as before.
    this.commentsController?.destroy();
    this.commentsController = null;
    let plugins: Option<readonly Prosemirror.Plugin[]> = null;
    if (comments) {
      const controller = new DocComments.Controller(comments);
      this.commentsController = controller;
      plugins = [await controller.makePlugin()];
    }
    // State marker for hosts/tests; carries no styling of its own — the
    // editor's measure and padding belong to the host, commentable or not.
    this.toggleAttribute("data-comments", this.commentsController != null);
    const inlineTokenizer =
      inlineCodeLanguage == null ? null : Code.tokenizerFor(inlineCodeLanguage);
    if (inlineTokenizer != null) {
      plugins = [...(plugins ?? []), await Documentation.inlineCodePlugin(inlineTokenizer)];
    }

    await this.$editor.bind({
      markdown: markdown ?? "",
      editable: editable ?? false,
      onUpdate: onUpdate ?? undefined,
      serde,
      nodeViews: nodeViews ?? Documentation.resolveNodeViews(extra),
      plugins: plugins ?? undefined,
    });

    // The editor view now exists (its plugin `view()` captured it); load +
    // re-anchor + paint the persisted annotations.
    if (this.commentsController) await this.commentsController.load();
    return this;
  }

  /**
   * Colours inline code spans with a registered tokenizer, as decorations:
   * the document and its Markdown are unchanged. Built from the loaded
   * ProseMirror module so `Plugin` and the decoration classes are the same
   * instances the view uses.
   */
  private static async inlineCodePlugin(
    tokenizer: Tokenizer<unknown>,
  ): Promise<Prosemirror.Plugin> {
    const { Plugin, Decoration, DecorationSet } = await Prosemirror.get();
    const build = (doc: any) => {
      const decorations: Prosemirror.Decoration[] = [];
      doc.descendants((node: any, pos: number) => {
        if (!node.isText) return;
        if (!node.marks.some((mark: any) => mark.type.name === "code")) return;
        for (const span of highlightText(tokenizer, node.text)) {
          decorations.push(
            Decoration.inline(pos + span.from, pos + span.to, {
              class: `tok-${span.role}`,
            }),
          );
        }
      });
      return DecorationSet.create(doc, decorations);
    };
    return new Plugin({
      state: {
        init: (_config: unknown, state: any) => build(state.doc),
        apply: (tr: any, set: Prosemirror.DecorationSet) =>
          tr.docChanged ? build(tr.doc) : set,
      },
      props: {
        decorations(this: Prosemirror.Plugin, state: any) {
          return this.getState(state);
        },
      },
    });
  }

  /**
   * The annotations side panel, or `null` when this instance was bound without
   * `comments`. The consuming page places it into its own gutter/grid — keeps
   * this component layout-agnostic.
   */
  commentsPanel(): Option<DocCommentsPanel> {
    return this.commentsController?.panelElement() ?? null;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.commentsController?.destroy();
    this.commentsController = null;
  }

  /**
   * The built-in lisp insert, always registered so pre-existing docs keep
   * rendering `<std-lisp-example>` with no per-instance registration. Extra
   * inserts (per-instance, passed to {@link bind}) are appended to this.
   */
  private static readonly LISP_INSERT = {
    id: "lisp_example",
    componentName: "std-lisp-example",
    attributeKeys: new Set(["code"]),
  };

  /**
   * Build a per-instance markdown serde whose schema recognizes the built-in
   * lisp insert PLUS the caller's extra inserts. Kept off the shared static
   * `serde` Lazy because the extra set is instance-specific; a doc with no extra
   * inserts still uses the cached static serde (unchanged fast path).
   */
  private static async buildSerde(
    inserts: readonly Documentation.Insert[],
  ): Promise<Prosemirror.Markdown.Serde> {
    const pm = await Prosemirror.get();
    return pm.Markdown.buildSchema(
      [
        Documentation.LISP_INSERT,
        ...inserts.map((insert) => ({
          id: insert.id,
          componentName: insert.componentName,
          attributeKeys: new Set(insert.attributeKeys),
        })),
      ],
      { fileRefs: false },
    );
  }

  /**
   * The node-view map: the built-in lisp + code-block views plus one view per
   * extra insert (its `id` → its factory). Additive — the built-ins are always
   * present, so a caller's inserts never displace lisp/code rendering.
   */
  private static resolveNodeViews(
    inserts: readonly Documentation.Insert[],
  ): { [node: string]: ProseMirrorEditor.NodeViewConstructor } {
    const views: { [node: string]: ProseMirrorEditor.NodeViewConstructor } = {
      lisp_example: (node) => new LispExampleView(node),
      code_block: (node) => new CodeBlockView(node),
    };
    for (const insert of inserts) views[insert.id] = insert.nodeView;
    return views;
  }

  static $docStyle = css(/* css */ `
    :host {
      display: block;
    }

    #editor {
      width: 100%;
      cursor: default;
      height: auto !important;
    }

    .ProseMirror {
      max-width: var(--editor-max-width, 800px);
      margin: 0 auto;
      padding: var(--editor-padding, 32px 16px);
    }

    /* Reading surfaces explicitly opt in to heading emphasis. */
    h1, h2, h3, h4, h5, h6 {
      font-weight: var(--heading-weight, 600);
    }

    h1 {
      --font-size: var(--h1-size);
      --margin-top: 48px;
      --margin-bottom: 36px;
      color: var(--text-pri);
    }
    h2 {
      --font-size: var(--h2-size);
      --margin-top: 40px;
      --margin-bottom: 24px;
      color: var(--text-pri);
    }
    h3 {
      --font-size: var(--h3-size);
      --margin-top: 32px;
      --margin-bottom: 24px;
      color: var(--text-pri);
    }
    h4 {
      --font-size: var(--h4-size);
      --margin-top: 28px;
      --margin-bottom: 16px;
      color: var(--text-pri);
    }
    h5 {
      --font-size: var(--h5-size);
      --margin-top: 20px;
      --margin-bottom: 16px;
      color: var(--text-pri);
    }
    h6 {
      --margin-top: 20px;
      --margin-bottom: 16px;
      color: var(--text-pri);
    }
    p {
      --line-height-ratio: 1.5;
      --margin-top: 16px;
      --margin-bottom: 16px;
      --font-size: var(--text-11px);
      color: var(--text-sec);
    }
    .ProseMirror > :last-child {
      --margin-bottom: 0px !important;
    }
    .ProseMirror > :first-child {
      --margin-top: 0px !important;
    }
    ul, ol {
      --line-height-ratio: 1.5;
      --margin-top: 16px;
      --margin-bottom: 16px;
    }
    ul, #editor ol {
      padding-left: 24px;
    }
    code {
      --font-size: var(--text-9px);
      --line-height-ratio: 1.2;
      ${Typography.codeBlockRule}
      background: var(--code-bg, var(--bg-surface));
      /* Tight enough that a chip sits inside the line instead of pushing
         the lines around it apart. */
      padding: 1px 5px;
      margin-inline: 0px;
      border-radius: 4px;
      color: var(--text-pri);
      white-space: break-spaces;
      overflow-wrap: anywhere;
    }
    pre {
      --font-size: var(--text-9px, 0.5625rem);
      --line-height-ratio: 1.35;
      ${Typography.codeBlockRule}
      max-width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      background: var(--code-bg, var(--bg-surface));
      padding: 12px 14px;
      border-radius: 8px;
      margin-block: 20px;
    }
    pre code {
      display: block;
      font-size: inherit;
      line-height: inherit;
      background: transparent;
      padding: 0px;
      border-radius: 0px;
      white-space: pre;
      overflow-wrap: normal;
    }
    std-code {
      max-width: 100%;
      margin-block: 20px;
      /* Code blocks are monospace whatever font the page sets for prose;
         inline code and pre get the same stack from codeBlockRule. */
      font-family: ${Typography.MONO_STACK};
      --font-size: var(--text-9px, 0.5625rem);
      --line-height-ratio: 1.35;
    }
    @media (max-width: 768px) {
      pre, std-code {
        --font-size: var(--text-9px, 0.5625rem);
        --line-height-ratio: 1.4;
      }

      pre {
        padding: 8px 10px;
      }
    }
    li > p {
      --margin-top: 6px;
      --margin-bottom: 6px;
    }
    a {
      color: var(--text-pri);
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
      text-underline-offset: 3px;
      transition: text-decoration-color 120ms ease;
    }
    a:hover,
    a:focus-visible {
      text-decoration-color: currentColor;
    }
    a code {
      color: inherit;
    }
    /* Table cells set 13px text; a chip there steps down with them. */
    th code,
    td code {
      --font-size: var(--text-8px, 0.5rem);
      padding: 1px 4px;
    }
    hr {
      margin-block: 48px;
      flex-shrink: 0;
      background-color: var(--divider);
      height: 1px;
      width: 100%;
      outline: none;
      border: none;
    }

    .full-bleed {
      width: calc(100vw - var(--sidebar-width, 260px) - 2 * var(--margin-inline, 16px));
      max-width: none;
      margin-left: calc(-1 * (100vw - var(--sidebar-width, 260px) - 100%) / 2 + var(--margin-inline, 16px));
    }

    blockquote {
      --margin-top: 16px;
      --margin-bottom: 24px;
      background: var(--bg-surface);
      margin: var(--margin-top) 0px var(--margin-bottom);
      padding: 12px 18px;
      border-left: 3px solid var(--divider);
      border-radius: 0px 8px 8px 0px;
    }
    blockquote > :first-child {
      --margin-top: 0px;
    }
    blockquote > :last-child {
      --margin-bottom: 0px;
    }
  `);

  /** Long-form prose that keeps Lona's type scale but uses a tighter frame. */
  static $tightReadingStyle = css(/* css */ `
    :host([reading-density="tight"]) h1 {
      --font-size: var(--text-18px);
      --margin-top: 36px;
      --margin-bottom: 24px;
    }
    :host([reading-density="tight"]) h2 {
      --font-size: var(--text-16px);
      --margin-top: 32px;
      --margin-bottom: 18px;
    }
    :host([reading-density="tight"]) h3 {
      --font-size: var(--text-14px);
      --margin-top: 26px;
      --margin-bottom: 16px;
    }
    :host([reading-density="tight"]) h4 {
      --font-size: var(--text-12px);
      --margin-top: 22px;
      --margin-bottom: 14px;
    }
    :host([reading-density="tight"]) h5,
    :host([reading-density="tight"]) h6 {
      --font-size: var(--text-12px);
      --margin-top: 18px;
      --margin-bottom: 12px;
    }
    :host([reading-density="tight"]) p {
      --font-size: var(--text-9px);
      --line-height-ratio: 1.6;
      --margin-top: 32px;
      --margin-bottom: 32px;
    }
    :host([reading-density="tight"]) li > p {
      --margin-top: 0px;
      --margin-bottom: 12px;
    }
    :host([reading-density="tight"]) ul,
    :host([reading-density="tight"]) ol {
      --font-size: var(--text-10px);
      --line-height-ratio: 1.45;
      --margin-top: 12px;
      --margin-bottom: 12px;
    }
    :host([reading-density="tight"]) pre,
    :host([reading-density="tight"]) std-code {
      margin-block: 16px;
    }
  `);
  /**
   * `compact` attribute preset: dense typography for markdown embedded in a
   * host surface (e.g. the commit-review header note) rather than read as a
   * standalone document. Long-form doc scale — 16px paragraph margins, 48px
   * heading margins — reads far too airy there. Headings collapse to label
   * scale; block spacing roughly halves.
   */
  static $compactStyle = css(/* css */ `
    :host([compact]) p,
    :host([compact]) ul,
    :host([compact]) ol {
      --font-size: var(--text-10px);
      --line-height-ratio: 1.45;
      --margin-top: 8px;
      --margin-bottom: 8px;
    }
    :host([compact]) ul,
    :host([compact]) #editor ol {
      padding-left: 20px;
    }
    :host([compact]) h1,
    :host([compact]) h2,
    :host([compact]) h3 {
      --font-size: 13px;
      --margin-top: 16px;
      --margin-bottom: 6px;
    }
    :host([compact]) h4,
    :host([compact]) h5,
    :host([compact]) h6 {
      --font-size: 12px;
      --margin-top: 12px;
      --margin-bottom: 4px;
    }
    :host([compact]) code {
      font-size: 11px;
      padding: 2px 6px;
    }
    :host([compact]) pre {
      padding: 8px 10px;
      margin-block: 10px;
    }
    :host([compact]) std-code {
      margin-block: 10px;
    }
    :host([compact]) hr {
      margin-block: 12px;
    }
    :host([compact]) blockquote {
      --margin-top: 8px;
      --margin-bottom: 8px;
      padding: 8px 14px;
    }
    :host([compact]) table {
      margin-top: 12px;
      margin-bottom: 16px;
    }
    :host([compact]) th,
    :host([compact]) td {
      font-size: 12px;
      padding: 6px 10px;
    }
    :host([compact]) std-commit-artifact {
      margin-block: 10px;
    }
    :host([compact]) std-review-flow,
    :host([compact]) std-review-seq,
    :host([compact]) std-review-state,
    :host([compact]) std-review-callout,
    :host([compact]) std-review-compare,
    :host([compact]) std-review-table,
    :host([compact]) std-review-steps,
    :host([compact]) std-review-html,
    :host([compact]) std-review-storybook {
      margin-block: 10px;
    }
  `);

  /**
   * Shared markdown-table styling (matches dev.lona.so/docs/*).
   * The rules moved to their own module so a caller can reuse them without
   * pulling this component's graph — the code viewer, the lisp-example view
   * and the rich-text editor — in behind them. Kept as a static here because
   * that is where every existing caller reaches for it.
   */
  static $tableStyle = MARKDOWN_TABLE_STYLE;

  static $commentStyle = css`
    .doc-comment {
      background: color-mix(in srgb, var(--yellow) 32%, transparent);
    }

    .doc-comment--block {
      box-shadow: inset 3px 0 0 var(--yellow);
      background: color-mix(in srgb, var(--yellow) 22%, transparent);
      border-radius: 2px;
    }

    .doc-annot--resolved {
      opacity: 0.4;
      background: transparent;
      border-color: var(--divider);
    }

    /* Inline fallback for a review-agent fence. The commit-review service
       normally lifts the agent section out of the note before it renders
       (stack.rs split_agent_note), so this only appears where the note was
       not served by it — a storybook, an example, an older fleet service.
       Quiet and folded: agent bookkeeping is never required reading. */
    details.review-agent {
      margin-block: 10px;
      border: 1px solid var(--divider);
      border-radius: 6px;
      padding: 6px 10px;
      background: var(--bg-hover-light, transparent);
    }

    details.review-agent > summary {
      cursor: default;
      font-size: var(--text-11px, 11px);
      color: var(--text-ter, var(--text-sec));
      letter-spacing: 0.02em;
    }

    details.review-agent > pre {
      margin: 8px 0 2px;
      font-family: var(--mono, monospace);
      font-size: var(--text-11px, 11px);
      line-height: 1.55;
      color: var(--text-ter, var(--text-sec));
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `;

  static $styles = [
    Scrollbars.$opt,
    Documentation.$docStyle,
    Documentation.$tightReadingStyle,
    Documentation.$tableStyle,
    SYNTAX_TOKEN_STYLE,
    Documentation.$compactStyle,
    Documentation.$commentStyle,
    css`
      :host {
        --scroll-bar-style: none;
      }
      #editor {
        scrollbar-gutter: auto;
        min-height: 100%;
      }
      .ProseMirror {
        min-height: 100%;
      }

      @media (max-width: 768px) {
        .ProseMirror {
          padding: 24px 12px 32px;
        }

        .full-bleed {
          width: 100%;
          margin-left: 0px;
        }
      }
    `,
  ];

  static $html = html`
    <std-rich-text-editor id="editor"></std-rich-text-editor>
  `;
}

export namespace Documentation {
  /**
   * A per-instance markdown insert registration — the same shape as the built-in
   * lisp entry (a schema `id` + the custom-element `componentName` + the parsed
   * `attributeKeys`) plus the `nodeView` factory that renders it. Passed to
   * {@link Documentation.bind} via `inserts`; lets a consumer embed its own
   * custom components in markdown WITHOUT registering them inside this module
   * (which sits below tento-lona and must not import app/SDK components).
   */
  export interface Insert {
    readonly id: string;
    readonly componentName: string;
    readonly attributeKeys: readonly string[];
    readonly nodeView: ProseMirrorEditor.NodeViewConstructor;
  }

  export type Props = Optional<{
    markdown: string;
    serde: Prosemirror.Markdown.Serde;
    /** Colour inline code with the tokenizer std-code registers for this
     *  fence name (e.g. "sh"); unset leaves inline code plain. */
    inlineCodeLanguage: string;
    nodeViews?: Option<{
      [node: string]: ProseMirrorEditor.NodeViewConstructor;
    }>;
    /** Extra per-instance inserts, appended to the built-in lisp insert. */
    inserts?: Option<readonly Insert[]>;
    /**
     * Opt-in doc-comment feature (threaded comments on any text range or
     * top-level block). Absent → zero behavior change. The app supplies the
     * persistence client; the side panel is retrieved via
     * {@link Documentation.commentsPanel}.
     */
    comments?: Option<DocComments.Options>;
    /**
     * Flip the underlying ProseMirror view editable (the plan-page editor
     * flips the SAME rendered document, in place). Absent → the read-only
     * document this component has always been.
     */
    editable: boolean;
    /** Serialized-markdown stream for an editable bind. */
    onUpdate: (markdown: string) => void;
  }>;
}
