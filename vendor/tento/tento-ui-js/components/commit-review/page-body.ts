import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Documentation } from "../documentation/documentation";
import { CommitNote } from "./commit-note";

// A plan page's rendered body, as the diff pane hosts it (plan-reader rev 2 —
// "the file card, rendered"). The diff view accepts an opaque rendered-body
// builder per path; this component is what that builder mounts: the page's
// markdown through the note's own pipeline beside the page's own comment
// gutter, in ONE self-contained element.
//
// Self-contained is the point. The note column gets this same shape from
// stack-review's `appendNote`, whose grid classes are styled in
// std-stack-review's shadow root — unreachable from inside std-diff-file's
// shadow tree, where this content lands. So the grid travels here, in this
// component's own styles, and the element works in any host.
//
// It is also the app-token island inside the VSCode-dark file card: this
// component renders in app tokens on purpose (the seam is the design — the
// diff keeps its palette, the document keeps the app's).

@component({ name: "std-page-body" })
export class PageBody extends LonaWebComponent {
  private $layout: HTMLElement = this.$("layout");
  private $doc: HTMLElement = this.$("doc");
  private $hint: HTMLElement = this.$("hint");
  private $state: HTMLElement = this.$("state");
  private note: Option<Documentation> = null;
  private noteCtx: Option<CommitNote.Ctx> = null;

  /** Construct + bind in one call — the house pattern for a component whose
   * every caller does exactly that (cf. `RevisionStrip.makeWith`). */
  static makeWith(vm: PageBody.ViewModel): PageBody {
    return PageBody.make().bind(vm);
  }

  bind(vm: PageBody.ViewModel): this {
    this.$state.toggleAttribute("hidden", true);
    this.$doc.replaceChildren();
    const withPanel: CommitNote.Ctx = {
      ...vm.ctx,
      onCommentsPanel: ($panel) => {
        $panel.classList.add("gutter");
        $panel.onEmptyChange = (empty) => this.$hint.toggleAttribute("shown", empty);
        this.$layout.appendChild($panel);
      },
    };
    const $note = CommitNote.make(vm.markdown, withPanel);
    $note.classList.add("doc-note");
    this.$doc.appendChild($note);
    this.note = $note;
    this.noteCtx = withPanel;
    return this;
  }

  /** Flip the rendered document editable IN PLACE — the project pane's edit
   * verb. Same element, same pipeline, same typography; only the ProseMirror
   * view's editable flag flips. Comments park while editing (their anchors
   * describe prose the edit is rewriting — the controller's teardown removes
   * the gutter); `read` restores the read view, gutter included. */
  edit(markdown: string, onUpdate: (markdown: string) => void): Promise<void> {
    const $note = this.note;
    const ctx = this.noteCtx;
    if ($note == null || ctx == null) return Promise.resolve();
    // The comment hint belongs to the parked feature; a fresh read bind's
    // panel re-toggles it through `onEmptyChange`.
    this.$hint.toggleAttribute("shown", false);
    return CommitNote.rebind($note, markdown, { ...ctx, comments: null }, {
      editable: true,
      onUpdate,
    });
  }

  /** Back to the read-only document, rendered around `markdown` (the tip
   * bytes the editor started from — a discard must not keep edits). */
  read(markdown: string): Promise<void> {
    const $note = this.note;
    const ctx = this.noteCtx;
    if ($note == null || ctx == null) return Promise.resolve();
    return CommitNote.rebind($note, markdown, ctx, {
      editable: false,
      onUpdate: null,
    });
  }

  /** A one-line state (loading / error) in place of the document — used by
   * the owner while the page content is in flight. */
  setState(text: string): this {
    this.$state.textContent = text;
    this.$state.toggleAttribute("hidden", false);
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        background: var(--bg);
        border: 1px solid var(--divider);
        border-radius: 8px;
        padding: 12px 14px;
      }

      /* Flush: the host surface (the project page's accordion) already frames
         each doc — drop the island chrome and every inset, editor column
         included, so the text aligns with the host's own content padding. */
      :host([flush]) {
        background: none;
        border: none;
        border-radius: 0;
        padding: 0;
        --editor-padding: 0;
      }

      /* The same two shapes the note column uses, keyed off THIS element's
         real width (container query): stacked comments below the doc when
         narrow, a 320px side gutter when there is room. */
      #root {
        container-type: inline-size;
      }

      #layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 12px;
        align-items: start;
      }

      #doc-col {
        min-width: 0;
        order: 1;
      }

      /* Lona typography, not bare font-size: the .text class + --font-size
         token (baseline-capheight) is what the rest of the app sizes with. */
      #hint {
        display: none;
        --font-size: var(--text-8px);
        --margin-top: 10px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }

      #hint[shown] {
        display: block;
      }

      #state {
        --font-size: var(--text-9px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-ter);
      }

      #state[hidden] {
        display: none;
      }

      #layout .gutter {
        order: 2;
        align-self: start;
        min-width: 0;
      }

      @container (min-width: 720px) {
        #layout {
          grid-template-columns: minmax(0, 1fr) 320px;
          gap: 24px;
        }

        #layout .gutter {
          align-self: stretch;
          position: relative;
          margin-top: 10px;
        }
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <div id="state" class="text" hidden></div>
      <div id="layout">
        <div id="doc-col">
          <div id="doc"></div>
          <div id="hint" class="text">Select any text, or hover a block's gutter handle, to comment.</div>
        </div>
      </div>
    </div>
  `;
}

export namespace PageBody {
  export type ViewModel = {
    /** The page's markdown at the draft's tip. */
    markdown: string;
    /** The note pipeline's context — artifacts, storybook cards, and the
     * page's OWN comments store (`<cid>/<page>`); `onCommentsPanel` is
     * overridden here (the grid owns panel placement). */
    ctx: CommitNote.Ctx;
  };
}
