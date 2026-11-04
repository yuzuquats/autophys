import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Tracing } from "@tento-core/tracing";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../../dom";
import { $$ } from "../../fastdom";
import { Hotkeys } from "../../hotkeys";
import { Prosemirror } from "../../ui/prosemirror-import";
import { ProseMirrorEditor } from "../prosemirror";

@component({
  name: "std-rich-text-editor",
})
export class RichTextEditor extends LonaWebComponent {
  private generation = 0;
  private props: Option<RichTextEditor.Props>;
  private pending = false;
  private view: Option<Prosemirror.EditorView>;
  #value: Option<string>;
  initialized: boolean = false;

  get value(): Option<string> {
    return this.#value;
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
  }

  private retireView(): void {
    if (!this.pending && this.props != null) this.props = { ...this.props, markdown: this.currentMarkdown ?? this.props.markdown };
    this.generation++;
    this.pending = false;
    this.view?.destroy();
    this.view = null;
    this.initialized = false;
    while (this.firstChild) this.removeChild(this.firstChild);
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.props != null && this.view == null && !this.pending) {
      void this.bind(this.props).catch(error => Tracing.err("ui")("rich-text/reconnect-failed", error));
    }
  }

  disconnectedCallback(): void {
    this.retireView();
    super.disconnectedCallback();
  }

  onRecycle(): void {
    this.retireView();
    this.props = null;
    this.delegate = Constants.EMPTY_FUNCTION;
    this.currentMarkdown = null;
    this.currentPlugins = null;
    this.#value = null;
    super.onRecycle();
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
  private currentPlugins: Option<readonly Prosemirror.Plugin[]> = null;

  focusEditor() {
    (this.firstElementChild as HTMLElement)?.focus();
  }

  private static defaultStyleInjected = false;
  private static injectDefaultStyle(style: string) {
    if (RichTextEditor.defaultStyleInjected) return;
    RichTextEditor.defaultStyleInjected = true;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(style);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }

  async bind(props: RichTextEditor.Props = {}): Promise<this> {
    const { onUpdate, markdown, editable, placeholder, nodeViews, plugins, serde: _serde } = props;
    const previousProps = this.props;
    this.props = props;
    const generation = ++this.generation;
    this.pending = true;
    let prosemirror: Prosemirror;
    try { prosemirror = await Prosemirror.get(); }
    catch (error) { if (generation === this.generation) this.pending = false; throw error; }
    if (generation !== this.generation) return this;
    this.pending = false;
    const { EditorState, EditorView, Markdown, Plugins, DEFAULT_STYLE } = prosemirror;
    const serde = _serde ?? Markdown.DEFAULT;

    const previous = {
      view: this.view,
      editable: this.editable,
      md: this.currentMarkdown,
      plugins: this.currentPlugins,
    };

    this.delegate = onUpdate ?? Constants.EMPTY_FUNCTION;
    this.currentMarkdown = markdown;
    this.editable = editable ?? true;
    this.currentPlugins = plugins ?? null;
    this.toggleAttribute("disabled", !this.editable);

    if (
      previous.md === markdown &&
      previous.editable === this.editable &&
      previous.plugins === this.currentPlugins &&
      this.view != null && previousProps?.placeholder === placeholder &&
      previousProps?.nodeViews === nodeViews && previousProps?.serde === _serde
    ) {
      return this;
    }

    if (previous.view) {
      previous.view.destroy();
      this.view = null;
    } else if (!this.initialized) {
      RichTextEditor.injectDefaultStyle(DEFAULT_STYLE);
      this.initialized = true;
    }

    while (this.firstChild) this.removeChild(this.firstChild);

    const doc = markdown
      ? (serde.parser.parse(markdown) ?? undefined)
      : undefined;

    this.#value = markdown;
    const view = new EditorView(
      ($root: HTMLElement) => {
        // Reading rhythm belongs to this editor, not generic sheet text cells.
        $root.classList.add("prose-spacing");
        $$.mutate(() => { if (this.view === view) this.appendChild($root); });
      },
      {
        dispatchTransaction: (transaction) => {
          if (this.view !== view) return;
          const state = view.state.apply(transaction);
          const md = serde.serializer.serialize(state.doc, {
            tightLists: false,
          });
          this.#value = md;
          this.onUpdateMd(md);
          view.updateState(state);
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
            Plugins.placeholder(this, this.editable ? (placeholder ?? "") : ""),
            ...(plugins ?? []),
          ],
        }),
        editable: () => this.editable,
        nodeViews: nodeViews ?? undefined,
      },
    );
    this.view = view;
    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        min-height: 24px;
        cursor: text;
        overflow-y: auto;
        scrollbar-gutter: stable;
        padding-block: 12px;
      }

      :host([disabled]) {
        cursor: default;
      }
    `,
  ];

  static $html = html`<slot></slot>`;
}

export namespace RichTextEditor {
  export type Props = ProseMirrorEditor.Props;
}
