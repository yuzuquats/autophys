/**
 * A rejected fetch must not count as coverage: it leaves the in-flight set AND
 * withdraws the optimistic coverage `createFetchEntry` recorded, so the next
 * same-range call is a real request. Only touching successful windows merge;
 * disjoint coverage is conservatively forgotten rather than bridging a hole.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { DateTime, DateUnit, NaiveDate, Utc } from "@tento-chrono";
import { RangeBasedFetcher } from "../../range-based-fetcher.ts";

function day(iso: string): NaiveDate {
  const [y, m, d] = iso.split("-").map(Number);
  return NaiveDate.fromYmd1Exp(y!, m!, d!);
}
function span(startIso: string, endIso: string): DateTime.Range<Utc> {
  return new DateTime.Range(DateTime.fromDse(day(startIso).dse, Utc), DateTime.fromDse(day(endIso).dse, Utc));
}

Deno.test("RangeBasedFetcher — a rejected fetch is retried by the next same-range call", async () => {
  let calls = 0;
  const fetcher = new RangeBasedFetcher<Utc>((_range) => {
    calls++;
    return calls === 1 ? Promise.reject(new Error("network")) : Promise.resolve();
  });
  await assertRejects(() => fetcher.fetchRange(span("2026-04-01", "2026-04-08")), Error, "network");
  assertEquals(fetcher.hasOngoingFetches, false);
  assertEquals(fetcher.fetchedRange == null, true, "the failed range is not coverage");
  await fetcher.fetchRange(span("2026-04-01", "2026-04-08"));
  assertEquals(calls, 2, "a real second request");
  assertEquals(fetcher.fetchedRange != null, true);
});

Deno.test("RangeBasedFetcher — a rejection alongside a concurrent success leaves nothing falsely covered", async () => {
  let calls = 0;
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const fetcher = new RangeBasedFetcher<Utc>((_range) => {
    calls++;
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  });
  const a = fetcher.fetchRange(span("2026-01-01", "2026-01-08"));
  const b = fetcher.fetchRange(span("2026-06-01", "2026-06-08"));
  // Observe both outcomes up front so neither rejection is ever unhandled.
  const aOutcome = a.then(() => "ok", (e: Error) => e.message);
  const bOutcome = b.then(() => "ok", (e: Error) => e.message);
  assertEquals(calls, 2);
  pending[0]!.reject(new Error("a failed"));
  assertEquals(await aOutcome, "a failed");
  pending[1]!.resolve();
  assertEquals(await bOutcome, "ok");
  assertEquals(fetcher.hasOngoingFetches, false);
  // A's range is not covered; B's delivered range is remembered.
  await fetcher.fetchRange(span("2026-06-01", "2026-06-08"));
  assertEquals(calls, 2, "B is a cache hit");
  const again = fetcher.fetchRange(span("2026-01-01", "2026-01-08"));
  assertEquals(calls, 3, "A is fetched again");
  pending[2]!.resolve();
  await again;
});

function twoInFlight() {
  let calls = 0;
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const fetcher = new RangeBasedFetcher<Utc>((_range) => {
    calls++;
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  });
  const a = fetcher.fetchRange(span("2026-01-01", "2026-01-08"));
  const b = fetcher.fetchRange(span("2026-06-01", "2026-06-08"));
  const aOutcome = a.then(() => "ok", (e: Error) => e.message);
  const bOutcome = b.then(() => "ok", (e: Error) => e.message);
  return { fetcher, pending, calls: () => calls, aOutcome, bOutcome };
}

for (const order of ["A then B", "B then A"] as const) {
  Deno.test(`RangeBasedFetcher — two concurrent failures (${order}) leave neither range covered`, async () => {
    const t = twoInFlight();
    assertEquals(t.calls(), 2);
    const [first, second] = order === "A then B" ? [0, 1] : [1, 0];
    t.pending[first]!.reject(new Error("fail-" + first));
    await (first === 0 ? t.aOutcome : t.bOutcome);
    t.pending[second]!.reject(new Error("fail-" + second));
    await (second === 0 ? t.aOutcome : t.bOutcome);
    assertEquals(t.fetcher.hasOngoingFetches, false);
    assertEquals(t.fetcher.fetchedRange == null, true, "no request delivered, so nothing is covered");
    const a2 = t.fetcher.fetchRange(span("2026-01-01", "2026-01-08"));
    assertEquals(t.calls(), 3, "A is requested again");
    t.pending[2]!.resolve();
    await a2;
    const b2 = t.fetcher.fetchRange(span("2026-06-01", "2026-06-08"));
    assertEquals(t.calls(), 4, "B is requested again");
    t.pending[3]!.resolve();
    await b2;
  });
}

for (const order of ["B succeeds then A rejects", "A rejects then B succeeds"] as const) {
  Deno.test(`RangeBasedFetcher — an invalidation during flight stands (${order})`, async () => {
    const t = twoInFlight();
    t.fetcher.fetchedRange = null; // the sheet invalidated its cache while both were in flight
    if (order === "B succeeds then A rejects") {
      t.pending[1]!.resolve();
      await t.bOutcome;
      t.pending[0]!.reject(new Error("a failed"));
      await t.aOutcome;
    } else {
      t.pending[0]!.reject(new Error("a failed"));
      await t.aOutcome;
      t.pending[1]!.resolve();
      await t.bOutcome;
    }
    assertEquals(t.fetcher.hasOngoingFetches, false);
    assertEquals(t.fetcher.fetchedRange == null, true, "the invalidation stands");
    const b2 = t.fetcher.fetchRange(span("2026-06-01", "2026-06-08"));
    assertEquals(t.calls(), 3, "B is fetched again after the invalidation");
    t.pending[2]!.resolve();
    await b2;
  });
}

Deno.test("RangeBasedFetcher — a request started after an invalidation does not re-authorize an older one", async () => {
  const t = twoInFlight();
  t.fetcher.fetchedRange = null;
  const c = t.fetcher.fetchRange(span("2026-09-01", "2026-09-08")); // new epoch
  assertEquals(t.calls(), 3);
  t.pending[0]!.resolve(); // old A delivers: it may not commit
  await t.aOutcome;
  t.pending[1]!.reject(new Error("b failed")); // old B rejects: it may not re-claim
  await t.bOutcome;
  t.pending[2]!.resolve();
  await c;
  assertEquals(t.fetcher.hasOngoingFetches, false);
  // C is covered, A is not.
  await t.fetcher.fetchRange(span("2026-09-01", "2026-09-08"));
  assertEquals(t.calls(), 3, "C is a cache hit");
  const a2 = t.fetcher.fetchRange(span("2026-01-01", "2026-01-08"));
  assertEquals(t.calls(), 4, "A is requested again");
  t.pending[3]!.resolve();
  await a2;
});

Deno.test("RangeBasedFetcher — assigning a real range is authoritative for what started before it", async () => {
  const t = twoInFlight();
  t.fetcher.fetchedRange = span("2026-03-01", "2026-03-08"); // installed elsewhere: this is the coverage now
  t.pending[0]!.resolve();
  await t.aOutcome;
  t.pending[1]!.resolve();
  await t.bOutcome;
  assertEquals(t.fetcher.hasOngoingFetches, false);
  await t.fetcher.fetchRange(span("2026-03-02", "2026-03-04"));
  assertEquals(t.calls(), 2, "the assigned range is covered");
  const a2 = t.fetcher.fetchRange(span("2026-01-01", "2026-01-08"));
  assertEquals(t.calls(), 3, "the older delivery did not commit on top of the assignment");
  t.pending[2]!.resolve();
  await a2;
});

Deno.test("RangeBasedFetcher — the cold fetch(date) path shares the lifecycle", async () => {
  let calls = 0;
  const fetcher = new RangeBasedFetcher<Utc>((_range) => {
    calls++;
    return calls === 1 ? Promise.reject(new Error("cold")) : Promise.resolve();
  });
  const at = DateTime.fromDse(day("2026-03-15").dse, Utc);
  await assertRejects(() => fetcher.fetch(at), Error, "cold");
  assertEquals(fetcher.hasOngoingFetches, false);
  assertEquals(fetcher.fetchedRange == null, true);
  await fetcher.fetch(at);
  assertEquals(calls, 2);
});

for (const order of ["A then B", "B then A"] as const) {
  Deno.test(`RangeBasedFetcher — invalidation, a new extending request, all successes (${order}): the old range is not covered`, async () => {
    let calls = 0;
    const pending: { resolve: () => void }[] = [];
    const fetcher = new RangeBasedFetcher<Utc>((_range) => {
      calls++;
      return new Promise<void>((resolve) => pending.push({ resolve }));
    });
    const a = fetcher.fetchRange(span("2026-01-01", "2026-01-08")); // old epoch
    fetcher.fetchedRange = null;
    const b = fetcher.fetchRange(span("2026-02-10", "2026-02-17")); // new epoch, extends from A's window
    assertEquals(calls, 2);
    const [first, second] = order === "A then B" ? [0, 1] : [1, 0];
    pending[first]!.resolve();
    await (first === 0 ? a : b);
    pending[second]!.resolve();
    await (second === 0 ? a : b);
    assertEquals(fetcher.hasOngoingFetches, false);
    await fetcher.fetchRange(span("2026-02-10", "2026-02-17"));
    assertEquals(calls, 2, "the new range stays cached");
    const a2 = fetcher.fetchRange(span("2026-01-01", "2026-01-08"));
    assertEquals(calls, 3, "the old range is requested again");
    pending[2]!.resolve();
    await a2;
  });
}

Deno.test("RangeBasedFetcher — a real-range assignment followed by a new extending request keeps only valid coverage", async () => {
  let calls = 0;
  const pending: { resolve: () => void }[] = [];
  const fetcher = new RangeBasedFetcher<Utc>((_range) => {
    calls++;
    return new Promise<void>((resolve) => pending.push({ resolve }));
  });
  const a = fetcher.fetchRange(span("2026-01-01", "2026-01-08")); // old epoch
  fetcher.fetchedRange = span("2026-05-01", "2026-05-08"); // installed elsewhere
  const b = fetcher.fetchRange(span("2026-05-10", "2026-05-17")); // new epoch, extends the assignment
  assertEquals(calls, 2);
  pending[0]!.resolve();
  await a;
  pending[1]!.resolve();
  await b;
  assertEquals(fetcher.hasOngoingFetches, false);
  await fetcher.fetchRange(span("2026-05-02", "2026-05-16"));
  assertEquals(calls, 2, "the assignment and the new request are covered");
  const a2 = fetcher.fetchRange(span("2026-01-01", "2026-01-08"));
  assertEquals(calls, 3, "the old delivery is not");
  pending[2]!.resolve();
  await a2;
});

/** A fetcher whose backend promises the test settles by hand, with a request log. */
function manual() {
  const requested: string[] = [];
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const fetcher = new RangeBasedFetcher<Utc>((range) => {
    requested.push(range.start.date.toString() + ".." + range.end.date.toString());
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  });
  return { fetcher, requested, pending };
}

