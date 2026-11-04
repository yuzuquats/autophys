/**
 * # The header-violation taxonomy is a published contract
 *
 * ## Invariants Tested
 * - `HeaderViolationKind.ALL` is exhaustive over the union — BOTH directions,
 *   checked at compile time, so a fifth kind cannot be added to one and not the
 *   other
 * - A `never` switch over the union pins its arity at four
 * - The four values are exactly the strings the UX specs read off the
 *   `scroll/header-violation` breadcrumb
 * - `HeaderViolationEvent` names the payload's real keys (`kind` / `indices` /
 *   `gen` / `ctx`), not a plausible-looking subset
 *
 * ## Where the table lives
 * - The four kind ROWS — each kind and the sentence the `never`-switch returns
 *   for it — are DATA, in `header-violation-kind.cases.json`. The switch
 *   itself stays here: its `never` default is the compile break a fifth kind
 *   must cause, and a JSON file cannot fail to compile. Same reason the
 *   `Covers<>` inclusions and the typed `HeaderViolationEvent` literal below
 *   stay inline — a type-level assertion has no runtime input to lift out.
 *
 * ## Notes
 * - These strings cross out of the code into ~150 tracked specs that forbid the
 *   `scroll/header-violation` label and read `kind` when one fires. Renaming a
 *   value therefore does not break a build — it silently un-forbids a spec.
 *   This test is the build break that renaming should have caused.
 * - `deno-noop.ts` first: `scroll-horizontal.ts` is a web component, so the
 *   module needs `HTMLElement`/`customElements` to exist before it evaluates.
 */
import "../../deno-noop.ts";

import { assert, assertEquals } from "jsr:@std/assert";

import { Fixtures } from "../../../tento-core-js/tests/fixture-runner.deno.ts";
import {
  HeaderViolationEvent,
  HeaderViolationKind,
} from "./scroll-horizontal.ts";

/** `true` only when `A`'s members are all `B`'s. Compile-time set inclusion. */
type Covers<A, B> = [A] extends [B] ? true : false;

/**
 * The taxonomy as the specs spell it. Written out literally rather than derived
 * from `ALL`, so this file is an independent statement of the contract: if it
 * agreed with `ALL` by construction it could not disagree with it.
 */
const AS_THE_SPECS_READ_IT = [
  "pending-layout",
  "recycled",
  "unbound",
  "zero-height",
] as const satisfies readonly HeaderViolationKind[];

type Spelled = (typeof AS_THE_SPECS_READ_IT)[number];

Deno.test("header-violation kinds: ALL is exhaustive over the union", () => {
  // Compile-time, both directions. A kind added to the union but not to `ALL`
  // makes the first `false`; a string in `ALL` that is not a kind makes the
  // second `false`. Either way this file stops compiling.
  const unionIsSpelled: Covers<HeaderViolationKind, Spelled> = true;
  const spelledIsUnion: Covers<Spelled, HeaderViolationKind> = true;
  assertEquals([unionIsSpelled, spelledIsUnion], [true, true]);

  assertEquals([...HeaderViolationKind.ALL], [...AS_THE_SPECS_READ_IT]);
});

/**
 * The `never` arm is the real assertion: a fifth kind leaves `kind` inhabited
 * there and fails to compile. This is why the switch is CODE while the
 * sentences it returns are data — a fixture cannot fail to compile.
 */
function describe(kind: HeaderViolationKind): string {
  switch (kind) {
    case "pending-layout":
      return "marked by a bind that has not landed";
    case "recycled":
      return "pulled through the pool without a rebind";
    case "unbound":
      return "rendered with no collection marker at all";
    case "zero-height":
      return "bound and unmarked, every cell measuring 0px";
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/** The kinds a case asks about, in the order it expects `ALL` to publish. */
interface Input {
  readonly kinds: readonly HeaderViolationKind[];
}

interface Expected {
  /** `HeaderViolationKind.ALL`, verbatim — pins the published order. */
  readonly all: readonly HeaderViolationKind[];
  /** `describe(kind)` per `Input.kinds`, in order. */
  readonly descriptions: readonly string[];
  /** `HeaderViolationKind.ALL.length`. */
  readonly arity: number;
}

Fixtures.load<Input, Expected>(
  new URL(".", import.meta.url).pathname,
  "header-violation-kind",
).run(
  (input) => ({
    all: [...HeaderViolationKind.ALL],
    descriptions: input.kinds.map(describe),
    arity: HeaderViolationKind.ALL.length,
  }),
  (result, expected, caseName) => assertEquals(result, expected, caseName),
);

Deno.test("header-violation kinds: no duplicates, and every value is kebab-case", () => {
  // The specs match on the literal string; a duplicate or a stray space would
  // make one kind unforbiddable without any other test noticing.
  assertEquals(new Set(HeaderViolationKind.ALL).size, 4);
  for (const kind of HeaderViolationKind.ALL) {
    assert(/^[a-z]+(-[a-z]+)*$/.test(kind), `${kind} is kebab-case`);
  }
});

Deno.test("header-violation event: the payload keys are the ones logged", () => {
  // Pinned against the shape recorded in the spec corpus:
  //   {"kind":"zero-height","ctx":"trailing","gen":3,"indices":[-32894]}
  const event: HeaderViolationEvent = {
    kind: "zero-height",
    indices: [-32894],
    gen: 3,
    ctx: "trailing",
  };

  assertEquals(Object.keys(event).sort(), ["ctx", "gen", "indices", "kind"]);
  assert(HeaderViolationKind.ALL.includes(event.kind));
});
