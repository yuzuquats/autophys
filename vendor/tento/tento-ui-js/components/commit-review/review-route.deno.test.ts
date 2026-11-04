import { assertEquals } from "jsr:@std/assert";

import { Route } from "./review-route.ts";

// The grammar's contract, in one file. Two halves:
//   - the canonical shape round trips and stays short;
//   - every URL ever written still parses to the same view.
// The second half is not a courtesy. There is no expiry date on a URL someone
// pasted into a commit note, so the legacy corpus below is permanent.

const REPOS = new Set(["mono", "tento", "agent-state"]);
const isRepo = (k: string) => REPOS.has(k);
const BASE: Route.Base = { pathname: "/stack/", search: "" };

/** The hash a state serializes to, which is what every assertion here is about. */
function hashOf(state: Route.State): string {
  return Route.serialize(state, BASE).slice("/stack/".length);
}

function parse(hash: string): Route.State {
  const state = Route.parse(hash, isRepo);
  if (state == null) throw new Error(`did not parse: ${hash}`);
  return state;
}

// --- the canonical shape --------------------------------------------------

Deno.test("a change is addressed by its name, and the URL is just that", () => {
  const s = parse("#/local/mono/l142");
  assertEquals(s.target, { host: "local", repo: "mono", name: { kind: "handle", half: "l", num: 142 }, raw: null });
  assertEquals(s.context, Route.emptyContext());
  assertEquals(hashOf(s), "#/local/mono/l142");
});

Deno.test("a D handle keeps its repo, because D numbers collide across repos", () => {
  // mono and tento both have a D-1000; the repo segment is what disambiguates.
  assertEquals(hashOf(parse("#/local/tento/d1234")), "#/local/tento/d1234");
  assertEquals(parse("#/local/tento/d1234").target.repo, "tento");
});

Deno.test("a tab with nothing selected has no name", () => {
  const s = parse("#/local/mono");
  assertEquals(s.target.name, null);
  assertEquals(s.target.raw, null);
  assertEquals(hashOf(s), "#/local/mono");
});

Deno.test("every param is omitted at its default, so the common URL stays short", () => {
  const s = parse("#/local/mono/l142?rail=stack&mode=flat");
  assertEquals(s.context.rail, "stack");
  assertEquals(s.context.mode, "flat");
  assertEquals(hashOf(s), "#/local/mono/l142");
});

Deno.test("a non-default context is carried, in a fixed param order", () => {
  const s = parse("#/local/mono/l142?mode=nodes&rail=inbox&page=design");
  assertEquals(hashOf(s), "#/local/mono/l142?rail=inbox&mode=nodes&page=design");
});

Deno.test("?tab= appears only when the rail and the change disagree", () => {
  // Same repo: the tab is not information, so it is not written.
  assertEquals(hashOf(parse("#/local/mono/l142?tab=mono")), "#/local/mono/l142");
  // Different repo: this is exactly what `foreign:` used to encode.
  assertEquals(hashOf(parse("#/local/tento/d900?tab=mono")), "#/local/tento/d900?tab=mono");
});

Deno.test("an unknown param is not a route state and does not survive", () => {
  assertEquals(hashOf(parse("#/local/mono/l142?rail=sideways&mode=diagonal")), "#/local/mono/l142");
  // A tab naming a repo that does not exist is ignored rather than obeyed.
  assertEquals(hashOf(parse("#/local/mono/l142?tab=nope")), "#/local/mono/l142");
});

Deno.test("the project is a context, and rides alongside a change", () => {
  const withChange = parse("#/local/tento/d900?tab=mono&project=absorb-stack");
  assertEquals(withChange.context.project, "absorb-stack");
  assertEquals(withChange.target.name, { kind: "handle", half: "d", num: 900 });
  assertEquals(hashOf(withChange), "#/local/tento/d900?tab=mono&project=absorb-stack");

  // With no change, the project pane is the surface — today's behaviour.
  const alone = parse("#/local/mono?project=absorb-stack");
  assertEquals(alone.target.name, null);
  assertEquals(hashOf(alone), "#/local/mono?project=absorb-stack");
});

Deno.test("unstaged and a queued set are names like any other", () => {
  assertEquals(hashOf(parse("#/local/mono/unstaged")), "#/local/mono/unstaged");
  assertEquals(hashOf(parse("#/local/mono/queue:set-1")), "#/local/mono/queue:set-1");
});

// --- the legacy corpus ----------------------------------------------------