Deno.test("RangeBasedFetcher — noteInstalled never commits a pending fetch that later rejects", async () => {
  const t = manual();
  const request = t.fetcher.fetchRange(span("2026-01-01", "2026-01-11"), DateUnit.days(0));
  const outcome = request.then(() => "ok", (error: Error) => error.message);
  t.fetcher.noteInstalled(span("2026-01-05", "2026-01-06"));
  t.pending[0]!.reject(new Error("offline"));
  assertEquals(await outcome, "offline");
  assertEquals(t.fetcher.fetchedRange?.start.mse, span("2026-01-05", "2026-01-06").start.mse);
  assertEquals(t.fetcher.fetchedRange?.end.mse, span("2026-01-05", "2026-01-06").end.mse);
  const retry = t.fetcher.fetchRange(span("2026-01-08", "2026-01-10"), DateUnit.days(0));
  assertEquals(t.requested.length, 2);
  t.pending[1]!.resolve();
  await retry;
});

Deno.test("RangeBasedFetcher — equal-valued install bounds are a no-op and do not retire pending work", async () => {
  const t = manual();
  t.fetcher.noteInstalled(span("2026-01-01", "2026-01-05"));
  const before = t.fetcher.fetchedRange;
  assertEquals(t.fetcher.noteInstalled(span("2026-01-02", "2026-01-05")), false);
  assertEquals(t.fetcher.fetchedRange === before, true);
  const request = t.fetcher.fetchRange(span("2026-01-05", "2026-01-11"), DateUnit.days(0));
  t.fetcher.noteInstalled(span("2026-01-10", "2026-01-11"));
  t.pending[0]!.resolve();
  await request;
  await t.fetcher.fetchRange(span("2026-01-06", "2026-01-10"), DateUnit.days(0));
  assertEquals(t.requested.length, 1, "the pending range completed in its original epoch");
});

