/** Reading presentation shared by Autophys and product SDK manuals.
 * Uses std-documentation and std-code; this package does not parse Markdown itself.
 */
import { Documentation } from "@tento-ui/components/documentation/documentation";
import { Code } from "@tento-ui/components/code/code";
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";
import { shellTokenizer } from "@tento-ui/components/code/languages/shell";

/** Autophys's cap-height type scale. Override the semantic roles on a host, not individual tags. */
export const DOCUMENTATION_TOKENS = `
  --text-8px: 0.5rem; --text-9px: 0.5625rem; --text-10px: 0.625rem; --text-11px: 0.6875rem;
  --text-12px: 0.75rem; --text-13px: 0.8125rem; --text-14px: 0.875rem; --text-15px: 0.9375rem;
  --text-16px: 1rem; --text-18px: 1.125rem; --text-20px: 1.25rem; --text-22px: 1.375rem;
  --text-24px: 1.5rem; --text-28px: 1.75rem; --text-32px: 2rem;
  --h1-size: var(--text-18px); --h2-size: var(--text-16px); --h3-size: var(--text-14px);
  --h4-size: var(--text-12px); --h5-size: var(--text-12px); --h6-size: var(--text-12px);
  --p-size: var(--text-10px); --caption-size: var(--text-9px); --small-size: var(--text-9px);
  --cap-height: 0.125; --baseline: 0.155;
  --font-size: var(--p-size); --line-height-ratio: 1.4;
  --text-pri: var(--ck-ink, #141414); --text-sec: var(--ck-secondary, #424242); --text-ter: var(--ck-n600, #5c5c5c);
  --divider: var(--ck-line, #d9d9d9); --bg: #fff; --bg-surface: var(--ck-n100, #f7f7f7); --code-bg: var(--ck-n100, #f7f7f7);
  font-family: var(--ck-font, system-ui, sans-serif); color: var(--text-pri);
  --fg-syntax-keyword: #4c6a92; --fg-syntax-function: #2b6f7d; --fg-syntax-string: #4b7037;
  --fg-syntax-number: #855380; --fg-syntax-comment: #646d80; --fg-syntax-punctuation: #2e3440;
  --fg-syntax-operator: #4c6a92; --fg-syntax-variable: #2e3440;
`;
export const DOCUMENTATION_INLINE_CSS = `
  td:first-child code {
    display: inline-block;
    white-space: pre-wrap;
    overflow-wrap: normal;
    padding: 3px 6px 3px 2.6ch;
    text-indent: -2ch;
    line-height: 1.5;
  }
  code .tok-punctuation, code .tok-operator, code .tok-number { color: inherit; }
`;
const NORD_CODE: Record<string, string> = {
  "--code-bg": "#2e3440", "--text-pri": "#d8dee9",
  "--fg-syntax-keyword": "#81a1c1", "--fg-syntax-function": "#88c0d0",
  "--fg-syntax-string": "#a3be8c", "--fg-syntax-number": "#b48ead",
  "--fg-syntax-comment": "#8590a6", "--fg-syntax-punctuation": "#eceff4",
  "--fg-syntax-operator": "#81a1c1", "--fg-syntax-variable": "#d8dee9",
};

Code.registerLanguage(["sh", "bash", "shell", "zsh", "console"], shellTokenizer);

/** Static Code node view: avoids loading CodeMirror for a read-only manual. */
export class StaticCodeBlockView {
  dom: Code;
  constructor(node: ProseMirrorEditor.ProseMirrorNode, theme: "light" | "dark" = "light") {
    this.dom = Code.make();
    this.dom.style.scrollbarWidth = "thin";
    this.dom.style.scrollbarColor = theme === "dark"
      ? "rgb(255 255 255 / 0.22) transparent" : "#c7c7c7 transparent";
    if (theme === "dark") for (const [name, value] of Object.entries(NORD_CODE)) {
      this.dom.style.setProperty(name, value);
    }
    this.draw(node);
  }
  private draw(node: ProseMirrorEditor.ProseMirrorNode): void {
    void this.dom.bind({ content: node.textContent, language: node.attrs.params || "plain", rendering: "static" });
  }
  update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
    if (node.type.name !== "code_block") return false;
    this.draw(node);
    return true;
  }
  stopEvent(): boolean { return true; }
  ignoreMutation(): boolean { return true; }
}

/** The same reading component/preset for embedded docs and complete manuals.
 * Call bind() with product content and optional custom node views, as Autophys does.
 */
export function makeDocumentation(): Documentation {
  const doc = Documentation.make();
  doc.style.cssText = DOCUMENTATION_TOKENS;
  const inline = new CSSStyleSheet();
  inline.replaceSync(DOCUMENTATION_INLINE_CSS);
  doc.addStyle("tento-docs-inline-code", inline);
  return doc;
}
