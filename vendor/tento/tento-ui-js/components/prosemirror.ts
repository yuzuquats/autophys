import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css, Style } from "../component-styles";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../dom";
import { $$ } from "../fastdom";
import { Hotkeys } from "../hotkeys";
import { Scrollbars } from "./scrollbars";
import { Prosemirror } from "../ui/prosemirror-import";
import { Tracing } from "@tento-core/tracing";

const SCROLL_OVERFLOW_TOLERANCE_PX = 1;

/**
 * ProseMirror's DOMObserver is internal but stable: `stop()` disconnects the
 * MutationObserver and the selectionchange listener, `start()` re-attaches.
 * The bystander guard below needs exactly those two.
 */
type ViewWithObserver = Prosemirror.EditorView & {
  domObserver: { stop(): void; start(): void };
};

/** Every editor that currently owns a live EditorView. */
const LIVE_EDITORS = new Set<ProseMirrorEditor>();

/** Refcount for nested suspend brackets (module-level: a static private
 * identifier cannot share a class with the experimental decorator). */
let observerSuspendDepth = 0;

@component({
  name: "std-prosemirror",
})
export class ProseMirrorEditor extends LonaWebComponent {

  /*
   Bystander guard
   =============================================================================
   A structural rebind (a view-config switch, a sheet swap) rewrites cell DOM
   wholesale around editors that are not being edited — and every live view's
   DOMObserver reacts to the churn with deep selection/node compares (measured:
   39% of a switch's fastdom flush was ProseMirror `eq` from bystander views).
   The renderer that owns the bulk mutation brackets it with suspend/resume;
   nested brackets are refcounted. A view created while suspended starts
   suspended; a suspended observer that missed external mutations is exactly
   the point — the editors' own DOM is not touched by the pass (content
   replacements destroy and recreate their views).
  */
  static suspendObservers(): void {
    if (++observerSuspendDepth > 1) return;
    for (const editor of LIVE_EDITORS) {
      // The editor the user is typing in is never a bystander: a promotion
      // of the very cell being edited is a VM swap, and suspending the
      // focused editor there is the keystroke-loss shape (IME and
      // mutation-carried input ride the observer). The focusin fast-path
      // only covers focus gained AFTER the bracket opens; this covers
      // focus held when it opens.
      if (editor.view?.hasFocus()) continue;
      editor.#setObserverRunning(false);
    }
  }

  static resumeObservers(): void {
    if (observerSuspendDepth === 0) return;
    if (--observerSuspendDepth > 0) return;
    for (const editor of LIVE_EDITORS) editor.#setObserverRunning(true);
  }