Deno.test("RangeBasedFetcher — synchronous assignment inside a fetch supersedes that entry", async () => {
  const installed = span("2026-06-01", "2026-06-08");
  const fetcher = new RangeBasedFetcher<Utc>(() => {
    fetcher.fetchedRange = installed;
    return Promise.resolve();
  });
  assertEquals(await fetcher.fetchRange(span("2026-01-01", "2026-01-08")), null);
  assertEquals(fetcher.fetchedRange, installed);
  assertEquals(fetcher.hasOngoingFetches, false);
});

Deno.test("RangeBasedFetcher — reentrant same-range demand sees the registered entry", async () => {
  let calls = 0;
  let finish: () => void = () => {};
  let nested: Option<Promise<Option<DateTime.Range<Utc>>>> = null;
  const range = span("2026-01-01", "2026-01-08");
  const fetcher = new RangeBasedFetcher<Utc>(() => {
    calls++;
    if (calls === 1) nested = fetcher.fetchRange(range, DateUnit.days(0));
    return new Promise<void>((resolve) => { finish = resolve; });
  });
  const outer = fetcher.fetchRange(range, DateUnit.days(0));
  assertEquals(calls, 1);
  finish();
  await outer;
  await nested;
  assertEquals(fetcher.hasOngoingFetches, false);
  assertEquals(fetcher.fetchedRange?.start.mse, range.start.mse);
});

