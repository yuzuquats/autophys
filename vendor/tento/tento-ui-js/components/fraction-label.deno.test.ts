import "../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { $$ } from "../fastdom.ts";
import { FractionLabel } from "./fraction-label.ts";

class Harness {
  readonly label: FractionLabel;
  readonly reads: EmptyFunction[] = [];
  readonly mutations: EmptyFunction[] = [];
  readonly geometryWrites: string[] = [];
  readonly values = new Map<string, string>();
  readonly nodes = new Map<string, HTMLElement>();
  width = 100;
  height = 40;
  layoutReads = 0;
  private readonly measure = $$.measure;
  private readonly mutate = $$.mutate;

  constructor() {
    const inflate = Object.getOwnPropertyDescriptor(FractionLabel, "inflate");
    Object.defineProperty(FractionLabel, "inflate", { configurable: true,
      value: (_constructor: typeof FractionLabel, label: FractionLabel) => {
        Object.defineProperties(label, {
          shadowRoot: { value: { querySelector: (selector: string) => this.node(selector.slice(1)) } },
          offsetWidth: { get: () => { this.layoutReads++; return this.width; } },
          offsetHeight: { get: () => { this.layoutReads++; return this.height; } },
        });
      },
    });
    try { this.label = new FractionLabel(); }
    finally {
      if (inflate) Object.defineProperty(FractionLabel, "inflate", inflate);
      else Reflect.deleteProperty(FractionLabel, "inflate");
    }
    $$.measure = (fn) => { this.reads.push(fn); return fn; };
    $$.mutate = (fn) => { this.mutations.push(fn); return fn; };
  }

  node(id: string): HTMLElement {
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: HTMLElement = Object.create(HTMLElement.prototype);
    const style = {};
    for (const key of ["fontSize", "transform", "left", "top"]) {
      Object.defineProperty(style, key, {
        get: () => this.values.get(`${id}.${key}`) ?? "",
        set: (value: string) => {
          this.geometryWrites.push(`${id}.${key}`);
          this.values.set(`${id}.${key}`, value);
        },
      });
    }
    Object.defineProperties(node, { style: { value: style }, textContent: { value: "", writable: true } });
    node.setAttribute = (name, value) => {
      this.geometryWrites.push(`${id}.${name}`);
      this.values.set(`${id}.${name}`, value);
    };
    this.nodes.set(id, node);
    return node;
  }
  flushReads(): void { while (this.reads.length) this.reads.shift()?.(); }
  flushMutations(): void { while (this.mutations.length) this.mutations.shift()?.(); }
  flush(): void { this.flushReads(); this.flushMutations(); }
  restore(): void { $$.measure = this.measure; $$.mutate = this.mutate; }
}

Deno.test("fraction label: text-only binds update text without measuring or rewriting geometry", () => {
  const h = new Harness();
  try {
    h.label.bind("1", "2", 12);
    h.label.onSizeChange({ width: 100, height: 40 });
    h.flush();
    const geometry = [...h.values], reads = h.layoutReads;
    h.geometryWrites.length = 0;
    for (const [num, den] of [["12345", "6"], ["7", "88888"], ["−1", "∞"]]) {
      h.label.bind(num, den, 12);
      assertEquals(h.node("numerator").textContent, num);
      assertEquals(h.node("denominator").textContent, den);
    }
    h.flush();
    assertEquals(h.layoutReads, reads);
    assertEquals(h.geometryWrites, []);
    assertEquals([...h.values], geometry);
  } finally { h.restore(); }
});

Deno.test("fraction label: zero-size text changes wait for ResizeObserver without repeated reads", () => {
  const h = new Harness();
  try {
    h.width = 0; h.height = 0;
    h.label.bind("1", "2", null);
    h.flush();
    const reads = h.layoutReads;
    h.label.bind("33", "44", null);
    h.flush();
    assertEquals(h.layoutReads, reads);
    assertEquals(h.geometryWrites, []);
    h.label.onSizeChange({ width: 100, height: 40 });
    assertEquals(h.values.get("numbers.left"), "50px");
    assertEquals(h.values.get("numerator.fontSize"), "12px");
    assertEquals(h.node("numerator").textContent, "33");
  } finally { h.restore(); }
});

Deno.test("fraction label: hidden font change renders on return even at its former size", () => {
  const h = new Harness();
  try {
    h.label.bind("1", "2", 12);
    h.label.onSizeChange({ width: 100, height: 40 }); h.flush();
    h.width = 0; h.height = 0;
    h.label.onSizeChange({ width: 0, height: 0 });
    h.label.bind("3", "4", 18); h.flush();
    assertEquals(h.values.get("numerator.fontSize"), "12px");
    h.label.onSizeChange({ width: 100, height: 40 });
    assertEquals(h.values.get("numerator.fontSize"), "18px");
    assertEquals(h.values.get("denominator.fontSize"), "18px");
    h.geometryWrites.length = 0;
    h.label.onSizeChange({ width: 100, height: 40 });
    assertEquals(h.geometryWrites, []);
  } finally { h.restore(); }
});

