import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { $$ } from "../../fastdom.ts";
import { initHtmlElement } from "../../init/html-element.global.ts";
import { ScrollHorizontal } from "./scroll-horizontal.ts";

function element(): HTMLElement {
  const node: HTMLElement = Object.create(HTMLElement.prototype);
  const properties = new Map<string, string>(), attributes = new Set<string>();
  Object.defineProperty(node, "style", { value: {
    height: "",
    getPropertyValue: (name: string) => properties.get(name) ?? "",
    setProperty: (name: string, value: string) => { properties.set(name, value); },
  } });
  node.addEventListener = () => {};
  node.hasAttribute = (name) => attributes.has(name);
  node.setAttribute = (name) => { attributes.add(name); };
  node.toggleAttribute = (name, force) => {
    const on = force ?? !attributes.has(name);
    if (on) attributes.add(name); else attributes.delete(name);
    return on;
  };
  return node;
}

class Harness {
  readonly reads: EmptyFunction[] = [];
  readonly writes: EmptyFunction[] = [];
  readonly nodes = new Map<string, HTMLElement>();
  readonly host: ScrollHorizontal<HTMLElement, HTMLElement>;
  measuredHeight = 321;
  layoutReads = 0;
  private readonly measure = $$.measure;
  private readonly mutate = $$.mutate;

  constructor() {
    const inflate = Object.getOwnPropertyDescriptor(ScrollHorizontal, "inflate");
    Object.defineProperty(ScrollHorizontal, "inflate", { configurable: true,
      value: (_constructor: typeof ScrollHorizontal, host: ScrollHorizontal<HTMLElement, HTMLElement>) => {
        const shell = element();
        Object.defineProperties(host, {
          shadowRoot: { value: { querySelector: (selector: string) => this.node(selector.slice(1)) } },
          style: { value: shell.style },
        });
        host.hasAttribute = shell.hasAttribute;
        host.setAttribute = shell.setAttribute;
        host.toggleAttribute = shell.toggleAttribute;
      },
    });
    try { this.host = new ScrollHorizontal<HTMLElement, HTMLElement>(); }
    finally {
      if (inflate) Object.defineProperty(ScrollHorizontal, "inflate", inflate);
      else Reflect.deleteProperty(ScrollHorizontal, "inflate");
    }
    Object.defineProperty(this.node("content-viewport"), "scrollHeight", {
      get: () => { this.layoutReads++; return this.measuredHeight; },
    });
    initHtmlElement();
    $$.measure = (fn) => { this.reads.push(fn); return fn; };
    $$.mutate = (fn) => { this.writes.push(fn); return fn; };
  }

  node(id: string): HTMLElement {
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const fresh = element();
    this.nodes.set(id, fresh);
    return fresh;
  }
  flushReads(): void { while (this.reads.length) this.reads.shift()?.(); }
  flushWrites(): void { while (this.writes.length) this.writes.shift()?.(); }
  flush(): void { this.flushReads(); this.flushWrites(); }
  body(): string { return this.node("content").style.getPropertyValue("--content-body-height"); }
  chrome(header: string, footer: string): void {
    assertEquals(this.node("headers").style.height, header);
    assertEquals(this.node("footers").style.height, footer);
    assertEquals(this.node("footer-sidebar").style.height, footer);
  }
  restore(): void { $$.measure = this.measure; $$.mutate = this.mutate; }
}

function props(height: Option<number>, header: number, footer: number): ScrollHorizontal.Props {
  return { scrollContentHeight: height, headerHeight: header, footerHeight: footer };
}

Deno.test("scroll-height binding: explicit height including zero never schedules a layout read", () => {
  const h = new Harness();
  try {
    h.host.bindScroll(props(0, 22, 10));
    assertEquals(h.reads.length, 0);
    h.flush();
    assertEquals(h.layoutReads, 0);
    assertEquals(h.body(), "0px");
    h.chrome("22px", "12px");
  } finally { h.restore(); }
});

