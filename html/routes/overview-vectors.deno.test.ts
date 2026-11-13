/** The overview vectors (tests/conformance/overview/cases.json) against the
 * real viewer parser: the bundled prosemirror.min.js with the inserts the
 * document view registers. Both SDKs assert the same `cards`, `renders` and
 * `insert_in_paragraph` lines, so a viewer change that moves where a card
 * renders fails here before the SDK warnings drift from it (OV-9).
 *
 * Deno has no DOM. The module builds one EditorView when it loads and an
 * insert's getAttrs parses its token through innerHTML, so a minimal fake DOM
 * is installed first. Its innerHTML parses nothing: inserts get default
 * attributes, and only the block structure is checked here. Attribute values
 * are asserted by the SDK tests. */
import { assertEquals } from "jsr:@std/assert@1";
import inserts from "../ui/investigation-inserts.json" with { type: "json" };

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  data = "";
  pmViewDesc?: unknown;
  classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
  constructor(public nodeType: number, public nodeName: string) {}
  get ownerDocument(): FakeNode { return fakeDocument; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes.at(-1) ?? null; }
  get nextSibling(): FakeNode | null { return this.sibling(1); }
  get previousSibling(): FakeNode | null { return this.sibling(-1); }
  private sibling(step: number): FakeNode | null {
    const p = this.parentNode;
    return p ? p.childNodes[p.childNodes.indexOf(this) + step] ?? null : null;
  }
  get nodeValue(): string { return this.data; }
  set nodeValue(v: string) { this.data = v; }
  get textContent(): string { return this.nodeType === 3 ? this.data : this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v: string) { this.childNodes = []; if (v) this.appendChild(textNode(v)); }
  set innerHTML(_: string) { this.childNodes = []; }
  get className(): string { return this.attrs.get("class") ?? ""; }
  set className(v: string) { this.attrs.set("class", v); }
  appendChild(n: FakeNode): FakeNode { return this.insertBefore(n, null); }
  insertBefore(n: FakeNode, ref: FakeNode | null): FakeNode {
    n.parentNode?.removeChild(n);
    n.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n: FakeNode): FakeNode { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  querySelector(_: string): null { return null; }
  addEventListener() {}
  removeEventListener() {}
  contains(n: FakeNode | null): boolean { for (let c = n; c; c = c.parentNode) if (c === this) return true; return false; }
  getRootNode(): FakeNode { return fakeDocument; }
  getSelection(): null { return null; }
}
function textNode(text: string): FakeNode { const n = new FakeNode(3, "#text"); n.data = text; return n; }
const fakeDocument: FakeNode = Object.assign(new FakeNode(9, "#document"), {
  createElement: (tag: string) => new FakeNode(1, tag.toUpperCase()),
  createTextNode: textNode,
  documentElement: new FakeNode(1, "HTML"),
});
const g = globalThis as Record<string, unknown>;
if (!g.document) {
  g.document = fakeDocument;
  g.window = globalThis;
  g.MutationObserver ??= class { observe() {} disconnect() {} takeRecords() { return []; } };
}

type Token = { type: string; map: [number, number] | null; content: string };
type Case = { name: string; markdown: string; warnings: { code: string; line?: number }[]; cards: number[]; renders: boolean };

// The viewer's serde: std-documentation's built-in lisp insert, then the app's.
const { Markdown } = await import("./js/prosemirror.min.js");
const insert = inserts.inserts.find(i => i.id === "ap_investigation")!;
const serde = Markdown.buildSchema([
  { id: "lisp_example", componentName: "std-lisp-example", attributeKeys: new Set(["code"]) },
  { id: insert.id, componentName: insert.tag, attributeKeys: new Set(insert.attributes) },
], { fileRefs: false });
const cases: { warnings: Case[] } = JSON.parse(await Deno.readTextFile(new URL("../../tests/conformance/overview/cases.json", import.meta.url)));

/** Lines, 0-based, where an insert-looking line continues a paragraph, a
 * heading's text or a table (link references leave no token to check). */
function continued(tokens: Token[]): number[] {
  const looks = (text: string) => text.trimStart().startsWith(`<${insert.tag}`);
  const out: number[] = [];
  tokens.forEach((t, i) => {
    if ((t.type === "paragraph_open" || t.type === "heading_open") && tokens[i + 1]?.type === "inline") {
      tokens[i + 1].content.split("\n").forEach((line, k) => { if (k > 0 && looks(line)) out.push(t.map![0] + k); });
    }
    if (t.type === "tr_open" && looks(tokens.slice(i).find(x => x.type === "inline")?.content ?? "")) out.push(t.map![0]);
  });
  return out.sort((a, b) => a - b);
}

for (const c of cases.warnings) {
  Deno.test(`overview vector against the viewer parser: ${c.name}`, () => {
    const tokens: Token[] = serde.parser.tokenizer.parse(c.markdown, {});
    const cards = tokens.filter(t => t.type === insert.id).map(t => t.map![0] + 1);
    assertEquals(cards, c.cards, "card lines");
    assertEquals(continued(tokens).map(l => l + 1), c.warnings.filter(w => w.code === "insert_in_paragraph").map(w => w.line));
    let renders = true, nodes = 0;
    try {
      serde.parser.parse(c.markdown).descendants((n: { type: { name: string } }) => { if (n.type.name === insert.id) nodes++; });
    } catch {
      renders = false;
    }
    assertEquals(renders, c.renders, "the document displays");
    if (renders) assertEquals(nodes, c.cards.length, "every card token becomes a card node");
  });
}
