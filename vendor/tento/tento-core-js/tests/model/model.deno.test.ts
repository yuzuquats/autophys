import { assert, assertEquals, assertThrows } from "jsr:@std/assert";

import {
  Field,
  Model,
  ModelHydrationError,
  Patch,
  Scalar,
} from "../../model.ts";

interface Todo {
  title: string;
  note?: Option<string>;
}

const TODO_MODEL = Model.object<Todo>({
  title: Field.required(Scalar.string),
  note: Field.optional(Scalar.string),
});

Deno.test("Model.object hydrates required and optional fields", () => {
  const hydrated = TODO_MODEL.hydrate({ title: "Ship shapes" });
  assertEquals(hydrated, { title: "Ship shapes" });
});

Deno.test("Model.object reports missing required field path", () => {
  const result = TODO_MODEL.safeHydrate({});
  assertEquals(result.isOk, false);
  if (result.isOk) return;
  assertEquals(result.issues[0]?.path, ["title"]);
  assertEquals(result.issues[0]?.code, "required");
});

Deno.test("Model.hydrate throws with issues on mismatch", () => {
  assertThrows(
    () => TODO_MODEL.hydrate({ note: "missing title" }),
    ModelHydrationError,
    "title: missing required field",
  );
});

Deno.test("Scalar.revive rejects parser null results", () => {
  const positive = Scalar.revive<number>(
    "positive",
    (raw) => typeof raw === "number" && raw > 0 ? raw : null,
    null,
  );

  assertEquals(positive.safeHydrate(2).isOk, true);
  assertEquals(positive.safeHydrate(-1).isOk, false);
});

Deno.test("Model.union accepts heterogeneous branches", () => {
  const model = Model.union<string | readonly string[]>([
    Scalar.string,
    Model.array(Scalar.string),
  ]);

  assertEquals(model.safeHydrate("one").isOk, true);
  assertEquals(model.safeHydrate(["one", "two"]).isOk, true);
  assert(!model.safeHydrate(3).isOk);
});

Deno.test("Scalar.integer accepts whole numbers only", () => {
  assertEquals(Scalar.integer.safeHydrate(3).isOk, true);
  assertEquals(Scalar.integer.safeHydrate(-2).isOk, true);
  assert(!Scalar.integer.safeHydrate(1.5).isOk);
  assert(!Scalar.integer.safeHydrate("3").isOk);
});

Deno.test("Scalar.checked validates the wire shape before converting", () => {
  // A conversion that is not a validator: it builds from whatever it gets.
  const seen: { a: number; b: number }[] = [];
  const pair = Scalar.checked<{ a: number; b: number }, { sum: number }>(
    "Pair",
    Model.object<{ a: number; b: number }>({
      a: Field.required(Scalar.integer),
      b: Field.required(Scalar.integer),
    }),
    (value) => {
      seen.push(value);
      return { sum: value.a + value.b };
    },
    null,
  );

  const good = pair.safeHydrate({ a: 1, b: 2 });
  assert(good.isOk);
  assertEquals(good.value, { sum: 3 });

  // A wrong field type is reported at its path, and never reaches the
  // conversion.
  const bad = pair.safeHydrate({ a: "1", b: 2 });
  assert(!bad.isOk);
  assertEquals(bad.issues.map((issue) => issue.path), [["a"]]);
  assertEquals(bad.issues[0]?.message, "expected integer");
  assertEquals(seen.length, 1);

  // Nested in an object, the path is prefixed.
  const outer = Model.object({ pair: Field.required(pair) });
  const nested = outer.safeHydrate({ pair: { a: 1 } });
  assert(!nested.isOk);
  assertEquals(nested.issues[0]?.path, ["pair", "b"]);
  assertThrows(() => outer.hydrate({ pair: 7 }), ModelHydrationError, "pair: expected object");
});

Deno.test("Scalar.checked still refuses what the conversion refuses", () => {
  const day = Scalar.checked<string, number>(
    "Day",
    Scalar.string,
    (raw) => /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(raw) : null,
    null,
  );
  assert(day.safeHydrate("2024-01-02").isOk);
  const wrongType = day.safeHydrate(20240102);
  assert(!wrongType.isOk);
  assertEquals(wrongType.issues[0]?.message, "expected string");
  const refused = day.safeHydrate("bogus");
  assert(!refused.isOk);
  assertEquals(refused.issues[0]?.message, "expected Day");
});

