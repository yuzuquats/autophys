// Re-wrap serialized markdown prose at a column, fence-aware. The
// prosemirror-markdown serializer emits each paragraph as ONE line; committed
// plan docs are hand-wrapped at ~72 columns, so committing serializer output
// verbatim would rewrite every paragraph's layout in the diff even for a
// one-word edit. This pass restores the convention mechanically. It never
// joins lines — it only splits long ones — so text that is already wrapped
// (or deliberately short) passes through byte-identical.

/** Lines that must never be re-wrapped even when long: headings, tables,
 * raw-html blocks, link-reference definitions. */
const UNWRAPPABLE = /^\s*(?:#{1,6}\s|\||<|\[[^\]]+\]:)/;

/** The wrappable-prefix grammar: any run of blockquote markers and list
 * markers (`- `, `* `, `+ `, `1. `, `1) `), in any nesting order. What
 * follows the prefix is prose. */
const PREFIX = /^(?:\s{0,3}(?:>\s?|[-*+]\s+|\d+[.)]\s+))*/;

/** Greedy-wrap `md` at `width` columns. Fenced code blocks pass through
 * untouched; so do headings, tables, html and reference definitions, and any
 * line already within `width`. List items and blockquotes wrap under their
 * marker with a hanging indent (`- long…` continues aligned past the dash;
 * `> long…` continues under a fresh `> `). */
export function rewrapMarkdown(md: string, width: number): string {
  const out: string[] = [];
  let inFence = false;
  let fenceMark = "";
  for (const line of md.split("\n")) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence != null) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[1][0];
      } else if (fence[1][0] === fenceMark) {
        inFence = false;
      }
      out.push(line);
      continue;
    }
    if (inFence || line.length <= width || UNWRAPPABLE.test(line)) {
      out.push(line);
      continue;
    }
    const prefix = line.match(PREFIX)![0];
    // Indented code (4+ spaces of pure indent, no list/quote marker) stays.
    if (prefix === "" && /^\s{4,}/.test(line)) {
      out.push(line);
      continue;
    }
    // The continuation prefix: blockquote markers repeat, list markers
    // become the spaces that align under their item's text.
    const cont = prefix.replace(/[-*+]|\d+[.)]/g, (m) => " ".repeat(m.length));
    const words = line.slice(prefix.length).split(/ +/);
    let cur = prefix;
    let first = true;
    for (const word of words) {
      if (word === "") continue;
      const lead = first ? prefix : cont;
      if (cur !== lead && cur.length + 1 + word.length > width) {
        out.push(cur);
        cur = cont + word;
        first = false;
      } else {
        cur = cur === lead ? cur + word : cur + " " + word;
      }
    }
    out.push(cur);
  }
  return out.join("\n");
}
