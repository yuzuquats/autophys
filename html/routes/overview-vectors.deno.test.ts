/** The drift guard for the overview lint (OV-13): the shared vectors
 * (tests/conformance/overview/cases.json) and the shared generator against
 * the real viewer parser, the bundled prosemirror.min.js with the inserts the
 * document view registers.
 *
 * Both SDKs assert that a vector without warnings has its canonical insert
 * lines as its `cards`, and that every generated document has no warnings and
 * one canonical line per insert. This test asserts that the viewer shows
 * exactly those cards and displays the document; for generated documents it
 * also asserts no text is hidden. Text hidden for reasons unrelated to inserts
 * (inline HTML, setext hard breaks, deep nesting) is outside the lint. The
 * bundle's sha256 is pinned, so a changed viewer fails here until the vectors
 * have been re-run against it.
 *
 * Deno has no DOM. The module builds one EditorView when it loads and an
 * insert's getAttrs parses its token through innerHTML, so a minimal fake DOM
 * is installed first. Its innerHTML parses nothing: inserts get default
 * attributes, and only the block structure is checked here. Attribute values
 * are asserted by the SDK tests. */
import { assert, assertEquals } from "jsr:@std/assert@1";
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

type Token = { type: string; map: [number, number] | null };
type Case = { name: string; markdown: string; warnings: unknown[]; cards: number[]; renders: boolean };
type Generator = { seed: number; documents: number; digest: string; max_blocks: number; insert_slots: number; insert: string; blocks: string[] };
type PmNode = { type: { name: string }; isText: boolean; text?: string; descendants(f: (n: PmNode) => void): void };

/** The bundle these vectors were last checked against. */
const BUNDLE_SHA256 = "b4c9b9e4c64d43e0b342a38c020221ff863a6907c7155e9a36cf2d4fa639f66e";
const BUNDLE = new URL("./js/prosemirror.min.js", import.meta.url);

// The viewer's serde: std-documentation's built-in lisp insert, then the app's.
const { Markdown } = await import("./js/prosemirror.min.js");
const insert = inserts.inserts.find(i => i.id === "ap_investigation")!;
const serde = Markdown.buildSchema([
  { id: "lisp_example", componentName: "std-lisp-example", attributeKeys: new Set(["code"]) },
  { id: insert.id, componentName: insert.tag, attributeKeys: new Set(insert.attributes) },
], { fileRefs: false });
const cases: { investigations: string[]; warnings: Case[]; generator: Generator } =
  JSON.parse(await Deno.readTextFile(new URL("../../tests/conformance/overview/cases.json", import.meta.url)));

/** What the viewer makes of `markdown`: the 1-based lines of its card tokens,
 * whether it displays the document, its card nodes and its text. */
function view(markdown: string): { cards: number[]; renders: boolean; nodes: number; text: string } {
  const tokens: Token[] = serde.parser.tokenizer.parse(markdown, {});
  const cards = tokens.filter(t => t.type === insert.id).map(t => t.map![0] + 1);
  let renders = true, nodes = 0, text = "";
  try {
    (serde.parser.parse(markdown) as PmNode).descendants(n => {
      if (n.type.name === insert.id) nodes++;
      if (n.isText) text += n.text + "\n";
    });
  } catch {
    renders = false;
  }
  return { cards, renders, nodes, text };
}

Deno.test("the viewer bundle is the one the overview vectors were checked against", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(BUNDLE)));
  const hex = [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
  assertEquals(hex, BUNDLE_SHA256,
    "html/routes/js/prosemirror.min.js changed. Re-run this test's vectors and generator against it, check the " +
    "SDK overview lint still holds (OV-13 in autophys.project.docs/content/overview-sdk.md), then update BUNDLE_SHA256.");
});

for (const c of cases.warnings) {
  Deno.test(`overview vector against the viewer parser: ${c.name}`, () => {
    const v = view(c.markdown);
    assertEquals(v.cards, c.cards, "card lines");
    assertEquals(v.renders, c.renders, "the document displays");
    if (v.renders) assertEquals(v.nodes, c.cards.length, "every card token becomes a card node");
    // A document the SDKs accept without warnings must display, with the
    // cards on its canonical lines (the SDK tests tie those lines to `cards`).
    if (c.warnings.length === 0) assert(v.renders, "a warning-free vector displays");
  });
}

/** The shared generator, as the SDK tests build it (see cases.json "comment"). */
function generated(g: Generator, ids: string[]): { markdown: string; inserts: number[]; words: string[] }[] {
  let seed = g.seed >>> 0;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const docs: { markdown: string; inserts: number[]; words: string[] }[] = [];
  for (let d = 0; d < g.documents; d++) {
    const parts: string[] = [], lines: number[] = [], words: string[] = [];
    let line = 1;
    for (let k = 1 + next() % g.max_blocks; k > 0; k--) {
      const r = next() % (g.blocks.length + g.insert_slots);
      let text: string;
      if (r >= g.blocks.length) {
        lines.push(line);
        text = g.insert.replace("{id}", ids[next() % ids.length]).replace("{n}", String(lines.length));
      } else {
        text = g.blocks[r];
        while (text.includes("{w}")) {
          const w = `w${d}x${words.length}z`;
          words.push(w);
          text = text.replace("{w}", w);
        }
      }
      line += text.split("\n").length - 1 + 2;
      parts.push(text);
    }
    docs.push({ markdown: parts.join("\n\n") + "\n", inserts: lines, words });
  }
  return docs;
}

Deno.test("generated documents show one card per canonical insert and hide no text", async () => {
  const docs = generated(cases.generator, cases.investigations);
  assertEquals(docs.length, cases.generator.documents);
  const all = new TextEncoder().encode(docs.map(d => d.markdown).join(""));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", all))].map(b => b.toString(16).padStart(2, "0")).join("");
  assertEquals(digest, cases.generator.digest, "the same documents as the SDK tests");
  let cards = 0;
  for (const doc of docs) {
    const v = view(doc.markdown);
    const where = JSON.stringify(doc.markdown);
    assert(v.renders, `displays: ${where}`);
    assertEquals(v.cards, doc.inserts, `card lines: ${where}`);
    assertEquals(v.nodes, doc.inserts.length, `card nodes: ${where}`);
    for (const w of doc.words) assert(v.text.includes(w), `${w} is shown: ${where}`);
    cards += v.nodes;
  }
  assert(cards > docs.length, "the generator places inserts");
});
