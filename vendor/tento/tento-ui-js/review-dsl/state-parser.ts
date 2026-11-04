import { ReviewDsl } from "./dsl";

// Forgiving parser for the ```review-state fence — a subset of mermaid
// stateDiagram-v2 syntax:
//
//   stateDiagram-v2            (header optional)
//   [*] --> Queued
//   Queued --> Staged: stage ok
//   Staged --> Drained: drain ::new
//   state "Long label" as Staged
//   Drained --> [*]
//   class Queued,Staged changed
//
// `::new` / `::removed` on a transition label marks that single transition;
// `class` statements mark states (same semantic statuses as review-flow).
// Composite-state braces and note blocks are skipped silently.

export namespace StateParser {
  export type Status = "changed" | "new" | "removed";
  export type State = {
    id: string;
    label: string;
    status: Option<Status>;
    pseudo: Option<"start" | "end">;
  };
  export type Transition = {
    from: string;
    to: string;
    label: Option<string>;
    status: Option<Status>;
  };
  export type Machine = { states: State[]; transitions: Transition[] };

  export const START = "__start__";
  export const END = "__end__";

  const STATUSES: Status[] = ["changed", "new", "removed"];

  export function parse(src: string): ReviewDsl.Result<Machine> {
    const states = new Map<string, State>();
    const order: string[] = [];
    const transitions: Transition[] = [];
    let inNote = false;

    const ensure = (idRaw: string, isTarget: boolean): Option<string> => {
      const id = idRaw.trim();
      if (id === "[*]") {
        const pid = isTarget ? END : START;
        if (!states.has(pid)) {
          states.set(pid, {
            id: pid,
            label: "",
            status: null,
            pseudo: isTarget ? "end" : "start",
          });
          order.push(pid);
        }
        return pid;
      }
      if (!/^[\w.-]+$/.test(id)) return null;
      if (!states.has(id)) {
        states.set(id, { id, label: id, status: null, pseudo: null });
        order.push(id);
      }
      return id;
    };

    for (const { text, line } of ReviewDsl.lines(src)) {
      const lower = text.toLowerCase();
      if (inNote) {
        if (lower === "end note") inNote = false;
        continue;
      }
      if (/^statediagram/.test(lower) || /^direction\b/.test(lower)) continue;
      if (/^note\b/.test(lower)) {
        // one-liner `note right of A: text` vs block form ending in `end note`
        if (!text.includes(":")) inNote = true;
        continue;
      }
      if (text === "}" || text === "{") continue;

      const alias = text.match(/^state\s+"([^"]+)"\s+as\s+([\w.-]+)\s*\{?$/i);
      if (alias != null) {
        const id = ensure(alias[2], false);
        if (id != null) states.get(id)!.label = alias[1];
        continue;
      }
      const bare = text.match(/^state\s+([\w.-]+)\s*\{?$/i);
      if (bare != null) {
        ensure(bare[1], false);
        continue;
      }

      if (/^class\s/.test(lower)) {
        const m = text.match(/^class\s+([\w.,\s-]+?)\s+(\w+)\s*;?$/i);
        if (m == null) return ReviewDsl.err(line, "unparseable class statement");
        const status = m[2].toLowerCase();
        if (!STATUSES.includes(status as Status)) continue;
        for (const id of m[1].split(",").map((s) => s.trim())) {
          const state = states.get(id);
          if (state != null) state.status = status as Status;
        }
        continue;
      }

      const t = text.match(/^(\[\*\]|[\w.-]+)\s*-->\s*(\[\*\]|[\w.-]+)\s*(?::\s*(.*))?$/);
      if (t == null) {
        return ReviewDsl.err(line, `expected "A --> B[: label]" at "${text.slice(0, 24)}"`);
      }
      const from = ensure(t[1], false);
      const to = ensure(t[2], true);
      if (from == null || to == null) {
        return ReviewDsl.err(line, "unparseable state name");
      }
      let label: Option<string> = t[3]?.trim() ?? null;
      let status: Option<Status> = null;
      const marked = label?.match(/^(.*?)\s*::(\w+)$/);
      if (marked != null) {
        const candidate = marked[2].toLowerCase();
        if (STATUSES.includes(candidate as Status)) {
          status = candidate as Status;
          label = marked[1].trim();
        }
      }
      if (label === "") label = null;
      transitions.push({ from, to, label, status });
    }

    if (order.length === 0) return ReviewDsl.err(1, "no states declared");
    if (order.length > ReviewDsl.MAX_NODES) {
      return ReviewDsl.err(1, `too many states (${order.length} > ${ReviewDsl.MAX_NODES})`);
    }
    if (transitions.length > ReviewDsl.MAX_EDGES) {
      return ReviewDsl.err(1, `too many transitions (${transitions.length} > ${ReviewDsl.MAX_EDGES})`);
    }
    return ReviewDsl.ok({ states: order.map((id) => states.get(id)!), transitions });
  }
}
