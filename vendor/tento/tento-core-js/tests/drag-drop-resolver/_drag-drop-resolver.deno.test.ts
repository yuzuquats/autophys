import { assert, assertEquals } from "jsr:@std/assert";
import {
  DragAction,
  DragDropResolver,
  DragPosition,
  HierarchyGraph,
  NestableChecker,
  ROOT_NODE,
} from "../../drag-drop-resolver.ts";
import { Fixtures } from "../fixture-runner.deno.ts";

type TestTreeNode = { [key: string]: TestTreeNode };

class JsonTestGraph implements HierarchyGraph<string> {
  private nodes: string[] = [];
  private parentMap: Map<number, number> = new Map();
  private childrenMap: Map<number, number[]> = new Map();

  constructor(tree: TestTreeNode) {
    this.buildFromTree(tree);
  }

  private buildFromTree(tree: TestTreeNode, parentIdx?: number) {
    const entries = Object.entries(tree).sort(([a], [b]) => {
      const idxA = Number.parseInt(a.split("/")[0], 10);
      const idxB = Number.parseInt(b.split("/")[0], 10);
      return idxA - idxB;
    });
    for (const [key, children] of entries) {
      const nodeIdx = this.nodes.length;
      this.nodes.push(key);

      if (parentIdx !== undefined) {
        this.parentMap.set(nodeIdx, parentIdx);
        const parentChildren = this.childrenMap.get(parentIdx) ?? [];
        parentChildren.push(nodeIdx);
        this.childrenMap.set(parentIdx, parentChildren);
      }

      this.buildFromTree(children, nodeIdx);
    }
  }

  parentOf(nodeIdx: number): Option<number> {
    return this.parentMap.get(nodeIdx) ?? ROOT_NODE;
  }

  children(nodeIdx: number): Option<number[]> {
    return this.childrenMap.get(nodeIdx) ?? null;
  }

  getDepth(nodeIdx: number): number {
    let depth = 0;
    let current = nodeIdx;
    while (this.parentMap.has(current)) {
      depth++;
      current = this.parentMap.get(current)!;
    }
    return depth;
  }

  isChildAncestorOf(childIdx: number, parentIdx: number): boolean {
    let current = childIdx;
    while (this.parentMap.has(current)) {
      current = this.parentMap.get(current)!;
      if (current === parentIdx) return true;
    }
    return false;
  }

  nodeAt(idx: number): Option<string> {
    return this.nodes[idx] ?? null;
  }

  get maxIdx(): number {
    return this.nodes.length - 1;
  }
}

class JsonNestableChecker implements NestableChecker<string> {
  isNestable(node: string): boolean {
    return node.includes("/nestable");
  }
}

function createDragPosition(input: ResolveInput): DragPosition {
  const { movedTo } = input;
  const idx = Math.floor(movedTo.y);
  const progress = movedTo.y - idx;
  return { idx, progress, xIdxF: movedTo.x };
}

const DIR = new URL(".", import.meta.url).pathname;

// Input union: resolve cases have `start`, valid-parents case has nothing.
// The absent fields are spelled out as `undefined` rather than left off, so
// `input.start !== undefined` discriminates the union.
type ResolveInput = { start: number; movedTo: { x: number; y: number } };
type ValidParentsInput = { start?: undefined; movedTo?: undefined };
type CaseInput = ResolveInput | ValidParentsInput;

// Expected union
type ResolveExpected = { validActions: DragAction[] | null };
type ValidParentsExpected = Record<string, { top: string[]; bottom: string[] }>;
type CaseExpected = ResolveExpected | ValidParentsExpected;

// Shared state per file (built from tree once)
type Shared = { graph: JsonTestGraph; resolver: DragDropResolver<string> };

// Result union
type CaseResult = DragAction | null | Record<string, { top: number[]; bottom: number[] }>;

Fixtures.load<CaseInput, CaseExpected>(DIR, "drag-drop").run<CaseResult, Shared>(
  (input, { graph, resolver }) => {
    if (input.start !== undefined) {
      // resolve case
      return resolver.resolveToAction(input.start, createDragPosition(input)) ??
        null;
    }
    // valid-parents case: compute for every node
    const result: Record<string, { top: number[]; bottom: number[] }> = {};
    for (let i = 0; i <= graph.maxIdx; i++) {
      result[String(i)] = {
        top: resolver.validParentsForIdx(i, "top").slice().sort((a, b) => a - b),
        bottom: resolver.validParentsForIdx(i, "bottom").slice().sort((a, b) => a - b),
      };
    }
    return result;
  },
  (result, expected, caseName) => {
    if ("validActions" in expected) {
      // resolve comparison
      const e = expected as ResolveExpected;
      const r = result as DragAction | null;
      if (!e.validActions || e.validActions.length === 0) {
        assertEquals(r, null, caseName);
        return;
      }
      assert(r != null, `expected action but got null — ${caseName}`);
      const found = e.validActions.some((a) => a.idx === r.idx && a.type === r.type);
      assert(found, `${caseName}: actual ${JSON.stringify(r)} not in ${JSON.stringify(e.validActions)}`);
    } else {
      // valid-parents comparison
      const r = result as Record<string, { top: number[]; bottom: number[] }>;
      const e = expected as ValidParentsExpected;
      const parse = (arr: string[]) =>
        arr.map((s) => (s === "root" ? ROOT_NODE : parseInt(s))).sort((a, b) => a - b);
      for (const [idx, { top, bottom }] of Object.entries(e)) {
        assertEquals(r[idx].top, parse(top), `${caseName}: idx ${idx} top`);
        assertEquals(r[idx].bottom, parse(bottom), `${caseName}: idx ${idx} bottom`);
      }
    }
  },
  {
    before: (file) => {
      const graph = new JsonTestGraph(file["tree"] as TestTreeNode);
      return { graph, resolver: new DragDropResolver(graph, new JsonNestableChecker()) };
    },
  },
);
