import { assertEquals } from "@std/assert";
import { GestureManager } from "./gesture-manager.ts";

// How a drag gesture's release is routed. Positions are page coordinates.

Deno.test("a release within the click slop of a cancellable gesture is a tap, not a drop", () => {
  assertEquals<string>(
    GestureManager.releaseRoute({ x: 500, y: 400 }, { x: 501, y: 401 }, { cancellable: true }),
    "tap",
  );
});

Deno.test("a straight vertical drag with no sideways travel is a drop", () => {
  assertEquals<string>(
    GestureManager.releaseRoute({ x: 500, y: 400 }, { x: 500, y: 440 }, { cancellable: true }),
    "drop",
  );
});

Deno.test("a drag pressed near the page corner is still a drop", () => {
  assertEquals<string>(
    GestureManager.releaseRoute({ x: 1, y: 1 }, { x: 1, y: 60 }, { cancellable: true }),
    "drop",
  );
  assertEquals<string>(
    GestureManager.releaseRoute({ x: 1, y: 1 }, { x: 1, y: 60 }, { cancellable: false }),
    "drop",
  );
});

Deno.test("a gesture without a cancel callback is handed every release it pressed, as before", () => {
  assertEquals<string>(
    GestureManager.releaseRoute({ x: 500, y: 400 }, { x: 500, y: 400 }, { cancellable: false }),
    "drop",
  );
});

Deno.test("a release with no recorded press is a click", () => {
  assertEquals<string>(
    GestureManager.releaseRoute(null, { x: 10, y: 10 }, { cancellable: true }),
    "click",
  );
});

// A drag press whose pointer the browser cannot capture. `setPointerCapture`
// throws `NotFoundError` for an id that is not an active pointer (a press
// already released, or a scripted PointerEvent). The gesture's `onPointerDown`
// has already started its own state by then, so the press must still end
// through Escape, `pointercancel` or the release. Before, the throw abandoned
// the press: Escape went on to the page (it closed the sheet drawer around a
// still-lifted row) and `onCancel` never ran.

type Listener = (e: unknown) => void;

/** A page with just what `GestureManager` touches, and a body whose capture can be made to throw. */
function withPage(capture: "ok" | "throws", run: (page: {
  readonly manager: GestureManager;
  fire(type: string, e: Record<string, unknown>): void;
}) => void): void {
  const listeners = new Map<string, Listener[]>();
  const captured = new Set<number>();
  const body = {
    style: { userSelect: "" },
    setPointerCapture(id: number) {
      if (capture === "throws") throw new DOMException("No active pointer with the given id is found.", "NotFoundError");
      captured.add(id);
    },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => void captured.delete(id),
  };
  const page: Record<string, unknown> = {
    document: { body },
    window: { addEventListener: (type: string, fn: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
    HTMLElement: class {},
  };
  const saved = Object.keys(page).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  for (const [k, v] of Object.entries(page)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  try {
    const manager = new GestureManager();
    run({
      manager,
      fire: (type, e) => {
        for (const fn of listeners.get(type) ?? []) fn({ type, stopPropagation() {}, preventDefault() {}, ...e });
      },
    });
  } finally {
    for (const [k, d] of saved) {
      if (d == null) Reflect.deleteProperty(globalThis, k);
      else Object.defineProperty(globalThis, k, d);
    }
  }
}

/** Press a drag gesture's element as a browser would: an exception in the handler is reported, not thrown to the page. */
function press($e: { onpointerdown: ((e: unknown) => void) | null }): void {
  try {
    $e.onpointerdown?.({ button: 0, pointerId: 7, pageX: 100, pageY: 100, offsetX: 4, offsetY: 4, target: null, stopPropagation() {}, preventDefault() {} });
  } catch { /* reported by the browser; the press goes on */ }
}

for (const capture of ["ok", "throws"] as const) {
  Deno.test(`a drag press ends on Escape with onCancel, the key going no further (capture ${capture})`, () => {
    withPage(capture, ({ manager, fire }) => {
      const $e = { onpointerdown: null } as unknown as HTMLElement & { onpointerdown: ((e: unknown) => void) | null };
      let downs = 0, cancels = 0;
      manager.addDragGesture($e, "test", { onPointerDown: () => downs++, onPointerMove: () => {}, onCancel: () => cancels++ });
      press($e);
      let prevented = false;
      fire("keydown", { key: "Escape", preventDefault: () => (prevented = true) });
      assertEquals({ downs, cancels, prevented }, { downs: 1, cancels: 1, prevented: true });
    });
  });

  Deno.test(`a drag press ends on pointercancel with onCancel (capture ${capture})`, () => {
    withPage(capture, ({ manager, fire }) => {
      const $e = { onpointerdown: null } as unknown as HTMLElement & { onpointerdown: ((e: unknown) => void) | null };
      let cancels = 0, ups = 0;
      manager.addDragGesture($e, "test", { onPointerMove: () => {}, onPointerUp: () => ups++, onCancel: () => cancels++ });
      press($e);
      fire("pointercancel", { button: 0, pointerId: 7, pageX: 100, pageY: 160, target: null });
      assertEquals({ cancels, ups }, { cancels: 1, ups: 0 });
    });
  });
}

Deno.test("capturePointer reports a pointer the browser cannot capture instead of throwing", () => {
  const $body = { setPointerCapture: () => { throw new DOMException("No active pointer", "NotFoundError"); } };
  assertEquals(GestureManager.capturePointer($body, 7), false);
  assertEquals(GestureManager.capturePointer({ setPointerCapture: () => {} }, 7), true);
});
