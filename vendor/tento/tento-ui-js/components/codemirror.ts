import { html, LonaWebComponent } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Tracing } from "@tento-core/tracing";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../dom";
import { $$ } from "../fastdom";
import { Hotkeys } from "../hotkeys";
import { InstanceUrl } from "@tento-core/instance-url";
import { Lazy } from "@tento-core/lazy";
import { Scrollbars } from "./scrollbars";
import { VendoredImport } from "../ui/vendored-import";
import { codemirrorBundleQuery } from "../ui/codemirror-bundle";

type CodeMirrorImport = typeof import("@tento-plugins/codemirror");

@component({
  name: "std-codemirror",
})
export class CodeMirrorEditor extends LonaWebComponent {
  private static syntaxTheme = {
    keyword: "var(--fg-syntax-keyword)",
    function: "var(--fg-syntax-function)",
    string: "var(--fg-syntax-string)",
    number: "var(--fg-syntax-number)",
    comment: "var(--fg-syntax-comment)",
    punctuation: "var(--fg-syntax-punctuation)",
    operator: "var(--fg-syntax-operator)",
    variable: "var(--fg-syntax-variable)",
  };

  private static editorTheme = {
    "&": {
      color: "var(--text-pri)",
      backgroundColor: "var(--bg-codemirror, transparent)",
    },
    ".cm-content": {
      caretColor: "var(--text-pri)",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--text-pri)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
      {
        backgroundColor: "var(--bg-selected-opaque)",
      },
    ".cm-activeLine": {
      backgroundColor: "var(--bg-hover-very-light)",
    },
    ".cm-activeLineGutter": {
      background: "none",
    },
    ".cm-gutters": {
      color: "var(--text-sec)",
      backgroundColor:
        "var(--bg-codemirror-gutter, var(--bg-codemirror, var(--bg-elevated)))",
      borderRight: "1px solid var(--divider)",
    },
    ".cm-foldPlaceholder": {
      color: "var(--text-sec)",
      backgroundColor: "var(--bg-hover)",
      border: "1px solid var(--divider)",
    },
  };

  private static import: Lazy<CodeMirrorImport> = new Lazy(async () => {
    const query = codemirrorBundleQuery();
    // Same trap as prosemirror-import (a storybook card's own InstanceUrl):
    // retry same-origin unless the static base already is same-origin, and
    // log `codemirror/init-failed` at warn on a final failure.
    return await VendoredImport.load(
      {
        label: "codemirror",
        url: `${InstanceUrl.staticUrl("/js/codemirror.min.js")}${query}`,
        fallbackUrl: `/@/static/js/codemirror.min.js${query}`,
      },
      (url): Promise<CodeMirrorImport> => import(url),
    );
  });

  static async load(): Promise<void> {
    await CodeMirrorEditor.import!.get();
  }

  private $editor = this.$("editor");
  private generation = 0;
  private props: Option<CodeMirrorEditor.Props>;
  private pending = false;
  private view: Option<import("@tento-plugins/codemirror").EditorView>;
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

  private currentContent: Option<string>;
  private delegate: (content: string) => void = Constants.EMPTY_FUNCTION;
  private emitOnUpdate(content: string) {
    const contentChanged = this.currentContent !== content;
    if (!contentChanged) return;
    this.currentContent = content;
    this.delegate(content);
  }

  private editable: boolean = false;
  private currentLanguage: "plain" | "lisp" = "lisp";