Deno.test("RangeBasedFetcher — an equal zero-padding interval coalesces and remains a cache hit", async () => {
  const t = manual();
  const range = span("2026-01-01", "2026-01-08");
  const first = t.fetcher.fetchRange(range, DateUnit.days(0));
  const same = t.fetcher.fetchRange(span("2026-01-01", "2026-01-08"), DateUnit.days(0));
  assertEquals(t.requested.length, 1, "the equal upper bound is contained while pending");
  t.pending[0]!.resolve();
  await Promise.all([first, same]);
  await t.fetcher.fetchRange(span("2026-01-01", "2026-01-08"), DateUnit.days(0));
  assertEquals(t.requested.length, 1, "the equal upper bound is contained after delivery too");
});

for (const pendingSeed of [false, true]) {
  Deno.test(`RangeBasedFetcher — a point at the ${pendingSeed ? "pending" : "cached"} interval's exclusive end fetches`, async () => {
    const t = manual();
    const range = span("2026-01-01", "2026-01-08");
    const seed = t.fetcher.fetchRange(range, DateUnit.days(0));
    if (!pendingSeed) {
      t.pending[0]!.resolve();
      await seed;
    }
    const point = t.fetcher.fetch(range.end, 1);
    assertEquals(t.requested.length, 2, "point containment excludes the upper bound");
    t.pending[1]!.resolve();
    if (pendingSeed) t.pending[0]!.resolve();
    await Promise.all([seed, point]);
  });
}

Deno.test("RangeBasedFetcher — synchronous backend throws remove the registered entry", async () => {
  const fetcher = new RangeBasedFetcher<Utc>(() => { throw new Error("synchronous failure"); });
  await assertRejects(() => fetcher.fetchRange(span("2026-01-01", "2026-01-08")), Error, "synchronous failure");
  assertEquals(fetcher.hasOngoingFetches, false);
  assertEquals(fetcher.fetchedRange, null);
});

for (const entryPoint of ["range", "date"] as const) {
  Deno.test(`RangeBasedFetcher — ${entryPoint} demand after invalidation cannot reuse an obsolete wait`, async () => {
    const t = manual();
    const old = t.fetcher.fetchRange(span("2026-01-01", "2026-01-11"), DateUnit.days(0));
    t.fetcher.fetchedRange = null;
    const fresh = entryPoint === "range"
      ? t.fetcher.fetchRange(span("2026-01-03", "2026-01-05"), DateUnit.days(0))
      : t.fetcher.fetch(span("2026-01-03", "2026-01-05").start, 1);
    assertEquals(t.requested.length, 2, "a new request starts without waiting for the obsolete one");
    let settled = false;
    void fresh.then(() => { settled = true; });
    t.pending[0]!.resolve();
    assertEquals(await old, null, "the obsolete entry exposes no installable range");
    assertEquals(settled, false);
    t.pending[1]!.resolve();
    await fresh;
    assertEquals(t.fetcher.hasOngoingFetches, false);
  });
}

