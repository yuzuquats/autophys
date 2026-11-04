import { ReviewDsl } from "./dsl";

// Parsers for the non-diagram review-note fences. Each is a few lines of
// forgiving structure over plain text — the value is consistent, token-styled
// rendering, not clever syntax.

/** ```review-callout <kind> [title…]  — body is mini-inline markdown lines. */
export namespace CalloutParser {
  export type Kind = "note" | "warning" | "risk" | "decision";
  export type Callout = { kind: Kind; title: Option<string>; body: string[] };

  const ALIASES = new Map<string, Kind>([
    ["note", "note"],
    ["info", "note"],
    ["tip", "note"],
    ["warning", "warning"],
    ["warn", "warning"],
    ["caution", "risk"],
    ["danger", "risk"],
    ["risk", "risk"],
    ["decision", "decision"],
  ]);

  /** `info` is the fence info string minus the leading `review-callout`. */
  export function parse(info: string, body: string): ReviewDsl.Result<Callout> {
    const words = info.trim().split(/\s+/).filter((w) => w !== "");
    const kind = ALIASES.get(
      (words[0] ?? "note").toLowerCase().replace(/[:\s]/g, ""),
    );
    if (kind == null) {
      return ReviewDsl.err(
        1,
        `unknown callout kind "${words[0]}" (note|warning|risk|decision)`,
      );
    }
    const title = words.slice(1).join(" ");
    const lines = body
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l, i, all) => l !== "" || (i > 0 && i < all.length - 1));
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    while (lines.length > 0 && lines[0] === "") lines.shift();
    if (lines.length === 0) return ReviewDsl.err(1, "empty callout body");
    return ReviewDsl.ok({
      kind,
      title: title === "" ? null : title,
      body: lines,
    });
  }
}

/** ```review-compare — two verbatim panels split by `== before` / `== after`
 * section markers (labels optional), or a single `---` divider. */
export namespace CompareParser {
  export type Panel = { label: string; text: string };
  export type Compare = { before: Panel; after: Panel };

  export function parse(body: string): ReviewDsl.Result<Compare> {
    const lines = body.split("\n");
    const sections: { label: string; start: number }[] = [];
    lines.forEach((l, i) => {
      const m = l.trim().match(/^==\s*(before|after)\s*(?::\s*(.+))?$/i);
      if (m != null) {
        sections.push({ label: m[2]?.trim() ?? m[1].toLowerCase(), start: i });
      }
    });
    const grab = (from: number, to: number): string =>
      lines.slice(from, to).join("\n").replace(/^\n+|\s+$/g, "");

    if (sections.length === 2) {
      const first = lines[sections[0].start].trim().toLowerCase();
      const a = {
        label: sections[0].label,
        text: grab(sections[0].start + 1, sections[1].start),
      };
      const b = {
        label: sections[1].label,
        text: grab(sections[1].start + 1, lines.length),
      };
      return first.startsWith("== after")
        ? ReviewDsl.ok({ before: b, after: a })
        : ReviewDsl.ok({ before: a, after: b });
    }
    const divider = lines.findIndex((l) => /^-{3,}$/.test(l.trim()));
    if (divider >= 0) {
      return ReviewDsl.ok({
        before: { label: "before", text: grab(0, divider) },
        after: { label: "after", text: grab(divider + 1, lines.length) },
      });
    }
    return ReviewDsl.err(
      1,
      'expected "== before" / "== after" sections or a "---" divider',
    );
  }
}

/** ```review-table — markdown pipe rows; first row is the header, a row whose
 * first cell starts with `*` is the chosen one. */
export namespace TableParser {
  export type Row = { cells: string[]; chosen: boolean };
  export type Table = { header: string[]; rows: Row[] };

  export function parse(body: string): ReviewDsl.Result<Table> {
    const rows: string[][] = [];
    for (const { text, line } of ReviewDsl.lines(body)) {
      if (!text.includes("|")) {
        return ReviewDsl.err(line, "expected a |-separated row");
      }
      const cells = text.replace(/^\|/, "").replace(/\|$/, "").split("|").map((
        c,
      ) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      rows.push(cells);
    }
    if (rows.length < 2) {
      return ReviewDsl.err(1, "need a header row and at least one data row");
    }
    const header = rows[0];
    const data = rows.slice(1).map((cells) => {
      const chosen = cells[0].startsWith("*");
      return {
        chosen,
        cells: chosen
          ? [cells[0].replace(/^\*\s*/, ""), ...cells.slice(1)]
          : cells,
      };
    });
    return ReviewDsl.ok({ header, rows: data });
  }
}

/** ```review-steps — one step per line (optional `1.`/`-` prefix); a leading
 * path-like token followed by `—`/`:`/`|` becomes the step's file anchor. */
export namespace StepsParser {
  export type Step = { anchor: Option<string>; body: string };
  export type Steps = { steps: Step[] };

  export function parse(body: string): ReviewDsl.Result<Steps> {
    const steps: Step[] = [];
    for (const { text } of ReviewDsl.lines(body)) {
      const stripped = text.replace(/^(?:\d+[.)]\s+|-\s+)/, "");
      const anchored = stripped.match(/^(\S+)\s*(?:—|:|\|)\s+(.*)$/);
      if (anchored != null && ReviewDsl.isPathLike(anchored[1])) {
        steps.push({ anchor: anchored[1], body: anchored[2] });
      } else {
        steps.push({ anchor: null, body: stripped });
      }
    }
    if (steps.length === 0) return ReviewDsl.err(1, "no steps");
    if (steps.length > 20) {
      return ReviewDsl.err(1, `too many steps (${steps.length} > 20)`);
    }
    return ReviewDsl.ok({ steps });
  }
}
