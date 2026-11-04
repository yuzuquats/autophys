import "../../deno-noop.ts";

import { assertEquals, assertNotEquals, assertThrows, assertStrictEquals, assertNotStrictEquals } from "jsr:@std/assert";
import { DurationTime } from "@tento-chrono";
import { ColumnLayout } from "@tento-core/column-layout";
import { $$ } from "../../fastdom.ts";
import { CalendarColumnLayoutGroup as Group } from "./calendar-column-layout-group.ts";

class Cell {
  readonly $e: HTMLElement = Object.create(HTMLElement.prototype);
  readonly styles = new Map<string, string>();
  readonly attributes = new Set<string>();
  info: Group.LayoutInfo;
  $parent: Option<HTMLElement>;
  writes = 0;
  /** `toggleAttribute` calls: each one is a style invalidation in a browser. */
  toggles = 0;

  constructor($parent: HTMLElement, id: string, start: number, end: number) {
    this.$parent = $parent;
    this.info = Cell.info(id, start, end);
    const self = this;
    Object.defineProperties(this.$e, {
      parentElement: { get: () => this.$parent },
      visibleLayoutInfo: { configurable: true, get: () => this.info },
      style: {
        value: {
          getPropertyValue(name: string) {
            return self.styles.get(name) ?? "";
          },
          get cssText() {
            return JSON.stringify([...self.styles]);
          },
        },
      },
    });
    this.$e.hasAttribute = (name) => this.attributes.has(name);
    this.$e.removeAttribute = (name) => {
      this.attributes.delete(name);
    };
    this.$e.toggleAttribute = (name, force) => {
      this.toggles++;
      const on = force ?? !this.attributes.has(name);
      if (on) this.attributes.add(name);
      else this.attributes.delete(name);
      return on;
    };
    Object.defineProperty(this.$e, "assignStyles", {
      value: (styles: CSSStyleWithVariables) => {
        this.writes++;
        for (const [key, value] of Object.entries(styles)) {
          this.styles.set(
            key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()),
            String(value),
          );
        }
        return this.$e;
      },
    });
  }

  static info(id: string, start: number, end: number): Group.LayoutInfo {
    return new Group.LayoutInfo(
      id,
      new DurationTime.Range(
        DurationTime.hrs(start),
        DurationTime.hrs(end),
      ),
    );
  }

  entry(): Group.Cell {
    return { $e: this.$e, info: this.info };
  }
  bind(id: string, start: number, end: number): void {
    this.info = Cell.info(id, start, end);
  }
}

class Harness {
  readonly $group: Group;
  readonly queue: EmptyFunction[] = [];
  private readonly mutate = $$.mutate;
  private readonly generate = ColumnLayout.compute;
  computes = 0;

  constructor() {
    const inflate = Object.getOwnPropertyDescriptor(Group, "inflate");
    Object.defineProperty(Group, "inflate", {
      configurable: true,
      value: () => {},
    });
    try {
      this.$group = new Group();
    } finally {
      if (inflate) Object.defineProperty(Group, "inflate", inflate);
      else Reflect.deleteProperty(Group, "inflate");
    }
    $$.mutate = (fn) => {
      this.queue.push(fn);
      return fn;
    };
    ColumnLayout.compute = (cells, options) => {
      this.computes++;
      return this.generate(cells, options);
    };
  }
  cell(id: string, start: number, end: number): Cell {
    return new Cell(this.$group, id, start, end);
  }
  layout(cells: Cell[]): void {
    this.$group.layout(cells.map((cell) => cell.entry()));
  }
  flush(): void {
    while (this.queue.length) this.queue.shift()?.();
  }
  restore(): void {
    $$.mutate = this.mutate;
    ColumnLayout.compute = this.generate;
  }
}

function test(name: string, run: (h: Harness) => void): void {
  Deno.test("calendar overlap layout: " + name, () => {
    const h = new Harness();
    try {
      run(h);
    } finally {
      h.restore();
    }
  });
}