Deno.test("fraction label: queued measurement cannot overwrite newer ResizeObserver geometry", () => {
  const h = new Harness();
  try {
    h.label.bind("1", "2", 12);
    h.label.onSizeChange({ width: 100, height: 40 });
    h.label.bind("1", "2", 18);
    h.flushReads();
    h.label.onSizeChange({ width: 200, height: 80 });
    const geometry = [...h.values];
    h.geometryWrites.length = 0;
    h.flushMutations();
    assertEquals(h.values.get("numbers.left"), "100px");
    assertEquals(h.values.get("numbers.top"), "40px");
    assertEquals([...h.values], geometry);
    assertEquals(h.geometryWrites, []);
  } finally { h.restore(); }
});

Deno.test("fraction label: a ResizeObserver update before measurement avoids duplicate work", () => {
  const h = new Harness();
  try {
    h.label.bind("1", "2", 12);
    h.label.onSizeChange({ width: 100, height: 40 });
    h.geometryWrites.length = 0;
    h.flush();
    assertEquals(h.layoutReads, 0);
    assertEquals(h.geometryWrites, []);
  } finally { h.restore(); }
});

Deno.test("fraction label: recycling retires old geometry writes and the new occupant waits for its observer", () => {
  const h = new Harness();
  try {
    h.label.bind("1", "2", 12);
    h.label.onSizeChange({ width: 100, height: 40 });
    h.label.bind("1", "2", 18); h.flushReads();
    h.geometryWrites.length = 0;
    h.label.onRecycle();
    h.flushMutations();
    assertEquals(h.geometryWrites, []);
    h.width = 200; h.height = 80;
    h.label.bind("3", "4", 12); h.flush();
    assertEquals(h.geometryWrites, []);
    h.label.onSizeChange({ width: 200, height: 80 });
    assertEquals(h.values.get("numbers.left"), "100px");
    assertEquals(h.node("numerator").textContent, "3");
  } finally { h.restore(); }
});

Deno.test("fraction label: first bind waits for initial ResizeObserver without scheduling a layout read", () => {
  const h = new Harness();
  try {
    h.label.bind("1", "2", 18);
    assertEquals(h.reads.length, 0);
    h.flush();
    assertEquals(h.layoutReads, 0);
    assertEquals(h.geometryWrites, []);
    h.label.onSizeChange({ width: 100, height: 40 });
    assertEquals(h.values.get("numerator.fontSize"), "18px");
    assertEquals(h.values.get("numbers.left"), "50px");
  } finally { h.restore(); }
});

Deno.test("fraction label: first bind uses an already observed size with the requested font", () => {
  const h = new Harness();
  try {
    h.label.onSizeChange({ width: 120, height: 60 });
    h.label.bind("10", "11", 18);
    assertEquals(h.reads.length, 0);
    assertEquals(h.values.get("numerator.fontSize"), "18px");
    assertEquals(h.values.get("numbers.left"), "60px");
    assertEquals(h.node("numerator").textContent, "10");
  } finally { h.restore(); }
});

Deno.test("fraction label: a zero observation supersedes a pre-bind positive size", () => {
  const h = new Harness();
  try {
    h.label.onSizeChange({ width: 120, height: 60 });
    h.label.onSizeChange({ width: 0, height: 0 });
    h.geometryWrites.length = 0;
    h.label.bind("10", "11", 18); h.flush();
    assertEquals(h.geometryWrites, []);
    assertEquals(h.layoutReads, 0);
    h.label.onSizeChange({ width: 200, height: 80 });
    assertEquals(h.values.get("numbers.left"), "100px");
  } finally { h.restore(); }
});

Deno.test("fraction label: newest font owns queued work and disconnect retires pending paint", () => {
  const h = new Harness();
  try {
    h.label.bind("1", "2", 12);
    h.label.bind("3", "4", 18);
    h.flush();
    assertEquals(h.layoutReads, 2);
    assertEquals(h.values.get("numerator.fontSize"), "18px");
    h.label.bind("5", "6", 24); h.flushReads();
    h.label.disconnectedCallback();
    h.geometryWrites.length = 0;
    h.flushMutations();
    assertEquals(h.geometryWrites, []);
    h.label.onSizeChange({ width: 100, height: 40 });
    assertEquals(h.values.get("numerator.fontSize"), "24px");
  } finally { h.restore(); }
});