  #setObserverRunning(running: boolean): void {
    const view = this.view;
    if (!view) return;
    const observer = (view as ViewWithObserver).domObserver;
    if (!observer) return;
    if (running) observer.start();
    else observer.stop();
  }
  static defaultSheet: Option<Style.Compat> = null;
  private $editor = this.$("editor");
  private view: Option<Prosemirror.EditorView>;
  #value: Option<string>;
  /**
   * Lazy mode (`Props.lazy`): the document is painted as static markup on
   * bind — the same DOM the view would produce, through the schema's own
   * `DOMSerializer` — and the `EditorView` is built only when someone reaches
   * for the cell (pointer-down, focus, or `focusEditor()`). A sheet full of
   * text cells then pays for parsing and one `replaceChildren` per bind
   * instead of a view with plugins, history and a mutation observer per cell.
   * `pendingView` holds everything `activate()` needs to build the view later.
   */
  private pendingView: Option<{
    prosemirror: Prosemirror;
    serde: Prosemirror.Markdown.Serde;
    markdown: Option<string>;
    placeholder: Option<string>;
    nodeViews: Option<ProseMirrorEditor.Props["nodeViews"]>;
    plugins: Option<readonly Prosemirror.Plugin[]>;
  }> = null;
  /** Serializers are per schema and shared by every static cell. */
  private static serializers = new WeakMap<Prosemirror.Schema, Prosemirror.DomSerializer>();
  initialized: boolean = false;
  private viewGeneration: number = 0;
  private bindGeneration = 0;
  private props: Option<ProseMirrorEditor.Props>;
  private pending = false;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.props != null && this.view == null && this.pendingView == null && !this.pending) {
      void this.bind(this.props).catch(error => Tracing.err("ui")("prosemirror/reconnect-failed", error));
    }
  }

  get value(): Option<string> {
    return this.#value;
  }

  hasHorizontalOverflow(): boolean {
    return (
      this.$editor.scrollWidth - this.$editor.clientWidth >
      SCROLL_OVERFLOW_TOLERANCE_PX
    );
  }

  hasContentOverflow(): boolean {
    return (
      this.hasHorizontalOverflow() ||
      this.$editor.scrollHeight - this.$editor.clientHeight >
        SCROLL_OVERFLOW_TOLERANCE_PX
    );
  }

  /** Pending mount signal for the current `viewGeneration`'s editor DOM.
   *  Armed when a view create is scheduled, settled from the mount mutate
   *  itself; teardown or a superseding bind resolves it so no awaiter hangs. */
  private layoutWait: Option<{
    generation: number;
    promise: Promise<void>;
    settle: () => void;
  }> = null;

  /** Resolves once the current bind()'s editor DOM has been appended and a
   *  fastdom read phase has run after it — the earliest moment the overflow
   *  reads are meaningful. Settled from the mount mutate itself, never by
   *  polling: `bind()` schedules the append, so the mount is a known event,
   *  not one to be discovered. With nothing pending (never bound, torn down,
   *  or already mounted) this resolves immediately; a rebind mid-wait
   *  resolves the superseded wait. */
  waitForLayout(): Promise<void> {
    return this.layoutWait?.promise ?? Promise.resolve();
  }

  /** Idempotent per generation: the deferred first-create arms at schedule
   *  time (so waits opened before the deferred fires still block) and
   *  `createView` arms again with the same generation — a no-op then. */
  private armLayoutWait(generation: number): void {
    if (this.layoutWait?.generation === generation) return;
    this.layoutWait?.settle();
    let settle: () => void = Constants.EMPTY_FUNCTION;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.layoutWait = { generation, promise, settle };
  }

  /** Settle `generation`'s wait one batched read phase after the mount
   *  mutate, so awaiters resume exactly where layout reads belong. */
  private settleLayoutWait(generation: number): void {
    $$.measure(() => {
      if (this.layoutWait?.generation !== generation) return;
      this.layoutWait.settle();
      this.layoutWait = null;
    });
  }

  constructor() {
    super();
    this.onkeydown = this.onkeyup = (e) => {
      const hotkey = DomUtils.hotkeyIdentifier(e);
      if (!hotkey) return;
      if (Hotkeys.allowedHotkeyInEditor(hotkey)) return;
      if (Hotkeys.shouldPreventDefault(hotkey)) e.preventDefault();
      e.stopPropagation();
    };
    // Interaction fast-path for the bystander guard: an editor the user
    // enters must never be deaf, whatever bracket is open. Restarting an
    // already-running observer is harmless (observe() replaces the
    // registration; the selectionchange listener dedupes -- PM binds it once).
    this.addEventListener("focusin", () => {
      if (observerSuspendDepth > 0) this.#setObserverRunning(true);
      // Lazy cell reached by keyboard (Tab) or a programmatic focus.
      if (this.pendingView != null) this.activate("focus");
    });
    // Lazy cell reached by pointer: build the view on pointer-down. Building
    // it replaces the static node under the pointer, so the mousedown that
    // follows lands on the editor's container, not on text: ProseMirror
    // places no caret, the mousedown's default moves focus to the page, and
    // the user's first keystrokes are lost. The press therefore focuses the
    // view itself, with the caret where it landed, and keeps that mousedown
    // from taking the focus back.
    this.addEventListener("pointerdown", (event) => {
      if (this.pendingView == null) return;
      this.activate("pointer");
      this.#focusAtPress(event.clientX, event.clientY);
    }, { capture: true });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (!this.pending && this.props != null) this.props = { ...this.props, markdown: this.currentMarkdown };
    this.bindGeneration++;
    this.pending = false;
    this.viewGeneration++;
    this.pendingView = null;
    LIVE_EDITORS.delete(this);
    this.layoutWait?.settle();
    this.layoutWait = null;
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.initialized = false;
    DomUtils.clearChildren(this.$editor);
  }

  onRecycle() {
    super.onRecycle();
    this.bindGeneration++;
    this.pending = false;
    this.props = null;
    this.viewGeneration++;
    this.pendingView = null;
    LIVE_EDITORS.delete(this);
    this.layoutWait?.settle();
    this.layoutWait = null;
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.initialized = false;
    this.currentMarkdown = null;
    this.delegate = Constants.EMPTY_FUNCTION;
    this.editable = false;
    this.#value = null;
    DomUtils.clearChildren(this.$editor);
  }

  private currentMarkdown: Option<string>;
  private delegate: (md: string) => void = Constants.EMPTY_FUNCTION;
  private onUpdateMd(md: string) {
    const mdChanged = this.currentMarkdown !== md;
    this.currentMarkdown = md;
    if (mdChanged) {
      this.delegate(md);
    }
  }
  private editable: boolean = false;

  focusEditor() {
    if (this.pendingView != null) this.activate("focus");
    this.view?.focus();
  }

  /** Whether this editor is painted statically, awaiting activation. */
  get isStatic(): boolean {
    return this.pendingView != null && this.view == null;
  }

  async bind(props: ProseMirrorEditor.Props = {}): Promise<this> {
    const { onUpdate, markdown, editable, placeholder, nodeViews, plugins, serde: _serde, lazy } = props;
    const previousProps = this.props;
    this.props = props;
    const binding = ++this.bindGeneration;
    this.pending = true;
    let prosemirror: Prosemirror;
    try { prosemirror = await Prosemirror.get(); }
    catch (error) { if (binding === this.bindGeneration) this.pending = false; throw error; }
    if (binding !== this.bindGeneration) return this;
    this.pending = false;
    const { EditorState, EditorView, Markdown, Plugins, DEFAULT_STYLE } = prosemirror;
    const serde = _serde ?? Markdown.DEFAULT;

    const previous = {
      view: this.view,
      editable: this.editable,
      md: this.currentMarkdown,
    };

    this.delegate = onUpdate ?? Constants.EMPTY_FUNCTION;
    this.currentMarkdown = markdown;
    this.editable = editable ?? true;
    this.toggleAttribute("disabled", !this.editable);

    if (
      previous.md === markdown &&
      previous.editable === this.editable &&
      this.view != null && previousProps?.plugins === plugins &&
      previousProps?.nodeViews === nodeViews && previousProps?.serde === _serde &&
      previousProps?.placeholder === placeholder
    ) {
      return this;
    }
    // Lazy, with a view nobody is in now: go back to static markup rather
    // than rebuild a view for a new document (a hidden face rebound on every
    // keystroke elsewhere). Someone reaching for it builds the view again.
    if (lazy && previous.view != null && !this.matches(":focus-within")) {
      this.viewGeneration++;
      LIVE_EDITORS.delete(this);
      DomUtils.clearChildren(this.$editor);
      previous.view.destroy();
      this.view = null;
    }
    // Lazy: no view yet and nobody has reached for it — paint static markup
    // and remember what the view needs. A later bind while still static just
    // repaints; a bind while someone is in the view takes the live path below.
    if (lazy && this.view == null) {
      const pending = this.pendingView;
      this.pendingView = { prosemirror, serde, markdown, placeholder: placeholder ?? null, nodeViews: nodeViews ?? null, plugins: plugins ?? null };
      this.#value = markdown;
      // Callbacks and eventual-view configuration above always advance. Only
      // equal static paint inputs can keep the serialized DOM (including a
      // first paint already queued under this generation).
      if (pending != null && pending.prosemirror === prosemirror &&
          pending.serde === serde && pending.markdown === markdown &&
          pending.placeholder === (placeholder ?? null) &&
          previous.editable === this.editable) return this;
      const gen = ++this.viewGeneration;
      if (!this.initialized) {
        ProseMirrorEditor.defaultSheet ??= css(DEFAULT_STYLE);
        this.addStyle("default-prosemirror", ProseMirrorEditor.defaultSheet);
        this.initialized = true;
      }
      this.armLayoutWait(gen);
      $$.mutate(() => {
        if (this.viewGeneration !== gen || this.pendingView == null) return;
        this.renderStatic(serde, markdown, this.editable ? (placeholder ?? "") : "");
        this.settleLayoutWait(gen);
      });
      return this;
    }
    this.pendingView = null;

    if (previous.view) {
      this.viewGeneration++;
      DomUtils.clearChildren(this.$editor);
      previous.view.destroy();
      this.view = null;
    } else if (!this.initialized) {
      ProseMirrorEditor.defaultSheet ??= css(DEFAULT_STYLE);
      this.addStyle("default-prosemirror", ProseMirrorEditor.defaultSheet);
      this.initialized = true;
    }

    const doc = markdown
      ? (serde.parser.parse(markdown) ?? undefined)
      : undefined;

    this.#value = markdown;

    const createView = () => {
      const gen = this.viewGeneration;
      this.armLayoutWait(gen);
      LIVE_EDITORS.add(this);
      this.view = new EditorView(
        ($root: HTMLElement) => {
          $$.mutate(() => {
            if (this.viewGeneration !== gen) return;
            this.$editor.appendChild($root);
            this.settleLayoutWait(gen);
          });
        },
        {
          dispatchTransaction: (transaction) => {
            if (this.viewGeneration !== gen) return;
            const state = this.view!.state.apply(transaction);
            const md = serde.serializer.serialize(state.doc, {
              tightLists: false,
            });
            this.#value = md;
            this.onUpdateMd(md);
            this.view!.updateState(state);
          },
          state: EditorState.create({
            doc,
            schema: serde.schema,
            plugins: [
              Plugins.buildInputRules(serde.schema),
              Plugins.history(),
              Plugins.keymap(Plugins.defaultKeymap(serde.schema)),
              Plugins.keymap({ "Mod-z": Plugins.undo, "Mod-y": Plugins.redo }),
              Plugins.keymap(Plugins.baseKeymap),
              Plugins.dropCursor(),
              Plugins.gapCursor(),
              Plugins.linkClick(),
              Plugins.placeholder(
                this,
                this.editable ? (placeholder ?? "") : "",
              ),
              ...(plugins ?? []),
            ],
          }),
          editable: () => this.editable,
          ...(nodeViews != null ? { nodeViews } : {}),
        },
      );
      // A view born inside a suspend bracket must not observe the bulk pass.
      if (observerSuspendDepth > 0) {
        this.#setObserverRunning(false);
      }
    };

    // First creation: defer out of the current render frame so ProseMirror
    // module evaluation and DOM init don't block the first fastdom flush.
    // Subsequent updates (replacing an existing view): run synchronously.
    // Generation counter ensures only the last-scheduled deferred create
    // executes — prevents stacked editors when bind() is called multiple times
    // before the deferred fires (e.g. multiple renders before first macrotask).
    if (!this.view) {
      const gen = ++this.viewGeneration;
      this.armLayoutWait(gen);
      $$.deferMutate(() => {
        if (this.viewGeneration !== gen) return;
        DomUtils.clearChildren(this.$editor);
        createView();
      });
    } else {
      createView();
    }

    return this;
  }

  /** Paint the document as the markup the view would produce, without a view. */
  private renderStatic(serde: Prosemirror.Markdown.Serde, markdown: Option<string>, placeholder: string): void {
    const { DOMSerializer } = this.pendingView!.prosemirror;
    let serializer = ProseMirrorEditor.serializers.get(serde.schema);
    if (!serializer) {
      serializer = DOMSerializer.fromSchema(serde.schema);
      ProseMirrorEditor.serializers.set(serde.schema, serializer);
    }
    const $pm = document.createElement("div");
    // Same class the live view carries, so the shared stylesheet and every
    // consumer selector see one shape whether or not a view exists.
    $pm.className = "ProseMirror";
    $pm.toggleAttribute("data-static", true);
    // Static editable content still participates in native Tab navigation.
    // focusin replaces this stop with the live view and transfers focus to it.
    if (this.editable) $pm.tabIndex = 0;
    const doc = markdown ? (serde.parser.parse(markdown) ?? null) : null;
    if (doc != null && doc.content.size > 0) {
      $pm.appendChild(serializer.serializeFragment(doc.content));
    } else if (placeholder) {
      $pm.setAttribute("placeholder", placeholder);
      $pm.appendChild(document.createElement("p"));
    }
    if (!this.editable) {
      // A read-only static cell never activates; its links must still work.
      for (const $a of $pm.querySelectorAll("a[href]")) {
        $a.setAttribute("target", "_blank");
        $a.setAttribute("rel", "noopener");
      }
    }
    this.$editor.replaceChildren($pm);
  }

  /**
   * A press that built the view: focus it with the caret at the press
   * (`left`, `top`, viewport coordinates), or at the end of the text where no
   * position is under the press.
   */
  #focusAtPress(left: number, top: number): void {
    const view = this.view;
    if (view == null) return;
    const pos = view.posAtCoords({ left, top })?.pos ?? view.state.doc.content.size;
    view.focus();
    // The DOM selection is shared across shadow roots; ProseMirror reads the
    // caret back from it (its selection observer), as from a click.
    const { node, offset } = view.domAtPos(pos);
    document.getSelection()?.collapse(node, offset);
    // The press's own mousedown follows in the same task: its default would
    // blur the view, so it is cancelled, once. (A touch press sends its
    // mousedown later, onto the view, which places the caret itself.)
    const keepFocus = (event: Event) => event.preventDefault();
    this.addEventListener("mousedown", keepFocus, { capture: true, once: true });
    setTimeout(() => this.removeEventListener("mousedown", keepFocus, { capture: true }), 0);
  }

  /**
   * Build the view a lazy bind deferred. Synchronous on purpose: from a
   * pointer-down it must finish before the mousedown that follows, and from a
   * focus it must exist before focus lands. Read-only cells stay static.
   * `"pointer"` builds it without moving focus (a hover or an idle mount; a
   * press also focuses it, see the pointer-down listener); `"focus"` focuses it.
   */
  activate(reason: "pointer" | "focus"): void {
    const pending = this.pendingView;
    if (pending == null || this.view != null) return;
    if (!this.editable) return;
    this.pendingView = null;
    const { EditorState, EditorView, Plugins } = pending.prosemirror;
    const { serde } = pending;
    const gen = ++this.viewGeneration;
    const doc = pending.markdown ? (serde.parser.parse(pending.markdown) ?? undefined) : undefined;
    LIVE_EDITORS.add(this);
    this.$editor.replaceChildren();
    this.view = new EditorView(
      ($root: HTMLElement) => {
        this.$editor.appendChild($root); // synchronous — see above
      },
      {
        dispatchTransaction: (transaction) => {
          if (this.viewGeneration !== gen) return;
          const state = this.view!.state.apply(transaction);
          const md = serde.serializer.serialize(state.doc, { tightLists: false });
          this.#value = md;
          this.onUpdateMd(md);
          this.view!.updateState(state);
        },
        state: EditorState.create({
          doc,
          schema: serde.schema,
          plugins: [
            Plugins.buildInputRules(serde.schema),
            Plugins.history(),
            Plugins.keymap(Plugins.defaultKeymap(serde.schema)),
            Plugins.keymap({ "Mod-z": Plugins.undo, "Mod-y": Plugins.redo }),
            Plugins.keymap(Plugins.baseKeymap),
            Plugins.dropCursor(),
            Plugins.gapCursor(),
            Plugins.linkClick(),
            Plugins.placeholder(this, this.editable ? (pending.placeholder ?? "") : ""),
            ...(pending.plugins ?? []),
          ],
        }),
        editable: () => this.editable,
        ...(pending.nodeViews != null ? { nodeViews: pending.nodeViews } : {}),
      },
    );
    if (observerSuspendDepth > 0) this.#setObserverRunning(false);
    if (reason === "focus") this.view.focus();
  }

  static $styles = [
    Scrollbars.$opt,
    css`
      :host {
        display: contents;
        width: 200px;
        min-height: 24px;
        cursor: text;
        overflow-x: hidden;
        overflow-y: scroll;
        background-clip: padding-box;
        color: var(--text-sec);
      }

      :host([disabled]) {
        cursor: default;
      }

      #editor {
        height: inherit;
        width: inherit;
        min-height: inherit;
        overflow-x: var(--editor-overflow-x, inherit);
        overflow-y: inherit;
        background-clip: inherit;
        background: inherit;
        border-radius: inherit;
        padding: inherit;
        min-width: var(--editor-width);
      }

      .ProseMirror {
        padding: var(--editor-padding, 12px 12px);
      }

      #editor > div {
        flex-grow: 1;
      }

      #editor h1 {
        --font-size: var(--h4-size);
      }

      #editor h2 {
        --font-size: var(--h4-size);
      }
      #editor h3,
      #editor h4,
      #editor h5,
      #editor h6 {
        --font-size: var(--h6-size);
      }
    `,
    css`
      p {
        --margin-top: 0px;
        --margin-bottom: 16px;
      }

      li p {
        --margin-bottom: 8px;
      }

      h1 {
        --margin-top: 16px;
        --margin-bottom: 16px;
      }
      h2 {
        --margin-top: 14px;
        --margin-bottom: 14px;
      }
      h3,
      h4,
      h5,
      h6 {
        --margin-top: 12px;
        --margin-bottom: 12px;
      }

      .ProseMirror > :last-child {
        --margin-bottom: 0px;
      }

      .ProseMirror > :first-child {
        --margin-top: 0px;
      }
    `,
  ];

  static $html = html`
    <std-col id="editor" class="scroll-bars"></std-col>
  `;
}