test("unchanged positions skip queued writes across fresh view models and event IDs", (h) => {
  const a = h.cell("a", 1, 3), b = h.cell("b", 2, 4);
  h.layout([a, b]);
  h.flush();
  const styles = [a.$e.style.cssText, b.$e.style.cssText];
  a.bind("another-day-a", 1, 3);
  b.bind("another-day-b", 2, 4);
  h.layout([b, a]);
  assertEquals(h.queue.length, 0);
  assertEquals([a.writes, b.writes], [1, 1]);
  assertEquals([a.$e.style.cssText, b.$e.style.cssText], styles);
});

test("overlap changes still move cells", (h) => {
  const a = h.cell("a", 1, 3), b = h.cell("b", 2, 4);
  h.layout([a, b]);
  h.flush();
  const before = b.$e.style.cssText;
  b.bind("b", 4, 5);
  h.layout([a, b]);
  h.flush();
  assertNotEquals(b.$e.style.cssText, before);
  assertEquals(b.styles.get("z-index"), "0");
});

test("ID tie-break changes cannot reuse another cell's lane", (h) => {
  const a = h.cell("a", 1, 3), b = h.cell("b", 1, 3);
  h.layout([a, b]);
  h.flush();
  assertEquals([a.styles.get("z-index"), b.styles.get("z-index")], ["0", "1"]);
  a.bind("z", 1, 3);
  h.layout([a, b]);
  h.flush();
  assertEquals([a.styles.get("z-index"), b.styles.get("z-index")], ["1", "0"]);
});

test("replacement elements get positions and first reveal even with identical times", (h) => {
  const a = h.cell("a", 1, 3);
  h.layout([a]);
  h.flush();
  const replacement = h.cell("a", 1, 3);
  replacement.attributes.add("pending-layout");
  h.layout([replacement]);
  assertEquals(replacement.attributes.has("pending-layout"), true);
  h.flush();
  assertEquals(replacement.writes, 1);
  assertEquals(replacement.attributes.has("pending-layout"), false);
});

test("an unchanged cell that needs reveal still gets the positioning mutate", (h) => {
  const a = h.cell("a", 1, 3);
  h.layout([a]);
  h.flush();
  a.attributes.add("pending-layout");
  h.layout([a]);
  assertEquals(a.attributes.has("pending-layout"), true);
  h.flush();
  assertEquals(a.attributes.has("pending-layout"), false);
  assertEquals(a.writes, 2);
});

test("externally cleared inline styles are repaired", (h) => {
  const a = h.cell("a", 1, 3);
  h.layout([a]);
  h.flush();
  const expected = a.$e.style.cssText;
  a.styles.clear();
  h.layout([a]);
  h.flush();
  assertEquals(a.$e.style.cssText, expected);
  assertEquals(a.writes, 2);
});

test("only the latest queued layout writes and reveals", (h) => {
  const a = h.cell("a", 1, 3), b = h.cell("b", 2, 4);
  a.attributes.add("pending-layout");
  b.attributes.add("pending-layout");
  h.layout([a, b]);
  b.bind("b", 4, 5);
  h.layout([a, b]);
  h.flush();
  assertEquals([a.writes, b.writes], [1, 1]);
  assertEquals(b.styles.get("z-index"), "0");
  assertEquals([a.attributes.size, b.attributes.size], [0, 0]);
});

test("returning to the applied layout cancels an intervening queued change", (h) => {
  const a = h.cell("a", 1, 3), b = h.cell("b", 2, 4);
  h.layout([a, b]);
  h.flush();
  const expected = b.$e.style.cssText;
  b.bind("b", 4, 5);
  h.layout([a, b]);
  b.bind("b", 2, 4);
  h.layout([a, b]);
  h.flush();
  assertEquals(b.$e.style.cssText, expected);
  assertEquals(b.writes, 1);
});