Deno.test("scroll-height binding: only the latest full request may measure or commit geometry", () => {
  const h = new Harness();
  try {
    h.host.bindScroll(props(null, 11, 1));
    h.host.bindScroll(props(600, 22, 10));
    h.flush();
    assertEquals(h.layoutReads, 0, "superseded auto-height request must not force layout");
    assertEquals(h.body(), "600px");
    h.chrome("22px", "12px");
    h.host.bindScroll(props(700, 33, 20));
    h.host.bindScroll(props(800, 44, 30));
    h.writes.shift()?.();
    assertEquals(h.body(), "600px", "obsolete queued mutation cannot temporarily paint old geometry");
    h.flush();
    assertEquals(h.body(), "800px");
    h.chrome("44px", "32px");
  } finally { h.restore(); }
});

Deno.test("scroll-height binding: later height-only wins body without losing pending header and footer", () => {
  const h = new Harness();
  try {
    h.host.bindScroll(props(600, 22, 10));
    h.host.bindScrollHeightOnly(777);
    h.flush();
    assertEquals(h.body(), "777px");
    assertEquals(h.host["bodyHeight"], 777);
    h.chrome("22px", "12px");
    h.host.bindScroll(props(888, 33, 20));
    h.flush();
    assertEquals(h.body(), "888px", "a later full request regains body ownership");
  } finally { h.restore(); }
});

Deno.test("scroll-height binding: null height measures current fallback, including a genuine zero", () => {
  const h = new Harness();
  try {
    for (const height of [321, 432, 0]) {
      h.measuredHeight = height;
      h.host.bindScroll(props(null, 22, 10));
      h.flush();
      assertEquals(h.body(), `${height}px`);
      assertEquals(h.host["scrollHeightSnapshot"], height);
    }
    assertEquals(h.layoutReads, 3);
  } finally { h.restore(); }
});

Deno.test("scroll-height binding: height-only supersedes auto-height before or after its measurement", () => {
  const h = new Harness();
  try {
    h.host.bindScroll(props(null, 22, 10));
    h.host.bindScrollHeightOnly(777);
    h.flush();
    assertEquals(h.layoutReads, 0);
    assertEquals(h.body(), "777px");
    h.chrome("22px", "12px");
    h.host.bindScroll(props(null, 33, 20));
    h.flushReads();
    assertEquals(h.layoutReads, 1);
    h.host.bindScrollHeightOnly(888);
    h.flushWrites();
    assertEquals(h.body(), "888px");
    h.chrome("33px", "22px");
  } finally { h.restore(); }
});

Deno.test("scroll-height binding: disconnect and recycle retire queued reads and writes", () => {
  for (const lifecycle of ["disconnectedCallback", "onRecycle"] as const) {
    for (const stage of ["measure", "mutate"] as const) {
      const h = new Harness();
      try {
        h.host.bindScrollHeightOnly(99);
        h.host.bindScroll(props(stage === "measure" ? null : 600, 22, 10));
        h.host[lifecycle]();
        h.flush();
        assertEquals(h.layoutReads, 0);
        assertEquals(h.body(), "99px");
        h.chrome("", "");
        h.host.bindScroll(props(777, 33, 20));
        h.flush();
        assertEquals(h.body(), "777px", "a new post-lifecycle request remains usable");
        h.chrome("33px", "22px");
      } finally { h.restore(); }
    }
  }
});

Deno.test("scroll-height binding: repeating props restores an imperatively changed header peek", () => {
  const h = new Harness();
  try {
    const p = props(600, 22, 10);
    h.host.bindScroll(p);
    h.flush();
    h.host.headerPeek.setHeight(99, false);
    assertEquals(h.node("headers").style.height, "99px");
    h.host.bindScroll(p);
    h.flush();
    h.chrome("22px", "12px");
  } finally { h.restore(); }
});