export namespace ProseMirrorEditor {
  export interface ProseMirrorNode {
    type: { name: string };
    attrs: Record<string, any>;
    textContent: string;
  }

  /**
   * A structural mirror of prosemirror-view's NodeViewConstructor, kept
   * deliberately rather than aliased to the real one. This module is read by
   * roots that do not have prosemirror installed at all - localhost.node and
   * jameskao-io among them - and an `import("prosemirror-view")` here, even in
   * type position, fails to resolve in every one of them. Keeping prosemirror a
   * lazy, type-only dependency is what lets those roots compile.
   *
   * The cost is that the mirror can drift, and it had: see ignoreMutation.
   */
  export type NodeViewConstructor = (
    node: ProseMirrorNode,
    view: any,
    getPos: () => number | undefined,
  ) => {
    dom: HTMLElement;
    update?: (node: ProseMirrorNode) => boolean;
    destroy?: () => void;
    stopEvent?: (event: Event) => boolean;
    /**
     * ProseMirror reports selection changes through the same hook as DOM
     * mutations, with a synthetic record of its own - `ViewMutationRecord`
     * upstream. A handler admitting only a `MutationRecord` is not the one
     * `EditorView` calls, so this half of the mirror has to carry both.
     */
    ignoreMutation?: (
      mutation: MutationRecord | { type: "selection"; target: Node },
    ) => boolean;
  };

  export type Props = Optional<{
    onUpdate: (markdown: string) => void;
    /** Paint statically on bind; build the view on pointer/focus. See `pendingView`. */
    lazy: boolean;
    markdown: string;
    editable: boolean;
    placeholder: string;
    nodeViews: { [node: string]: NodeViewConstructor };
    /**
     * Extra ProseMirror plugins, appended AFTER the built-in default plugins
     * (input rules, history, keymaps, cursors, link-click, placeholder). Absent
     * → exactly the current default behavior.
     */
    plugins: readonly Prosemirror.Plugin[];
    serde: Prosemirror.Markdown.Serde;
  }>;
}