test("a rebound occupant rejects its old queued write", (h) => {
  const a = h.cell("a", 1, 3);
  h.layout([a]);
  a.bind("new", 4, 5);
  h.flush();
  assertEquals(a.writes, 0);
  h.layout([a]);
  h.flush();
  assertEquals(a.writes, 1);
});

test("moving a cell to another group rejects its old queued write", (h) => {
  const a = h.cell("a", 1, 3);
  h.layout([a]);
  a.$parent = null;
  h.flush();
  assertEquals(a.writes, 0);
});

test("empty layouts invalidate old queued work and do not retain the previous population", (h) => {
  const a = h.cell("a", 1, 3);
  h.layout([a]);
  h.layout([]);
  h.flush();
  assertEquals(a.writes, 0);
  h.layout([a]);
  h.flush();
  assertEquals(a.writes, 1);
});

test("recycling cancels queued work and clears applied geometry", (h) => {
  const a = h.cell("a", 1, 3);
  h.layout([a]);
  h.$group.onRecycle();
  h.flush();
  assertEquals(a.writes, 0);
  h.layout([a]);
  h.flush();
  h.$group.onRecycle();
  h.layout([a]);
  h.flush();
  assertEquals(a.writes, 1);
  assertEquals(h.computes, 3);
});

test("explicit cell lists also support ordinary HTML destinations", (h) => {
  const a = h.cell("plain", 1, 3);
  Reflect.deleteProperty(a.$e, "visibleLayoutInfo");
  h.layout([a]);
  h.flush();
  assertEquals(a.writes, 1);
  h.layout([a]);
  assertEquals(h.queue.length, 0);
});

test("a cell excluded from layout before flush keeps its reveal state", (h) => {
  const a = h.cell("ghost", 1, 3);
  a.attributes.add("pending-layout");
  h.layout([a]);
  Object.defineProperty(a.$e, "visibleLayoutInfo", { get: () => null });
  h.flush();
  assertEquals(a.writes, 0);
  assertEquals(a.attributes.has("pending-layout"), true);
});

test("uniform time shifts reuse overlap geometry while preserving updated vertical styles", (h) => {
  const a = h.cell("a", 1, 3), b = h.cell("b", 2, 4);
  h.layout([a, b]);
  h.flush();
  a.bind("next-a", 2, 4);
  b.bind("next-b", 3, 5);
  a.styles.set("--p-start-time-hrs", "2");
  h.layout([a, b]);
  assertEquals(h.computes, 1);
  assertEquals(h.queue.length, 0);
  assertEquals(a.styles.get("--p-start-time-hrs"), "2");
});

test("recycled destinations already in the correct lanes need no writes", (h) => {
  const a = h.cell("a", 1, 3), b = h.cell("b", 2, 4);
  h.layout([a, b]);
  h.flush();
  const c = h.cell("c", 2, 4), d = h.cell("d", 3, 5);
  for (const [key, value] of a.styles) c.styles.set(key, value);
  for (const [key, value] of b.styles) d.styles.set(key, value);
  h.layout([c, d]);
  assertEquals(h.computes, 1);
  assertEquals(h.queue.length, 0);
  assertEquals([c.writes, d.writes], [0, 0]);
});

test("altered owned styles are repaired using the cached overlap plan", (h) => {
  const a = h.cell("a", 1, 3);
  h.layout([a]);
  h.flush();
  a.styles.set("background", "unset");
  h.layout([a]);
  h.flush();
  assertEquals(h.computes, 1);
  assertEquals(a.styles.get("background"), "");
  assertEquals(a.writes, 2);
});


