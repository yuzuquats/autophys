import type { ProseMirrorEditor } from "../prosemirror";
import { Column } from "../../component-builtin";
import { ReviewDsl } from "../../review-dsl/dsl";
import {
  CalloutParser,
  CompareParser,
  StepsParser,
  TableParser,
} from "../../review-dsl/block-parsers";
import { FlowParser } from "../../review-dsl/flow-parser";
import { SeqParser } from "../../review-dsl/seq-parser";
import { StateParser } from "../../review-dsl/state-parser";
import { Code } from "../code/code";
import { ReviewCallout } from "./review-callout";
import { ReviewCompare } from "./review-compare";
import { ReviewFlow } from "./review-flow";
import { ReviewNav } from "./review-nav";
import { ReviewSeq } from "./review-seq";
import { ReviewState } from "./review-state";
import { ReviewSteps } from "./review-steps";
import { ReviewTable } from "./review-table";

// The single integration point between ```review-* fences and the commit-note
// markdown pipeline. CommitNote's code_block nodeView asks dispatch() first;
// null falls through to the ordinary std-code view, so unknown languages —
// including review-* kinds this build doesn't know yet — render as plain
// code on every surface (the only acceptable failure mode for agent-authored
// content). A fence that parses renders its component; one that doesn't
// renders the source plus a line-numbered error card, never a crash.
// ```mermaid fences are sniffed by header so agents' trained habit works
// unprompted.

export namespace ReviewFence {
  type Kind =
    | "flow"
    | "seq"
    | "state"
    | "callout"
    | "compare"
    | "table"
    | "steps"
    | "agent";

  export function dispatch(
    node: ProseMirrorEditor.ProseMirrorNode,
    nav: Option<ReviewNav>,
  ): Option<ReturnType<ProseMirrorEditor.NodeViewConstructor>> {
    const kind = resolve(node.attrs.params ?? "", node.textContent);
    if (kind == null) return null;
    return new FenceView(kind, node, nav);
  }

  const KINDS = new Map<string, Kind>([
    ["review-flow", "flow"],
    ["review-seq", "seq"],
    ["review-state", "state"],
    ["review-callout", "callout"],
    ["review-compare", "compare"],
    ["review-table", "table"],
    ["review-steps", "steps"],
    // Agent bookkeeping. The service normally lifts this fence out of the
    // note before the UI ever sees it (stack.rs split_agent_note), so this
    // entry is the belt-and-braces path: a note rendered from a source the
    // service did not touch — a storybook, an example, an older fleet
    // service — still folds it away instead of dumping agent scratch into
    // the middle of the teaching prose.
    ["review-agent", "agent"],
  ]);

  function resolve(params: string, body: string): Option<Kind> {
    const lang = params.trim().split(/\s+/, 1)[0].toLowerCase();
    const kind = KINDS.get(lang);
    if (kind != null) return kind;
    if (lang === "mermaid") {
      const first = ReviewDsl.lines(body)[0]?.text ?? "";
      if (/^(?:flowchart|graph)\b/i.test(first)) return "flow";
      if (/^sequencediagram\b/i.test(first)) return "seq";
      if (/^statediagram/i.test(first)) return "state";
    }
    return null;
  }

  class FenceView {
    dom: HTMLElement;

    constructor(
      private kind: Kind,
      node: ProseMirrorEditor.ProseMirrorNode,
      private nav: Option<ReviewNav>,
    ) {
      this.dom = Column.make();
      this.render(node.attrs.params ?? "", node.textContent);
    }

    update(node: ProseMirrorEditor.ProseMirrorNode): boolean {
      if (node.type.name !== "code_block") return false;
      if (resolve(node.attrs.params ?? "", node.textContent) !== this.kind) {
        return false; // let ProseMirror rebuild through the dispatch factory
      }
      this.render(node.attrs.params ?? "", node.textContent);
      return true;
    }

    stopEvent(): boolean {
      return true;
    }

    ignoreMutation(): boolean {
      return true;
    }

    private render(params: string, body: string): void {
      const dialect = `review-${this.kind}`;
      const r = this.build(params, body);
      if (!r.ok) {
        this.renderError(body, dialect, r.error);
        return;
      }
      this.dom.replaceChildren(r.value);
    }

    private build(params: string, body: string): ReviewDsl.Result<HTMLElement> {
      switch (this.kind) {
        case "flow": {
          const r = FlowParser.parse(body);
          if (!r.ok) return r;
          const $el = ReviewFlow.make();
          $el.bind({ graph: r.value });
          return ReviewDsl.ok($el);
        }
        case "seq": {
          const r = SeqParser.parse(body);
          if (!r.ok) return r;
          const $el = ReviewSeq.make();
          $el.bind({ seq: r.value });
          return ReviewDsl.ok($el);
        }
        case "state": {
          const r = StateParser.parse(body);
          if (!r.ok) return r;
          const $el = ReviewState.make();
          $el.bind({ machine: r.value });
          return ReviewDsl.ok($el);
        }
        case "callout": {
          const info = params.trim().replace(/^\S+\s*/, "");
          const r = CalloutParser.parse(info, body);
          if (!r.ok) return r;
          const $el = ReviewCallout.make();
          $el.bind({ callout: r.value });
          return ReviewDsl.ok($el);
        }
        case "compare": {
          const r = CompareParser.parse(body);
          if (!r.ok) return r;
          const $el = ReviewCompare.make();
          $el.bind({ compare: r.value });
          return ReviewDsl.ok($el);
        }
        case "table": {
          const r = TableParser.parse(body);
          if (!r.ok) return r;
          const $el = ReviewTable.make();
          $el.bind({ table: r.value });
          return ReviewDsl.ok($el);
        }
        case "agent": {
          // No DSL to parse — the content is whatever the agent recorded.
          // Rendered folded and preformatted; it is a record, not prose.
          const $details = document.createElement("details");
          $details.className = "review-agent";
          const $summary = document.createElement("summary");
          const text = body.trim();
          // Name the size in the summary: folded content that does not say how
          // much it is hiding reads as empty, and the whole point of the block
          // is that a reviewer can decide whether to look.
          const lines = text === "" ? 0 : text.split("\n").length;
          $summary.textContent = `Agent notes (${lines} line${lines === 1 ? "" : "s"})`;
          const $pre = document.createElement("pre");
          $pre.textContent = text;
          $details.append($summary, $pre);
          return ReviewDsl.ok($details);
        }
        case "steps": {
          const r = StepsParser.parse(body);
          if (!r.ok) return r;
          const $el = ReviewSteps.make();
          $el.bind({ steps: r.value, nav: this.nav });
          return ReviewDsl.ok($el);
        }
      }
    }

    /** Degradation card: the author's source as a plain code block plus a
     * line-numbered parse error. The component is a bonus; the content must
     * never be lost to a typo. */
    private renderError(body: string, dialect: string, error: ReviewDsl.Err): void {
      const $code = Code.make();
      $code.bind({ content: body, language: "plain" });
      const $err = document.createElement("div");
      $err.textContent = `${dialect}: line ${error.line}: ${error.message}`;
      $err.style.font = "500 11px ui-monospace, monospace";
      $err.style.color = "var(--fg-orange, #c77d1e)";
      $err.style.padding = "4px 2px 0";
      this.dom.replaceChildren($code, $err);
    }
  }
}
