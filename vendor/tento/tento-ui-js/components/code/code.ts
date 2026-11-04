import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { InstanceUrl } from "@tento-core/instance-url";
import { Tracing } from "@tento-core/tracing";
import { Lazy } from "@tento-core/lazy";

import { codemirrorBundleQuery } from "../../ui/codemirror-bundle";
import { shellTokenizer } from "./languages/shell";
import type { Tokenizer } from "./languages/tokenizer";
import { tomlTokenizer } from "./languages/toml";
import { pythonTokenizer } from "./languages/python";
import { highlightText, SYNTAX_TOKEN_STYLE } from "./languages/highlight";
import { Typography } from "../../ui/typography";

type CodeMirrorImport = typeof import("@tento-plugins/codemirror");
type Extension = import("@tento-plugins/codemirror").Extension;

@component({
  name: "std-code",
})
export class Code extends LonaWebComponent {
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
      backgroundColor: "transparent",
    },
    ".cm-scroller": {
      fontFamily: "inherit",
      lineHeight: "inherit",
    },
    ".cm-content": {
      padding: "var(--std-code-padding, 12px)",
    },
    ".cm-activeLine": {
      backgroundColor: "transparent",
    },
    ".cm-gutters": {
      display: "none",
    },
  };

  private static import: Lazy<CodeMirrorImport> = new Lazy(async () => {
    return import(
      `${InstanceUrl.staticUrl("/js/codemirror.min.js")}${codemirrorBundleQuery()}`
    );
  });

  private $root = this.$("root");
  private generation = 0;
  private props: Option<Code.Props>;
  private pending = false;
  private view: Option<import("@tento-plugins/codemirror").EditorView>;

  private static normalizeLanguage(language: string): string {
    return language
      .trim()
      .toLowerCase()
      .replace(/^language-/, "")
      .split(/[\s,{:]/)[0] || "plain";
  }

  private static resolveLanguage(
    language: string,
    SupportedLanguage: CodeMirrorImport["SupportedLanguage"],
  ): CodeMirrorImport["SupportedLanguage"][keyof CodeMirrorImport["SupportedLanguage"]] {
    switch (Code.normalizeLanguage(language)) {
      case "lisp":
        return SupportedLanguage.Lisp;
      case "js":
      case "javascript":
      case "jsx":
        return SupportedLanguage.JavaScript;
      case "ts":
      case "typescript":
      case "tsx":
        return SupportedLanguage.TypeScript;
      case "rs":
      case "rust":
        return SupportedLanguage.Rust;
      case "json":
      case "jsonc":
      case "json5":
        return SupportedLanguage.Json;
      default:
        return SupportedLanguage.Plain;
    }
  }

  /** Fence names served by a page-supplied tokenizer, ahead of the bundle's. */
  private static tokenizers = new Map<string, Tokenizer<unknown>>();
  private static streamLanguages = new WeakMap<Tokenizer<unknown>, Extension>();

  /**
   * Serve the fence names `names` with `tokenizer`. A tokenizer ships with
   * the page that registers it, so changing a language needs no rebuild of
   * the CodeMirror bundle. A later registration of a name replaces it.
   */
  static registerLanguage<S>(names: readonly string[], tokenizer: Tokenizer<S>): void {
    for (const name of names) {
      Code.tokenizers.set(Code.normalizeLanguage(name), tokenizer as Tokenizer<unknown>);
    }
  }

  /** The tokenizer registered for a fence name, if any. */
  static tokenizerFor(name: string): Option<Tokenizer<unknown>> {
    return Code.tokenizers.get(Code.normalizeLanguage(name)) ?? null;
  }

  /** The tokenizer's language, or nothing on a bundle without streamLanguage. */
  private static streamLanguage(
    codemirror: CodeMirrorImport,
    tokenizer: Tokenizer<unknown>,
  ): Option<Extension> {
    const make = codemirror.LonaCodeMirror.streamLanguage;
    if (make == null) return null;
    let extension = Code.streamLanguages.get(tokenizer);
    if (extension == null) {
      // TokenStream is the subset of StringStream a tokenizer reads.
      extension = make(tokenizer as Parameters<typeof make>[0]);
      Code.streamLanguages.set(tokenizer, extension);
    }
    return extension;
  }

  async bind(props: Code.Props): Promise<this> {
    const { content, language = "plain" } = props;
    this.props = props;
    const generation = ++this.generation;
    this.pending = true;
    if (props.rendering === "static") {
      this.pending = false;
      this.view?.destroy();
      this.view = null;
      this.renderStatic(content, language);
      return this;
    }
    delete this.$root.dataset.rendering;
    // Until the editor bundle arrives the text stands in as a plain block at
    // the editor's own metrics, so the page doesn't grow when it mounts.
    if (this.view == null) this.renderPlaceholder(content);
    let codemirror: CodeMirrorImport;
    try { codemirror = await Code.import.get(); }
    catch (error) { if (generation === this.generation) this.pending = false; throw error; }
    if (generation !== this.generation) return this;
    this.pending = false;
    const { LonaCodeMirror, SupportedLanguage } = codemirror;

    this.view?.destroy();
    this.view = null;
    DomUtils.clearChildren(this.$root);

    // A registered tokenizer comes first. Otherwise the bundle's language;
    // a codemirror.min.js older than this file can lack the member, and
    // `createReadOnly` would read the undefined as its Lisp default.
    const tokenizer = Code.tokenizers.get(Code.normalizeLanguage(language));
    const streamLanguage =
      tokenizer == null ? null : Code.streamLanguage(codemirror, tokenizer);
    const lang =
      tokenizer != null
        ? SupportedLanguage.Plain
        : (Code.resolveLanguage(language, SupportedLanguage) ?? SupportedLanguage.Plain);

    const themeExtension = LonaCodeMirror.createThemeExtension(
      Code.editorTheme,
    );
    const syntaxExtension = LonaCodeMirror.createSyntaxHighlightExtension(
      Code.syntaxTheme,
    );

    this.view = LonaCodeMirror.createReadOnly(
      this.$root,
      content,
      lang,
      streamLanguage == null
        ? [syntaxExtension, themeExtension]
        : [streamLanguage, syntaxExtension, themeExtension],
      this.shadowRoot!,
    );

    return this;
  }

  /** Highlight a read-only document without loading the app's editor bundle. */
  private renderStatic(content: string, language: string): void {
    const normalized = content.replace(/\r\n?/g, "\n");
    this.renderPlaceholder(normalized);
    this.$root.dataset.rendering = "static";
    const tokenizer = Code.tokenizerFor(language);
    if (tokenizer == null) return;
    const spans = highlightText(tokenizer, normalized);
    const lines = normalized.split("\n");
    let offset = 0;
    let spanIndex = 0;
    const $lines = this.$root.querySelectorAll<HTMLElement>(".placeholder > div");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const $line = $lines[index];
      $line.replaceChildren();
      let cursor = offset;
      while (spanIndex < spans.length && spans[spanIndex].from < offset + line.length) {
        const span = spans[spanIndex++];
        if (span.from > cursor) $line.append(normalized.slice(cursor, span.from));
        const $token = document.createElement("span");
        $token.className = `tok-${span.role}`;
        $token.textContent = normalized.slice(span.from, span.to);
        $line.append($token);
        cursor = span.to;
      }
      $line.append(line.length === 0 ? "\u200b" : normalized.slice(cursor, offset + line.length));
      offset += line.length + 1;
    }
  }

  private renderPlaceholder(content: string): void {
    DomUtils.clearChildren(this.$root);
    const $pre = document.createElement("pre");
    $pre.className = "placeholder";
    // One row per line, as CodeMirror lays them out: a bare <pre> drops a
    // trailing empty line ("a\n" is one line there, two in the editor) and
    // gives "" no line at all. Lines split where CodeMirror splits them, so
    // a CRLF blank line is a row too.
    for (const line of content.split(/\r\n?|\n/)) {
      const $line = document.createElement("div");
      $line.textContent = line === "" ? "​" : line;
      $pre.appendChild($line);
    }
    this.$root.appendChild($pre);
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.props != null && this.view == null && !this.pending) {
      void this.bind(this.props).catch(error => Tracing.err("ui")("code/reconnect-failed", error));
    }
  }

  onRecycle(): void {
    this.retireView();
    this.props = null;
    super.onRecycle();
  }

  private retireView(): void {
    this.generation++;
    this.pending = false;
    this.view?.destroy();
    this.view = null;
    DomUtils.clearChildren(this.$root);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.retireView();
  }

  static $styles = [
    Typography.$style,
    SYNTAX_TOKEN_STYLE,
    css`
    :host {
      --font-size: var(--code-size, var(--text-10px, 0.625rem));
      --line-height-ratio: var(--code-line-height-ratio, 1.55);
      --std-code-padding: 12px;
      display: block;
      border-radius: 8px;
      overflow-x: auto;
      overflow-y: hidden;
      max-width: 100%;
      -webkit-overflow-scrolling: touch;
      /* --code-bg lets a site set code apart more than its surface tone. */
      background: var(--code-bg, var(--bg-code, var(--bg-surface)));
      margin-block: 12px;
    }

    #root {
      min-width: max-content;
    }

    #root .cm-editor {
      background: transparent;
    }

    /* The editor's box: .cm-content padding plus .cm-line's 6px/2px inset. */
    #root .placeholder {
      margin: 0;
      padding: var(--std-code-padding)
        calc(var(--std-code-padding) + 2px)
        var(--std-code-padding)
        calc(var(--std-code-padding) + 6px);
      font: inherit;
      line-height: inherit;
      white-space: pre;
      color: var(--text-pri);
    }

    #root .cm-scroller {
      overflow: auto;
    }

    #root .cm-editor:focus-within {
      outline: none;
    }

    #root .cm-editor.cm-focused {
      outline: none;
    }

    @media (max-width: 768px) {
      :host {
        --font-size: var(--code-size, var(--text-10px, 0.625rem));
        --line-height-ratio: var(--code-line-height-ratio, 1.55);
        --std-code-padding: 10px;
        margin-block: 10px;
      }
    }
  `,
  ];
  static $html = html`<div id="root" class="code-block"></div>`;
}

export namespace Code {
  export type Props = {
    content: string;
    language?: string;
    /** Static documents can highlight registered languages without CodeMirror. */
    rendering?: Option<"editor" | "static">;
  };
}

Code.registerLanguage(["sh", "bash", "zsh", "shell", "console"], shellTokenizer);
Code.registerLanguage(["toml"], tomlTokenizer);

Code.registerLanguage(["python", "py", "python3"], pythonTokenizer);