test("complete plan preserves offscreen overlap lanes for every resident subset", (h) => {
  const fixtures = [
    [["long", 0, 24], ["a", 1, 3], ["b", 2, 4], ["c", 4, 5], ["zero", 6, 6]],
    [["z", 1, 3], ["a", 1, 3], ["short", 1, 2]],
    Array.from({ length: 10 }, (_, index) => [String(index), 1, 3]),
  ] as [string, number, number][][];
  for (const fixture of fixtures) {
    const full = fixture.map(([id, start, end]) => h.cell(id, start, end));
    const legacy = Group.Layout.generate(full.map((cell) => cell.entry()), {});
    h.layout(full);
    h.flush();
    const expected = new Map(full.map((cell) => [cell.info.id, cell.$e.style.cssText]));
    const plan = h.$group.plan(full.map((cell) => cell.info).reverse());
    assertEquals(plan.entries.map((entry) => entry.layout), legacy.layouts);
    for (const cell of full) {
      const resident = h.cell(cell.info.id, cell.info.time.start.toMs / 3600000, cell.info.time.end.toMs / 3600000);
      resident.attributes.add("pending-layout");
      h.$group.applyPlan(plan, [resident.entry()]);
      h.flush();
      assertEquals(resident.$e.style.cssText, expected.get(cell.info.id));
      assertEquals(resident.attributes.size, 0);
    }
  }
});

test("cached complete plan remaps tie IDs and absolute offsets without recompute", (h) => {
  const first = h.$group.plan([Cell.info("a", 1, 3), Cell.info("b", 1, 3)]);
  const shifted = h.$group.plan([Cell.info("z", 5, 7), Cell.info("b", 5, 7)]);
  assertEquals(h.computes, 1);
  assertEquals(shifted.entries.map((entry) => entry.id), ["b", "z"]);
  assertEquals(shifted.byId.get("b")?.layout.columnIndex, 0);
  assertEquals(shifted.byId.get("z")?.layout.columnIndex, 1);
  assertEquals(shifted.byId.get("b")?.startMs, 5 * 3600000);
  assertEquals(first.byId.get("b")?.layout.columnIndex, 1);
  const cell = h.cell("z", 5, 7);
  h.$group.applyPlan(shifted, [cell.entry()]);
  h.flush();
  assertEquals(cell.styles.get("z-index"), "1");
});

test("duplicate keyed identities fail loudly while legacy duplicates retain lanes", (h) => {
  const a = h.cell("same", 1, 3), b = h.cell("same", 1, 3);
  assertThrows(() => h.$group.plan([a.info, b.info]), Error, "Duplicate");
  h.layout([a, b]);
  h.flush();
  assertEquals([a.styles.get("z-index"), b.styles.get("z-index")], ["0", "1"]);
});

test("plan replacement and recycle invalidate pending subset reveals", (h) => {
  const a = h.cell("a", 1, 3);
  a.attributes.add("pending-layout");
  const old = h.$group.plan([a.info]);
  h.$group.applyPlan(old, [a.entry()]);
  const current = h.$group.plan([a.info, Cell.info("b", 2, 4)]);
  h.flush();
  assertEquals(a.writes, 0);
  h.$group.applyPlan(old, [a.entry()]);
  assertEquals(h.queue.length, 0);
  h.$group.applyPlan(current, [a.entry()]);
  h.$group.onRecycle();
  h.flush();
  h.$group.applyPlan(current, [a.entry()]);
  assertEquals(a.writes, 0);
  assertEquals(a.attributes.has("pending-layout"), true);
});

test("empty complete plans cancel queued writes and changed residents are rejected", (h) => {
  const a = h.cell("a", 1, 3);
  const plan = h.$group.plan([a.info]);
  a.bind("a", 2, 4);
  assertThrows(() => h.$group.applyPlan(plan, [a.entry()]), Error, "changed");
  a.bind("a", 1, 3);
  h.$group.applyPlan(plan, [a.entry()]);
  const empty = h.$group.plan([]);
  h.$group.applyPlan(empty, []);
  h.flush();
  assertEquals(empty.entries, []);
  assertEquals(a.writes, 0);
});

