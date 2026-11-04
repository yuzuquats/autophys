// Side-effect import: the class below is referenced only as a type, and
// without this the bundler drops the module, the custom element never
// registers, and `hydrate` hands back an un-upgraded <std-prosemirror>.
import "../prosemirror";

import { Tracing } from "@tento-core/tracing";
import { Lazy } from "@tento-core/lazy";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Prosemirror } from "../../ui/prosemirror-import";
import { MARKDOWN_TABLE_STYLE } from "../documentation/table-style";
import type { ProseMirrorEditor } from "../prosemirror";

/** The GFM schema — tables, task lists, strikethrough. `fileRefs` stays
 * off: agent prose is full of path-like code spans, and retyping them into
 * `file_ref` atoms only pays off on a surface with a diff to navigate. */
const SERDE: Lazy<Prosemirror.Markdown.Serde> = new Lazy(async () => {
  const pm = await Prosemirror.get();
  return pm.Markdown.buildSchema([], { fileRefs: false });
});

/** Markdown, rendered by the markdown renderer this repo already has. It
 * began life as `std-turn-prose` — "what the agent says" — but nothing in it
 * knows about turns: `Props { source }`, a read-only editor, one stylesheet.
 * Only the name was chat vocabulary, so the name changed and the file moved;
 * the turn skin is now one caller among any.
 *
 * Two earlier answers here were wrong, in opposite directions. The first
 * rendered plain text and argued markdown belonged elsewhere; measuring
 * the corpus by coalesced message rather than by streamed chunk killed
 * that — 57.8% of whole assistant messages carry a construct, and inline
 * code alone is in 57.2%. The second hand-wrote a lowering, which got the
 * output right and the sourcing wrong: `std-prosemirror`'s markdown serde
 * already parses GFM, including the two things the hand-rolled version
 * left literal — tables and strikethrough. A second markdown parser in one
 * codebase is a second set of bugs and a second thing to keep in step with
 * the editors that share the schema.
 *
 * So this component is now typography and nothing else. It binds the
 * shared editor read-only and pushes one stylesheet into it.
 *
 * Two properties make that safe in a virtualized stream, and both are
 * load-bearing. `bind` is async — the ProseMirror module is lazily
 * imported and the first view is deferred out of the render frame — and
 * `std-agent-transcript` MEASURES row height with a ResizeObserver rather
 * than declaring it, so a row that fills in a later frame re-reports
 * itself instead of leaving a hole. And `onRecycle` destroys the view, so
 * a recycled row does not leak an editor.
 *
 * The stylesheet goes in through `addStyle` rather than this component's
 * own `$styles` because the document lives in the EDITOR's shadow root; a
 * bare `p { … }` rule here would match nothing at all. Only inherited
 * properties and custom properties cross that boundary.
 *
 * `Markdown.DEFAULT` is NOT the GFM serde — it is plain
 * prosemirror-markdown, and a table or a `~~strike~~` under it survives as
 * literal pipes and tildes, which is exactly the bug this component was
 * revised to fix. The rich schema comes from `buildSchema`, built once in
 * a module-level Lazy because nothing per-row may enter it. */
@component({ name: "std-markdown" })
export class Markdown extends LonaWebComponent {
  private generation = 0;
  private props: Option<Markdown.Props>;
  private pending = false;
  private $editor: ProseMirrorEditor = this.hydrate("editor");

  static makeWith(props: Markdown.Props): Markdown {
    return (Markdown.make() as Markdown).bind(props);
  }

