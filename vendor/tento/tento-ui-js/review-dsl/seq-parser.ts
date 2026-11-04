import { ReviewDsl } from "./dsl";

// Forgiving parser for the ```review-seq fence — a subset of mermaid
// sequenceDiagram syntax:
//
//   sequenceDiagram           (header optional)
//   participant A as Page     (or `actor`; undeclared actors auto-declare
//   A->>B: request             in first-use order)
//   B-->>A: reply             (`--` renders dashed)
//   Note over A,B: text       (also `Note left of A:` / `Note right of A:`)
//
// Control-flow keywords (loop/alt/opt/par/…) and activation markers are
// skipped silently — their body messages still parse — so typical LLM output
// renders without the fence author trimming it.

export namespace SeqParser {
  export type Actor = { id: string; label: string };
  export type Item =
    | { kind: "msg"; from: string; to: string; text: string; dashed: boolean }
    | { kind: "note"; actors: string[]; text: string };
  export type Doc = { actors: Actor[]; items: Item[] };

  const SKIP_KEYWORDS = [
    "sequencediagram",
    "autonumber",
    "activate",
    "deactivate",
    "loop",
    "alt",
    "else",
    "opt",
    "par",
    "and",
    "critical",
    "option",
    "break",
    "rect",
    "end",
    "box",
    "acctitle",
    "accdescr",
    "title",
  ];

  export function parse(src: string): ReviewDsl.Result<Doc> {
    const actors = new Map<string, Actor>();
    const order: string[] = [];
    const items: Item[] = [];

    const ensureActor = (id: string, label: Option<string>): void => {
      const existing = actors.get(id);
      if (existing == null) {
        actors.set(id, { id, label: label ?? id });
        order.push(id);
      } else if (label != null) {
        existing.label = label;
      }
    };

    for (const { text, line } of ReviewDsl.lines(src)) {
      const keyword = text.split(/[\s:]/, 1)[0].toLowerCase();
      if (SKIP_KEYWORDS.includes(keyword)) continue;

      if (keyword === "participant" || keyword === "actor") {
        const m = text.match(/^\w+\s+(\S+?)(?:\s+as\s+(.+?))?\s*$/i);
        if (m == null) return ReviewDsl.err(line, "unparseable participant");
        ensureActor(m[1], m[2]?.trim() ?? null);
        continue;
      }

      if (keyword === "note") {
        const m = text.match(/^note\s+(?:over\s+([^:]+)|(?:left|right)\s+of\s+([^:]+)):\s*(.*)$/i);
        if (m == null) return ReviewDsl.err(line, "unparseable note");
        const ids = (m[1] ?? m[2])
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "");
        for (const id of ids) ensureActor(id, null);
        items.push({ kind: "note", actors: ids, text: m[3].trim() });
        continue;
      }

      // `A->>B: text` — one or two dashes (two = dashed reply), one or two
      // arrowheads; `-x`/`-)` variants accepted and rendered as plain arrows.
      const m = text.match(/^(\S+?)\s*(--?)(?:>>?|[x)])\s*([^:]+?)\s*:\s*(.*)$/);
      if (m == null) {
        return ReviewDsl.err(line, `expected "A->>B: text" at "${text.slice(0, 24)}"`);
      }
      const from = m[1];
      const to = m[3].trim();
      ensureActor(from, null);
      ensureActor(to, null);
      items.push({
        kind: "msg",
        from,
        to,
        text: m[4].trim(),
        dashed: m[2] === "--",
      });
    }

    if (order.length === 0) return ReviewDsl.err(1, "no actors declared");
    if (order.length > 8) return ReviewDsl.err(1, `too many actors (${order.length} > 8)`);
    if (items.length > ReviewDsl.MAX_EDGES) {
      return ReviewDsl.err(1, `too many rows (${items.length} > ${ReviewDsl.MAX_EDGES})`);
    }
    return ReviewDsl.ok({ actors: order.map((id) => actors.get(id)!), items });
  }
}
