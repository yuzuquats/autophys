export {};

// deno-lint-ignore-file ban-types

// deno-lint-ignore no-explicit-any
type Element = any;

// deno-lint-ignore no-explicit-any
const gt = globalThis as any;
gt["disable-dom"] = true;

const noop = () => {};

function makeEventTarget() {
  const listeners = new Map<string, Set<Function>>();
  return {
    addEventListener(type: string, cb: Function) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type))!.add(
        cb,
      );
    },
    removeEventListener(type: string, cb: Function) {
      listeners.get(type)?.delete(cb);
    },
    dispatchEvent(_evt: unknown) {
      /* no-op */
    },
  };
}

// window
if (!("window" in globalThis)) {
  gt.window = {
    ...makeEventTarget(),
    requestAnimationFrame: (cb: (t: number) => void) =>
      setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    matchMedia: () => ({
      matches: false,
      addEventListener: noop,
      removeEventListener: noop,
    }),
    getComputedStyle: () => ({}),
    navigator: { userAgent: "Deno" },
  };
}

// document
if (!("document" in globalThis)) {
  const target = makeEventTarget();
  gt.document = {
    ...target,
    body: makeEventTarget(),
    head: makeEventTarget(),
    documentElement: { style: {} },
    createElement: (_: string) => ({ style: {}, ...makeEventTarget() }),
    createElementNS: (_ns: string, _tag: string) => ({
      style: {},
      ...makeEventTarget(),
    }),
    createTextNode: (text: string) => ({ nodeType: 3, data: text }),
    querySelector: (_: string) => null,
    querySelectorAll: (_: string) => [],
    // handlers some libs assign:
    onpointerdown: null,
    onpointermove: null,
    onpointerup: null,
  };
  gt.window.document = gt.document;
}

// Web Components surface
gt.HTMLElement ??= class {};
gt.ShadowRoot ??= class {};
gt.customElements ??= {
  // deno-lint-ignore no-explicit-any
  _r: new Map<string, any>(),
  // deno-lint-ignore no-explicit-any
  define(name: string, ctor: any) {
    this._r.set(name, ctor);
  },
  get(name: string) {
    return this._r.get(name);
  },
  whenDefined: async (_: string) => {},
  upgrade: (_: Element) => {},
};

// deno-lint-ignore no-explicit-any
gt.CustomEvent ??= class<T = any> {
  type: string;
  detail?: T;
  constructor(type: string, init?: { detail?: T }) {
    this.type = type;
    this.detail = init?.detail;
  }
};
gt.MutationObserver ??= class {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
gt.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

gt.Style = {};

// This file is loaded for its side effects (`import "…/deno-noop.ts";`), but a
// TypeScript file with no top-level import or export is a global script, not a
// module — so `type Element = any` above was declared in the global scope and
// collided with lib.dom.d.ts's `Element`. The empty export makes it a module
// and scopes the alias to the one use below it.
export {};