for (const failFirst of [false, true]) {
  Deno.test(`RangeBasedFetcher — overlapping extension waits for the preceding ${failFirst ? "failure" : "delivery"}`, async () => {
    const t = manual();
    const a = t.fetcher.fetchRange(span("2026-01-01", "2026-01-11"), DateUnit.days(0));
    const b = t.fetcher.fetchRange(span("2026-01-05", "2026-01-16"), DateUnit.days(0));
    const resultA = a.then(() => "ok", (error: Error) => error.message);
    let settled = false;
    const resultB = b.then(() => { settled = true; return "ok"; }, (error: Error) => { settled = true; return error.message; });
    t.pending[1]!.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(settled, false, "a successful tail cannot satisfy data still pending to its left");
    if (failFirst) t.pending[0]!.reject(new Error("missing left"));
    else t.pending[0]!.resolve();
    assertEquals(await resultA, failFirst ? "missing left" : "ok");
    assertEquals(await resultB, failFirst ? "missing left" : "ok");
    if (failFirst) assertEquals(t.fetcher.fetchedRange?.start.mse, span("2026-01-11", "2026-01-16").start.mse);
  });
}

Deno.test("RangeBasedFetcher — a cached demand crossing three pending pieces waits for its middle", async () => {
  const t = threeAdjacent();
  let settled = false;
  const read = t.fetcher.fetchRange(span("2026-01-05", "2026-01-25"), DateUnit.days(0)).then(() => { settled = true; });
  t.pending[0]!.resolve();
  await t.a;
  t.pending[2]!.resolve();
  await t.c;
  assertEquals(settled, false);
  t.pending[1]!.resolve();
  await t.b;
  await read;
  assertEquals(t.requested.length, 3);
});

Deno.test("RangeBasedFetcher — failed jump forgets the abandoned window and refetches on return", async () => {
  const t = manual();
  t.fetcher.noteInstalled(span("2026-01-01", "2026-01-11"));
  const jump = t.fetcher.fetchRange(span("2027-01-01", "2027-01-11"), DateUnit.days(0));
  const outcome = jump.then(() => "ok", (error: Error) => error.message);
  t.pending[0]!.reject(new Error("jump failed"));
  assertEquals(await outcome, "jump failed");
  assertEquals(t.fetcher.fetchedRange, null, "one-window ownership is not restored from an obsolete snapshot");
  const back = t.fetcher.fetchRange(span("2026-01-01", "2026-01-11"), DateUnit.days(0));
  assertEquals(t.requested.length, 2);
  t.pending[1]!.resolve();
  await back;
});

Deno.test("RangeBasedFetcher — a later invalidation wins after one concurrent request rejected", async () => {
  const t = threeAdjacent();
  t.pending[0]!.reject(new Error("first failed"));
  await t.a;
  t.fetcher.fetchedRange = null;
  t.pending[1]!.resolve();
  t.pending[2]!.resolve();
  await t.b;
  await t.c;
  assertEquals(t.fetcher.fetchedRange, null);
});

for (const order of ["old then jump", "jump then old"] as const) {
  Deno.test(`RangeBasedFetcher — a jump while an older fetch is pending never bridges the gap (${order})`, async () => {
    const { fetcher, requested, pending } = manual();
    const old = fetcher.fetchRange(span("2026-01-01", "2026-01-08"));
    const jump = fetcher.fetchRange(span("2027-01-01", "2027-01-08")); // far away: the jump branch, replace semantics
    assertEquals(requested.length, 2);
    const [first, second] = order === "old then jump" ? [0, 1] : [1, 0];
    pending[first]!.resolve();
    await (first === 0 ? old : jump);
    // Whatever has settled, the gap between the windows is not covered.
    const mid = fetcher.fetchRange(span("2026-07-01", "2026-07-03"));
    assertEquals(requested.length, 3, "a demand inside the gap is a real request while the other fetch is still pending");
    pending[2]!.resolve();
    await mid;
    pending[second]!.resolve();
    await (second === 0 ? old : jump);
    assertEquals(fetcher.hasOngoingFetches, false);
    const mid2 = fetcher.fetchRange(span("2026-09-01", "2026-09-03"));
    assertEquals(requested.length, 4, "…and after both settled");
    pending[3]!.resolve();
    await mid2;
  });
}