Deno.test("every URL ever written still lands on the same view", () => {
  const corpus: [string, string][] = [
    // draft: and public: were two spellings of "this commit, by snapshot".
    ["#/local/mono/draft:2eee5df30", "#/local/mono/sha:2eee5df30"],
    ["#/local/mono/public:9f31c02ab", "#/local/mono/sha:9f31c02ab"],
    // the money case: the selector's repo becomes the path's, and the path's
    // becomes the tab.
    ["#/local/mono/foreign:tento:abc123", "#/local/tento/sha:abc123?tab=mono"],
    // a selection becomes a context
    ["#/local/mono/project:absorb-stack", "#/local/mono?project=absorb-stack"],
    // the page tail becomes a param
    ["#/local/mono/l142/page/design", "#/local/mono/l142?page=design"],
    // and the canonical shape is a fixed point
    ["#/local/mono/l142", "#/local/mono/l142"],
  ];
  for (const [legacy, canonical] of corpus) {
    assertEquals(hashOf(parse(legacy)), canonical, legacy);
  }
});

Deno.test("the foreign selector's two facts land in the right slots", () => {
  const s = parse("#/local/mono/foreign:tento:abc123");
  assertEquals(s.target.repo, "tento", "the change is in tento");
  assertEquals(s.context.tab, "mono", "the rail stays on mono");
  assertEquals(s.target.name, { kind: "sha", sha: "abc123" });
});

Deno.test("the legacy repo segment is optional coming in", () => {
  const s = parse("#/local/I8954615abc");
  assertEquals(s.target.repo, null);
  assertEquals(s.target.name, { kind: "cid", cid: "I8954615abc" });
});

Deno.test("a selector this grammar cannot read survives verbatim", () => {
  // Legacy unqualified selectors could carry their own slashes, and a row
  // shape added later must not be silently dropped.
  const s = parse("#/local/some/deep/selector");
  assertEquals(s.target.repo, null);
  assertEquals(s.target.name, null);
  assertEquals(s.target.raw, "some/deep/selector");
});

Deno.test("?page= wins over a legacy /page/ tail naming something else", () => {
  assertEquals(parse("#/local/mono/l142/page/old?page=new").context.page, "new");
});

Deno.test("a hash that is not the grammar is not a route", () => {
  for (const hash of ["", "#", "#change:Iabc", "#Iabc", "#/", "not-a-hash"]) {
    assertEquals(Route.parse(hash, isRepo), null, JSON.stringify(hash));
  }
});

// --- invariants -----------------------------------------------------------

const CORPUS = [
  "#/local/mono/l142",
  "#/local/mono",
  "#/local/mono/unstaged",
  "#/local/tento/d900?tab=mono",
  "#/local/mono/l142?rail=inbox&mode=nodes",
  "#/local/mono?project=absorb-stack",
  "#/local/tento/d900?tab=mono&project=absorb-stack&page=design",
  "#/local/mono/foreign:tento:abc123",
  "#/local/mono/l142/page/design",
  "#/local/some/deep/selector",
];

Deno.test("serializing is idempotent — the second write is the first", () => {
  for (const hash of CORPUS) {
    const once = hashOf(parse(hash));
    const twice = hashOf(parse(once));
    assertEquals(twice, once, hash);
  }
});

Deno.test("two equal states serialize identically", () => {
  for (const hash of CORPUS) {
    assertEquals(hashOf(parse(hash)), hashOf(parse(hash)), hash);
  }
});

Deno.test("the legacy ?repo= is dropped, and the shell's own query survives", () => {
  const s = parse("#/local/mono/l142");
  assertEquals(Route.serialize(s, { pathname: "/stack/", search: "?repo=tento" }), "/stack/#/local/mono/l142");
  assertEquals(
    Route.serialize(s, { pathname: "/stack/", search: "?host=local&repo=tento" }),
    "/stack/?host=local#/local/mono/l142",
  );
});

Deno.test("serialize is pure — it reads its base, never `location`", () => {
  assertEquals(
    Route.serialize(parse("#/local/mono/l142"), { pathname: "/other/", search: "" }),
    "/other/#/local/mono/l142",
  );
});

Deno.test("the shell tail is the same grammar, and cannot drift from the URL", () => {
  const s = parse("#/local/mono/l142?rail=inbox&page=design");
  // Fleet: qualified with the host, because `#/stack` carries none of its own.
  assertEquals(Route.tail(s, true), "local/mono/l142?rail=inbox&page=design");
  // Scoped: starts at the repo — the shell prefixes the host it framed.
  assertEquals(Route.tail(s, false), "mono/l142?rail=inbox&page=design");
  // Both are cut from the one string the address bar gets, so they cannot
  // disagree about the grammar they are each writing.
  assertEquals(hashOf(s).endsWith(Route.tail(s, false)), true);
});