  async bind(props: CodeMirrorEditor.Props = {}): Promise<this> {
    const { onUpdate, content, language = "lisp", editable } = props;
    this.props = props;
    const generation = ++this.generation;
    this.pending = true;
    let codemirror: CodeMirrorImport;
    try { codemirror = await CodeMirrorEditor.import.get(); }
    catch (error) { if (generation === this.generation) this.pending = false; throw error; }
    if (generation !== this.generation) return this;
    this.pending = false;
    const { LonaCodeMirror, SupportedLanguage, EditorView, EditorState } =
      codemirror;

    const previous = {
      view: this.view,
      editable: this.editable,
      content: this.currentContent,
      language: this.currentLanguage,
    };

    this.delegate = onUpdate ?? Constants.EMPTY_FUNCTION;
    this.editable = editable != null ? editable : true;
    this.currentContent = content;
    this.currentLanguage = language ?? "lisp";
    const lang =
      language === "lisp" ? SupportedLanguage.Lisp : SupportedLanguage.Plain;

    if (
      previous.content === content &&
      previous.editable === this.editable &&
      previous.language === language &&
      this.view != null
    ) {
      return this;
    }

    if (previous.view) {
      DomUtils.clearChildren(this.$editor);
      previous.view.destroy();
      this.view = null;
    } else if (!this.initialized) {
      this.initialized = true;
    }

    this.#value = content;
    this.toggleAttribute("editable", this.editable);

    const themeExtension = LonaCodeMirror.createThemeExtension(
      CodeMirrorEditor.editorTheme,
    );
    const syntaxExtension = LonaCodeMirror.createSyntaxHighlightExtension(
      CodeMirrorEditor.syntaxTheme,
    );

    const extensions = [
      syntaxExtension,
      themeExtension,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || this.view == null || update.view !== this.view) return;
        const content = update.state.doc.toString();
        this.#value = content;
        this.emitOnUpdate(content);
      }),
    ];

    // `editable: false` used to mean a host attribute and a cursor style,
    // which left the mount taking focus, showing a caret and accepting
    // typing. Refusing the transaction is only half the job: `create`
    // installs `customSetup` — line numbers, the fold gutter, the active-line
    // highlight, history and the full editing keymap — and a block wearing
    // all of that reads as editable no matter what the state says.
    // `createReadOnly` is the plugin's own answer, without that chrome.
    //
    // But it is NOT trusted to be the whole answer, because measurably it is
    // not. On the live page a mount built through `createReadOnly` came back
    // with `state.readOnly === false`, a fold gutter, and a `.cm-content`
    // carrying `contenteditable="true"` — while this component's own
    // `editable` field said false. The plugin ships as a prebuilt bundle
    // loaded at runtime from the static host, so what `createReadOnly`
    // actually installs is not pinned by anything in this repo and cannot be
    // read off its source here.
    //
    // So read-only is asserted from THIS side as well. Both facets are
    // appended to `customExtensions`, which both helpers spread LAST, so
    // they apply whichever helper runs and whatever that helper's own
    // extension list contains. The plugin call stays because it also drops
    // the editing chrome; these two lines are what make the guarantee.
    const readOnly = this.editable
      ? []
      : [EditorView.editable.of(false), EditorState.readOnly.of(true)];
    const view = this.editable
      ? LonaCodeMirror.create(this.$editor, content || "", lang, [
        ...extensions,
        ...readOnly,
      ])
      : LonaCodeMirror.createReadOnly(this.$editor, content || "", lang, [
        ...extensions,
        ...readOnly,
      ]);

    this.view = view;
    return this;
  }

  private retireView(): void {
    if (!this.pending && this.props != null) this.props = { ...this.props, content: this.currentContent ?? this.props.content };
    this.generation++;
    this.pending = false;
    this.view?.destroy();
    this.view = null;
    this.initialized = false;
    DomUtils.clearChildren(this.$editor);
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.props != null && this.view == null && !this.pending) {
      void this.bind(this.props).catch(error => Tracing.err("ui")("codemirror/reconnect-failed", error));
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
    this.currentContent = null;
    this.#value = null;
    super.onRecycle();
  }

  static $styles = [
    Scrollbars.$style,
    css`
      :host {
        width: 100%;
        height: 100%;
        min-height: 24px;
        display: block;
        cursor: text;
        overflow: hidden;
      }

      :host([disabled]) {
        cursor: default;
      }
    `,
    css`
      #editor {
        background-clip: padding-box;
        height: 100%;
        width: 100%;
        overflow: auto;
        color: var(--text-pri);
        background: var(--bg-codemirror, var(--bg-elevated));
      }

      #editor > div {
        height: 100%;
      }

      #editor *:focus {
        outline: none;
      }

      #editor .cm-editor {
        color: var(--text-pri);
        background: transparent;
      }

      #editor .cm-gutters {
        border-right: 1px solid var(--divider);
        color: var(--text-sec);
        background:
          var(--bg-codemirror-gutter, var(--bg-codemirror, var(--bg-elevated)));
      }

      #editor .cm-cursor,
      #editor .cm-dropCursor {
        border-left-color: var(--text-pri);
      }

      .cm-cursorLayer {
        animation-iteration-count: infinite;
      }

      .cm-gutter {
        padding-left: 12px;
      }

      #editor .cm-content {
        padding-block: var(--padding-block, 12px);
      }

      #editor .cm-line {
        padding: 0px 2px 0px 12px;
      }

      @keyframes cm-blink: {
        0%: {
        }
        , 50%: {
          opacity: 0;
        }
        , 100%: {
        }
      }

      @keyframes cm-blink2: {
        0%: {
        }
        , 50%: {
          opacity: 0;
        }
        , 100%: {
        }
      }
    `,
  ];

  static $html = html`<div id="editor" class="cm-editor-container"></div>`;
}

export namespace CodeMirrorEditor {
  export type Props = Optional<{
    onUpdate: (content: string) => void;
    content: string;
    language: "plain" | "lisp";
    editable: boolean;
  }>;
}