test("subset residents reject moved parents and mismatched binding identity", (h) => {
  const a = h.cell("a", 1, 3);
  const plan = h.$group.plan([a.info]);
  h.$group.applyPlan(plan, [a.entry()]);
  a.$parent = null;
  h.flush();
  assertEquals(a.writes, 0);
  a.$parent = h.$group;
  const oldEntry = a.entry();
  a.bind("a", 1, 3);
  h.$group.applyPlan(plan, [oldEntry]);
  h.flush();
  assertEquals(a.writes, 0);
});


test("pure planner rejects ambiguous keys without changing descriptor order", (h) => {
  const infos = [Cell.info("b", 2, 4), Cell.info("a", 1, 3)];
  const plan = Group.Plan.generate(infos);
  assertEquals(infos.map((info) => info.id), ["b", "a"]);
  assertEquals(plan.entries.map((entry) => entry.id), ["a", "b"]);
  assertEquals(plan.byId.size, 2);
  assertEquals(plan.byId.has("a"), true);
  assertThrows(() => Group.Plan.generate([infos[0], infos[0]]), Error, "Duplicate");
  assertEquals(Object.isFrozen(plan), true);
  assertEquals(Object.isFrozen(plan.byId), true);
  assertEquals(Object.isFrozen(plan.geometry[0]), true);
  assertEquals(Object.isFrozen(plan.entries[0].style), true);
  assertEquals(h.computes, 1);
});


test("latest resident selection cancels old subset writes without changing plan lanes", (h) => {
  const a = h.cell("a", 1, 3), b = h.cell("b", 2, 4);
  const plan = h.$group.plan([a.info, b.info]);
  h.$group.applyPlan(plan, [a.entry()]);
  h.$group.applyPlan(plan, [b.entry()]);
  h.flush();
  assertEquals([a.writes, b.writes], [0, 1]);
  assertEquals(b.styles.get("z-index"), "1");
  assertEquals(h.computes, 1);
  assertThrows(() => h.$group.applyPlan(plan, [b.entry(), b.entry()]), Error, "Duplicate");
});


test("explicit residents preserve stable wrapper parent compatibility", (h) => {
  const a = h.cell("a", 1, 3);
  const $wrapper: HTMLElement = Object.create(HTMLElement.prototype);
  a.$parent = $wrapper;
  const plan = h.$group.plan([a.info]);
  h.$group.applyPlan(plan, [a.entry()]);
  h.flush();
  assertEquals(a.writes, 1);
  h.layout([a]);
  assertEquals(h.queue.length, 0);
});


test("a rejected replacement plan preserves queued positioning and reveal", (h) => {
  const a = h.cell("a", 1, 3);
  a.attributes.add("pending-layout");
  const valid = h.$group.plan([a.info]);
  h.$group.applyPlan(valid, [a.entry()]);
  assertThrows(() => h.$group.plan([a.info, a.info]), Error, "Duplicate");
  h.flush();
  assertEquals(a.writes, 1);
  assertEquals(a.attributes.has("pending-layout"), false);
});

test("identical semantic descriptors reuse the immutable complete plan", (h) => {
  const infos = [Cell.info("a", 1, 3), Cell.info("b", 2, 4)];
  const first = h.$group.plan(infos);
  const same = h.$group.plan([Cell.info("b", 2, 4), Cell.info("a", 1, 3)]);
  assertStrictEquals(same, first);
  assertStrictEquals(Group.Plan.generate(infos, first), first);
  const a = h.cell("a", 1, 3), b = h.cell("b", 2, 4);
  const cells = [b.entry(), a.entry()];
  h.$group.layout(cells);
  assertEquals(cells.map((cell) => cell.info.id), ["a", "b"]);
  assertStrictEquals(h.$group.plan(infos), first);
  const shifted = h.$group.plan([Cell.info("a", 2, 4), Cell.info("b", 3, 5)]);
  assertNotStrictEquals(shifted, first);
  assertStrictEquals(shifted.entries[0].style, first.entries[0].style);
  const renamed = h.$group.plan([Cell.info("c", 2, 4), Cell.info("d", 3, 5)]);
  assertNotStrictEquals(renamed, shifted);
  assertStrictEquals(renamed.entries[0].layout, shifted.entries[0].layout);
  assertEquals(renamed.entries.map((entry) => entry.id), ["c", "d"]);
  assertEquals(h.computes, 1);
});