Deno.test("RangeBasedFetcher — consecutive jumps: an earlier replace completing later does not take ownership back", async () => {
  const { fetcher, requested, pending } = manual();
  const seed = fetcher.fetchRange(span("2025-01-01", "2025-01-08"));
  pending[0]!.resolve();
  await seed;
  const jump1 = fetcher.fetchRange(span("2026-01-01", "2026-01-08")); // replace
  const jump2 = fetcher.fetchRange(span("2027-01-01", "2027-01-08")); // replace again, while jump1 is pending
  assertEquals(requested.length, 3);
  pending[2]!.resolve();
  await jump2;
  pending[1]!.resolve(); // jump1 completes last
  await jump1;
  assertEquals(fetcher.hasOngoingFetches, false);
  await fetcher.fetchRange(span("2027-01-02", "2027-01-04"));
  assertEquals(requested.length, 3, "the newest window is covered");
  const back = fetcher.fetchRange(span("2026-01-02", "2026-01-04"));
  assertEquals(requested.length, 4, "the earlier jump's window is not");
  pending[3]!.resolve();
  await back;
});

/** Three adjacent, uncovered windows requested back to back, each padded by 0 so they are exactly adjacent. */
function threeAdjacent() {
  const { fetcher, requested, pending } = manual();
  const zero = DateUnit.days(0);
  const a = fetcher.fetchRange(span("2026-01-01", "2026-01-11"), zero);
  const b = fetcher.fetchRange(span("2026-01-11", "2026-01-21"), zero);
  const c = fetcher.fetchRange(span("2026-01-21", "2026-01-31"), zero);
  const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
  return { fetcher, requested, pending, a: outcome(a), b: outcome(b), c: outcome(c) };
}

for (const order of ["middle fails first", "middle fails last"] as const) {
  Deno.test(`RangeBasedFetcher — a failed middle request leaves a hole, never a bridge (${order})`, async () => {
    const t = threeAdjacent();
    assertEquals(t.requested.length, 3);
    const zero = DateUnit.days(0);
    if (order === "middle fails first") {
      t.pending[1]!.reject(new Error("b failed"));
      await t.b;
      // Survivors still pending: the hole is not covered.
      const hole = t.fetcher.fetchRange(span("2026-01-13", "2026-01-18"), zero);
      assertEquals(t.requested.length, 4, "a demand in the hole is a real request while A and C are pending");
      t.pending[3]!.resolve();
      await hole;
      t.pending[0]!.resolve();
      await t.a;
      t.pending[2]!.resolve();
      await t.c;
    } else {
      t.pending[0]!.resolve();
      await t.a;
      t.pending[2]!.resolve();
      await t.c;
      t.pending[1]!.reject(new Error("b failed"));
      await t.b;
    }
    assertEquals(t.fetcher.hasOngoingFetches, false);
    const before = t.requested.length;
    const hole2 = t.fetcher.fetchRange(span("2026-01-14", "2026-01-17"), zero);
    assertEquals(t.requested.length, before + 1, "a demand in the hole is a real request after everything settled");
    t.pending[before]!.resolve();
    await hole2;
  });
}

for (const order of ["jump then extension", "extension then jump"] as const) {
  Deno.test(`RangeBasedFetcher — a jump and its same-epoch extension both stay cached (${order})`, async () => {
    const { fetcher, requested, pending } = manual();
    const seed = fetcher.fetchRange(span("2025-01-01", "2025-01-08"));
    pending[0]!.resolve();
    await seed;
    const jump = fetcher.fetchRange(span("2027-01-01", "2027-01-08")); // replace: opens an epoch
    const jumpWindowEnd = "2027-02-05"; // the padded jump window ends here (+28 days)
    const ext = fetcher.fetchRange(span(jumpWindowEnd, "2027-02-12")); // adjacent extension in the same epoch
    assertEquals(requested.length, 3);
    const [first, second] = order === "jump then extension" ? [1, 2] : [2, 1];
    pending[first]!.resolve();
    await (first === 1 ? jump : ext);
    pending[second]!.resolve();
    await (second === 1 ? jump : ext);
    assertEquals(fetcher.hasOngoingFetches, false);
    await fetcher.fetchRange(span("2027-01-02", "2027-01-04"));
    await fetcher.fetchRange(span("2027-02-06", "2027-02-10"));
    assertEquals(requested.length, 3, "both intervals are cached: no redundant fetch");
  });
}
