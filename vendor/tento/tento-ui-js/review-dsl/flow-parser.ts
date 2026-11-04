import { ReviewDsl } from "./dsl";

// Forgiving parser for the ```review-flow fence — a subset of mermaid
// flowchart syntax (LLMs emit it from training data; nothing to teach):
//
//   flowchart LR            (or TD; `graph` alias; RL/BT normalize to LR/TD)
//   A[box label] --> B{decision}
//   B -->|edge label| C(rounded)
//   B -.->|no| D
//   class C,D changed       (semantic statuses: changed | new | removed)
//   A:::new                 (mermaid class-shorthand, same statuses)
//
// Chains (`A --> B --> C`) and `;`-separated statements work. Mermaid styling
// keywords (classDef/style/linkStyle/…) and subgraph markers are skipped
// silently; unparseable lines are hard errors with the fence-body line number.

/** Label text as authored → label text as displayed. Mermaid labels routinely
 * carry `<br/>` for a line break and HTML-escaped angle brackets (both are what
 * the model emits from training data), but a label is rendered as TEXT — so
 * without this they show up literally as `<br/>` and `&lt;`. Surrounding quotes
 * are mermaid's escape hatch, not content, so they come off too. */
function normalizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export namespace FlowParser {
  export type Shape = "box" | "rounded" | "decision";
  export type Status = "changed" | "new" | "removed";

  export type Node = {
    id: string;
    label: string;
    shape: Shape;
    status: Option<Status>;
  };
  export type Edge = {
    from: string;
    to: string;
    label: Option<string>;
    dashed: boolean;
  };
  export type Graph = { dir: "LR" | "TD"; nodes: Node[]; edges: Edge[] };

  const SKIP_KEYWORDS = [
    "classdef",
    "style",
    "linkstyle",
    "direction",
    "click",
    "acctitle",
    "accdescr",
    "subgraph",
    "end",
  ];

  const STATUSES: Status[] = ["changed", "new", "removed"];

  export function parse(src: string): ReviewDsl.Result<Graph> {
    const lines = ReviewDsl.lines(src);
    let dir: "LR" | "TD" = "LR";
    const nodes = new Map<string, Node>();
    const order: string[] = [];
    const edges: Edge[] = [];

    const ensureNode = (ref: NodeRef): void => {
      const existing = nodes.get(ref.id);
      if (existing == null) {
        nodes.set(ref.id, {
          id: ref.id,
          label: ref.label ?? ref.id,
          shape: ref.shape ?? "box",
          status: ref.status,
        });
        order.push(ref.id);
        return;
      }
      // A later bracketed mention refines an earlier bare one.
      if (ref.label != null && existing.label === existing.id) {
        existing.label = ref.label;
      }
      if (ref.shape != null && existing.shape === "box") {
        existing.shape = ref.shape;
      }
      if (ref.status != null) existing.status = ref.status;
    };

    let first = true;
    for (const lineEntry of lines) {
      const { line } = lineEntry;
      let text = lineEntry.text;
      if (first) {
        first = false;
        const header = text.match(/^(?:flowchart|graph)\b\s*(\w*)/i);
        if (header != null) {
          const d = header[1].toUpperCase();
          dir = d === "TD" || d === "TB" || d === "BT" ? "TD" : "LR";
          // A one-liner may carry statements after the header.
          text = text.slice(header[0].length).replace(/^[;\s]+/, "");
          if (text === "") continue;
        }
      }
      const keyword = text.split(/[\s;]/, 1)[0].toLowerCase();
      if (SKIP_KEYWORDS.includes(keyword)) continue;
      if (keyword === "class") {
        const m = text.match(/^class\s+([\w.,\s-]+?)\s+(\w+)\s*;?$/i);
        if (m == null) return ReviewDsl.err(line, "unparseable class statement");
        const status = m[2].toLowerCase();
        if (!STATUSES.includes(status as Status)) continue; // styling class — skip
        for (const id of m[1].split(",").map((s) => s.trim())) {
          if (id === "") continue;
          const node = nodes.get(id);
          if (node != null) node.status = status as Status;
        }
        continue;
      }
      for (const stmt of text.split(";")) {
        const s = stmt.trim();
        if (s === "") continue;
        const result = parseChain(s, line, ensureNode, edges);
        if (!result.ok) return result;
      }
    }

    if (nodes.size === 0) return ReviewDsl.err(1, "no nodes declared");
    if (nodes.size > ReviewDsl.MAX_NODES) {
      return ReviewDsl.err(1, `too many nodes (${nodes.size} > ${ReviewDsl.MAX_NODES})`);
    }
    if (edges.length > ReviewDsl.MAX_EDGES) {
      return ReviewDsl.err(1, `too many edges (${edges.length} > ${ReviewDsl.MAX_EDGES})`);
    }
    return ReviewDsl.ok({ dir, nodes: order.map((id) => nodes.get(id)!), edges });
  }

  type NodeRef = {
    id: string;
    label: Option<string>;
    shape: Option<Shape>;
    status: Option<Status>;
  };

  function parseChain(
    stmt: string,
    line: number,
    ensureNode: (ref: NodeRef) => void,
    edges: FlowParser.Edge[],
  ): ReviewDsl.Result<null> {
    const cursor = { text: stmt, pos: 0 };
    const first = readNodeRef(cursor);
    if (first == null) return ReviewDsl.err(line, `expected a node at "${rest(cursor)}"`);
    ensureNode(first);
    let from = first.id;
    skipWs(cursor);
    while (cursor.pos < cursor.text.length) {
      const arrow = readArrow(cursor);
      if (arrow == null) {
        return ReviewDsl.err(line, `expected "-->" at "${rest(cursor)}"`);
      }
      skipWs(cursor);
      const to = readNodeRef(cursor);
      if (to == null) return ReviewDsl.err(line, `expected a node at "${rest(cursor)}"`);
      ensureNode(to);
      edges.push({ from, to: to.id, label: arrow.label, dashed: arrow.dashed });
      from = to.id;
      skipWs(cursor);
    }
    return ReviewDsl.ok(null);
  }

  type Cursor = { text: string; pos: number };

  function rest(c: Cursor): string {
    return c.text.slice(c.pos, c.pos + 24);
  }

  function skipWs(c: Cursor): void {
    while (c.pos < c.text.length && c.text[c.pos] === " ") c.pos++;
  }

  /** `A`, `A[label]`, `A(label)`, `A{label}`, `A((label))`, `A:::status`. */
  function readNodeRef(c: Cursor): Option<NodeRef> {
    skipWs(c);
    // Hyphens allowed inside ids, but never swallow arrow dashes (`A-->B`,
    // `A-.->B`): a hyphen run must be followed by a word character.
    const id = c.text.slice(c.pos).match(/^[\w.]+(?:-+\w[\w.]*)*/);
    if (id == null) return null;
    c.pos += id[0].length;
    let label: Option<string> = null;
    let shape: Option<Shape> = null;
    const brackets: [string, string, Shape][] = [
      ["((", "))", "rounded"],
      ["([", "])", "rounded"],
      ["[", "]", "box"],
      ["(", ")", "rounded"],
      ["{", "}", "decision"],
    ];
    for (const [open, close, s] of brackets) {
      if (!c.text.startsWith(open, c.pos)) continue;
      const inner = c.pos + open.length;
      // A QUOTED label is mermaid's escape hatch: everything up to the closing
      // quote is literal, so `A["threads[] + blocking[]"]` and a label carrying
      // a `|` both survive. Scanning for the bare closing bracket instead would
      // stop at the first `]` INSIDE the label and hard-error on the remainder
      // (observed: a flowchart silently failed to render for exactly this).
      let labelEnd: number;
      let after: number;
      if (c.text[inner] === '"') {
        const quote = c.text.indexOf('"', inner + 1);
        if (quote < 0 || !c.text.startsWith(close, quote + 1)) return null;
        labelEnd = quote + 1;
        after = quote + 1 + close.length;
      } else {
        const end = c.text.indexOf(close, inner);
        if (end < 0) return null;
        labelEnd = end;
        after = end + close.length;
      }
      label = normalizeLabel(c.text.slice(inner, labelEnd));
      shape = s;
      c.pos = after;
      break;
    }
    let status: Option<FlowParser.Status> = null;
    const cls = c.text.slice(c.pos).match(/^:::(\w+)/);
    if (cls != null) {
      c.pos += cls[0].length;
      const candidate = cls[1].toLowerCase();
      if (STATUSES.includes(candidate as Status)) status = candidate as Status;
    }
    return { id: id[0], label, shape, status };
  }

  /** `-->`, `->`, `-.->`, `---`, optional `|label|` after. */
  function readArrow(c: Cursor): Option<{ label: Option<string>; dashed: boolean }> {
    skipWs(c);
    const m = c.text.slice(c.pos).match(/^(-{1,3}\.?-*>?|={2,}>)/);
    if (m == null || !/[->]$/.test(m[0]) || m[0].length < 2) return null;
    const dashed = m[0].includes(".");
    c.pos += m[0].length;
    let label: Option<string> = null;
    skipWs(c);
    if (c.text[c.pos] === "|") {
      const end = c.text.indexOf("|", c.pos + 1);
      if (end < 0) return null;
      label = normalizeLabel(c.text.slice(c.pos + 1, end));
      c.pos = end + 1;
    }
    return { label, dashed };
  }
}
