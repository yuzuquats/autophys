import { assertEquals, assertStrictEquals } from "jsr:@std/assert";

import { Lazy } from "../../lazy.ts";

Deno.test("Lazy.get shares one in-flight initializer", async () => {
  let initCount = 0;
  let resolveValue: (value: string) => void = () => {};
  const ready = new Promise<string>((resolve) => {
    resolveValue = resolve;
  });
  const lazy = new Lazy(async () => {
    initCount++;
    return await ready;
  });

  const first = lazy.get();
  const second = lazy.get();
  const third = lazy.get();

  assertEquals(initCount, 1);
  resolveValue("loaded");
  assertEquals(await Promise.all([first, second, third]), [
    "loaded",
    "loaded",
    "loaded",
  ]);
  assertEquals(initCount, 1);
  assertStrictEquals(await lazy.get(), "loaded");
  assertEquals(initCount, 1);
});

Deno.test("Lazy.maybeGet exposes the resolved value only after get completes", async () => {
  const value = { ok: true };
  const lazy = new Lazy(async () => value);

  assertEquals(lazy.maybeGet(), null);
  assertStrictEquals(await lazy.get(), value);
  assertStrictEquals(lazy.maybeGet(), value);
});