  bind(props: Markdown.Props): this {
    // Keyed by id and idempotent, so a recycled row re-adopts the same
    // sheets instead of stacking copies. Tables come from the docs' sheet
    // unchanged — one markdown table look in the codebase, not two.
    this.$editor.addStyle("markdown-table", MARKDOWN_TABLE_STYLE);
    this.$editor.addStyle("std-turn-prose", Markdown.$document);
    this.props = props;
    const generation = ++this.generation;
    this.pending = true;
    // Fire-and-forget: only this occupant may bind the child after schema loading.
    void SERDE.get().then(async (serde) => {
      if (generation !== this.generation) return;
      await this.$editor.bind({ markdown: props.text, editable: false, serde });
      if (generation === this.generation) this.pending = false;
    }).catch(error => {
      if (generation !== this.generation) return;
      this.pending = false;
      Tracing.err("ui")("markdown/init-failed", error);
    });
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.props != null && !this.pending) this.bind(this.props);
  }

  disconnectedCallback(): void {
    this.generation++;
    this.pending = false;
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.generation++;
    this.pending = false;
    this.props = null;
    this.$editor.onRecycle();
    super.onRecycle();
  }

  /** Adopted INTO the editor's shadow root. Selectors are scoped under
   * `.ProseMirror` so they outrank the editor's own bare `li`/`ol`/`pre`
   * defaults regardless of which sheet is appended last. */
  static $document = css`
    #editor {
      /* The editor is chrome-less here: a transcript row is not a
         scroll container and has no caret. */
      overflow: visible !important;
      height: auto !important;
      min-height: 0 !important;
      cursor: auto;
      /* Load-bearing, and not obviously so. std-prosemirror declares
         :host { display: contents; width: 200px } and then
         #editor { width: inherit }. Under display: contents the host
         draws no box, so the 200px never LOOKS like a width — but it is
         still the host's computed value, and inherit copies it straight
         onto the editor. Every prose row was 200px wide inside a 1060px
         column until this line; std-documentation carries the same
         override, for the same reason. */
      width: 100% !important;
    }
    .ProseMirror {
      padding: 0;
      color: var(--text-pri, #1f2328);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .ProseMirror > :first-child {
      margin-top: 0;
    }
    .ProseMirror > :last-child {
      margin-bottom: 0;
    }
    /* The reply's body, on the app's paragraph size. --font-size goes on
       the paragraphs themselves rather than the editor: p is a ramp
       selector and sets --font-size to --p-size on itself, so a value
       inherited from the container would be overwritten a level down.

       Agent prose is read in long runs, and 1.75 is looser than the docs'
       own 1.6 because of it.

       The seam between paragraphs has to beat the line advance INSIDE one,
       or two paragraphs read as a single block set slightly tight. These
       margins are baseline-to-capheight numbers: at this size and ratio,
       consecutive baselines sit 24.3px apart under a 10px cap — a 14.3px
       baseline-to-cap advance — so the 10px this first shipped with drew
       the paragraph break 4.3px TIGHTER than the lines it separates (the
       rendered boxes overlapped by that much). 20px is the docs' own
       proportion — their 16px seam over an 11.9px advance — applied to
       this looser leading, and it has to move if the ratio does. */
    .ProseMirror p {
      --font-size: var(--p-size);
      --line-height-ratio: 1.75;
      --margin-top: 0px;
      --margin-bottom: 20px;
    }
    .ProseMirror h1,
    .ProseMirror h2,
    .ProseMirror h3,
    .ProseMirror h4,
    .ProseMirror h5,
    .ProseMirror h6 {
      margin: 14px 0 6px;
      font-weight: 600;
      line-height: 1.35;
    }
    /* DERIVED from the body, not picked. A reply's headings are the one
       thing that legitimately outranks the reading size, and two steps is
       all a chat reply has ever needed; expressing them as offsets means
       the whole document moves when the scale does, instead of the body
       sliding out from under a pair of frozen numbers. h3 and down are
       the body size and say "heading" with weight and colour, which is
       what a heading four levels deep is actually worth. */
    /* A reply's headings come off the app's heading aliases, two steps
       and then the body size. h3 and down say "heading" with weight and
       colour, which is what a heading four levels deep is worth. */
    .ProseMirror h1 {
      --font-size: var(--h5-size);
    }
    .ProseMirror h2 {
      --font-size: var(--h6-size);
    }
    .ProseMirror h3,
    .ProseMirror h4,
    .ProseMirror h5,
    .ProseMirror h6 {
      --font-size: var(--p-size);
      color: var(--text-sec);
    }
    .ProseMirror ul,
    .ProseMirror ol {
      margin: 0 0 10px;
      padding-left: 22px;
    }
    .ProseMirror li {
      margin: 2px 0;
    }
    .ProseMirror li > p {
      margin: 0;
    }
    .ProseMirror code {
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      --font-size: var(--turn-fine-size, var(--text-8px));
      padding: 1px 4px;
      border-radius: 4px;
      background: var(--surface-sunken, rgba(127, 127, 127, 0.12));
    }
    /* Code must not be reflowed to fit; it scrolls inside its own box so
       the reading column stays put. */
    .ProseMirror pre {
      margin: 0 0 10px;
      padding: 8px 10px;
      border: 1px solid var(--divider, rgba(127, 127, 127, 0.25));
      border-radius: 6px;
      background: var(--surface-sunken, rgba(127, 127, 127, 0.08));
      overflow-x: auto;
      white-space: pre;
    }
    .ProseMirror pre code {
      padding: 0;
      background: none;
      --font-size: var(--turn-fine-size, var(--text-8px));
      --line-height-ratio: 1.5;
    }
    .ProseMirror blockquote {
      margin: 0 0 10px;
      padding-left: 10px;
      border-left: 2px solid var(--divider, rgba(127, 127, 127, 0.35));
      color: var(--text-sec, #59616e);
    }
    /* Tables are NOT styled here — MARKDOWN_TABLE_STYLE is adopted
       alongside this sheet. The boxed, hairline-gridded table this file
       used to declare was a second table look for the same markdown the
       docs already render, and the two had drifted apart on every value:
       border, padding, type size. The only thing the transcript adds is
       the tighter block rhythm below. */
    .ProseMirror table {
      margin-top: 4px;
      margin-bottom: 12px;
      white-space: normal;
    }
    .ProseMirror a {
      color: var(--accent, #4a7dff);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
  `;

  static $styles = [
    css`
      :host {
        display: block;
        min-width: 0;
        width: 100%;
      }
      /* Crosses into the editor by inheritance: its ProseMirror block
         reads padding from this custom property. */
      #editor {
        --editor-padding: 0;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root"><std-prosemirror id="editor"></std-prosemirror></div>
  `;
}

export namespace Markdown {
  export type Props = {
    /** The coalesced message body, as the agent wrote it — markdown. */
    text: string;
  };
}