Deno.test("Scalar.checked converts the hydrated wire value and passes the raw JSON alongside", () => {
  // `parse` gets `wire`'s hydrated value (declared keys only) and the JSON
  // as received, so an open union can check its envelope and keep the rest.
  const block = Scalar.checked<{ type: string }, { type: string; extra: number }>(
    "Block",
    Model.object<{ type: string }>({ type: Field.required(Scalar.string) }),
    (envelope, raw) => {
      assertEquals(Object.keys(envelope), ["type"]);
      const rest = Model.object<{ extra: number }>({ extra: Field.required(Scalar.number) });
      return { type: envelope.type, extra: rest.hydrate(raw).extra };
    },
    null,
  );
  const decoded = block.safeHydrate({ type: "note", extra: 7 });
  assert(decoded.isOk);
  assertEquals(decoded.value, { type: "note", extra: 7 });
  assert(!block.safeHydrate({ extra: 7 }).isOk);
});

Deno.test("Scalar.checked serializes through the conversion's inverse and the wire model", () => {
  const cents = Scalar.checked<number, { cents: number }>(
    "Cents",
    Scalar.integer,
    (value) => ({ cents: value }),
    (value) => value.cents,
  );
  assertEquals(cents.serialize({ cents: 250 }), 250);
  const refusing = Scalar.checked<string, number>(
    "Throws",
    Scalar.string,
    () => {
      throw new Error("no");
    },
    null,
  );
  const refused = refusing.safeHydrate("x");
  assert(!refused.isOk);
  assertEquals(refused.issues[0]?.message, "expected Throws");
});

Deno.test("Field.patch keeps an absent key, clears on null and sets a value", () => {
  interface Edit {
    title?: Patch<string>;
  }
  const edit = Model.object<Edit>({ title: Field.patch(Scalar.string) });

  const kept = edit.safeHydrate({});
  assert(kept.isOk);
  assertEquals("title" in kept.value, false);

  const cleared = edit.safeHydrate({ title: null });
  assert(cleared.isOk);
  assert(Patch.isClear(cleared.value.title));

  const set = edit.safeHydrate({ title: "Standup" });
  assert(set.isOk);
  assertEquals(set.value.title, "Standup");

  const wrong = edit.safeHydrate({ title: 3 });
  assert(!wrong.isOk);
  assertEquals(wrong.issues[0]?.path, ["title"]);

  assertEquals(edit.serialize({ title: Patch.CLEAR }), { title: null });
  assertEquals(edit.serialize({}), {});
  assertEquals(JSON.stringify({ title: Patch.CLEAR }), '{"title":null}');
});

Deno.test("Patch.apply keeps, sets or clears the current value", () => {
  assertEquals(Patch.apply<string>(undefined, "old"), "old");
  assertEquals(Patch.apply<string>("new", "old"), "new");
  assertEquals(Patch.apply<string>(Patch.CLEAR, "old"), null);
  assertEquals(Patch.toWire<string>(Patch.CLEAR), null);
  assertEquals(Patch.fromWire<string>(null), Patch.CLEAR);
});

interface RecursiveNode {
  title: string;
  children?: Option<readonly RecursiveNode[]>;
}

Deno.test("Model.defer preserves recursive values and structured nested errors", () => {
  let resolutions = 0;
  const node: Model<RecursiveNode> = Model.object<RecursiveNode>({
    title: Field.required(Scalar.string),
    children: Field.optional(Model.array(Model.defer(() => {
      resolutions++;
      return node;
    }))),
  });
  assertEquals(resolutions, 0, "construction must not resolve the recursive model");
  for (const children of [undefined, null, [], [{ title: "Child", children: [{ title: "Leaf" }] }]]) {
    const raw = children === undefined ? { title: "Root" } : { title: "Root", children };
    const result = node.safeHydrate(raw);
    assert(result.isOk);
    assertEquals(node.serialize(result.value), raw);
    assertEquals(node.hydrate(raw), raw);
  }
  const bad = { title: "Root", children: [{ title: 42 }] };
  const result = node.safeHydrate(bad);
  assert(!result.isOk);
  assertEquals(result.issues[0].path, ["children", "0", "title"]);
  assertThrows(() => node.hydrate(bad), ModelHydrationError);
  assert(resolutions > 0);
});

Deno.test("Model.defer resolves mutually recursive forward models at operation time", () => {
  interface Left { name: string; right?: Option<Right>; }
  interface Right { count: number; left?: Option<Left>; }
  const left: Model<Left> = Model.object<Left>({
    name: Field.required(Scalar.string),
    right: Field.optional(Model.defer(() => right)),
  });
  const right: Model<Right> = Model.object<Right>({
    count: Field.required(Scalar.number),
    left: Field.optional(Model.defer(() => left)),
  });
  const raw = { name: "first", right: { count: 2, left: { name: "last" } } };
  assertEquals(left.hydrate(raw), raw);
  assertEquals(left.serialize(left.hydrate(raw)), raw);
  const refused = left.safeHydrate({ name: "first", right: { count: "bad" } });
  assert(!refused.isOk);
  assertEquals(refused.issues[0].path, ["right", "count"]);
});