test("empty selection with the same current plan cancels pending subset writes", (h) => {
  const a = h.cell("a", 1, 3);
  a.attributes.add("pending-layout");
  const plan = h.$group.plan([a.info]);
  h.$group.applyPlan(plan, [a.entry()]);
  h.$group.applyPlan(plan, []);
  h.flush();
  assertEquals(a.writes, 0);
  assertEquals(a.attributes.has("pending-layout"), true);
});

test("pure plans cannot apply until this group owns a current plan", (h) => {
  const a = h.cell("a", 1, 3);
  const external = Group.Plan.generate([a.info]);
  h.$group.applyPlan(external, [a.entry()]);
  assertEquals(h.queue.length, 0);
  const current = h.$group.plan([a.info]);
  h.$group.applyPlan(external, [a.entry()]);
  assertEquals(h.queue.length, 0);
  h.$group.applyPlan(current, [a.entry()]);
  h.flush();
  assertEquals(a.writes, 1);
});


test("legacy ordered adapters perform one metadata sort before the core solver", (h) => {
  const a = h.cell("a", 1, 3), b = h.cell("b", 2, 4);
  let comparisons = 0;
  for (const cell of [a, b]) {
    const compare = cell.info.compare.bind(cell.info);
    cell.info.compare = (other) => {
      comparisons++;
      return compare(other);
    };
  }
  [b.info, a.info].sort((left, right) => left.compare(right));
  const oneSortComparisons = comparisons;
  comparisons = 0;
  Group.Layout.generate([b.entry(), a.entry()]);
  assertEquals(comparisons, oneSortComparisons);
  comparisons = 0;
  h.layout([b, a]);
  assertEquals(comparisons, oneSortComparisons);
});


test("successful cached planning still supersedes an earlier queued application", (h) => {
  const a = h.cell("a", 1, 3);
  a.attributes.add("pending-layout");
  const first = h.$group.plan([a.info]);
  h.$group.applyPlan(first, [a.entry()]);
  const same = h.$group.plan([Cell.info("a", 1, 3)]);
  assertStrictEquals(same, first);
  h.flush();
  assertEquals(a.writes, 0);
  assertEquals(a.attributes.has("pending-layout"), true);
  h.$group.applyPlan(same, [a.entry()]);
  h.flush();
  assertEquals(a.writes, 1);
  assertEquals(a.attributes.has("pending-layout"), false);
});

function withFlushEnd(h: Harness, run: (flush: () => void) => void): void {
  const mutateEnd = $$.mutateEnd;
  const ends: (() => void)[] = [];
  $$.mutateEnd = (fn) => {
    ends.push(fn);
    return fn;
  };
  try {
    run(() => {
      h.flush();
      while (ends.length) ends.shift()?.();
    });
  } finally {
    $$.mutateEnd = mutateEnd;
  }
}

test("a pooled cell laid out in the same flush never writes [pending-layout]", (h) => {
  withFlushEnd(h, (flush) => {
    const a = h.cell("a", 1, 3);
    Group.markPendingLayout(a.$e);
    h.layout([a]);
    flush();
    assertEquals(a.attributes.has("pending-layout"), false);
    assertEquals(a.toggles, 0);
    assertEquals(a.writes, 1);
  });
});

test("a pooled cell whose layout does not land in the flush is hidden at its end", (h) => {
  withFlushEnd(h, (flush) => {
    const a = h.cell("a", 1, 3);
    h.layout([a]);
    flush();
    Group.markPendingLayout(a.$e);
    flush();
    assertEquals(a.attributes.has("pending-layout"), true);
    h.layout([a]);
    flush();
    assertEquals(a.attributes.has("pending-layout"), false);
    assertEquals(a.writes, 2);
  });
});
