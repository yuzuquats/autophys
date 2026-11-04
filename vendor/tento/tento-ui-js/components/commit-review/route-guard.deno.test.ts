import { assertEquals } from "jsr:@std/assert";

// The reroute guard, as `stack-review.ts` wires it.
//
// A handle link is an `<a href="#/…">`, so one click fires BOTH `hashchange`
// and `popstate`. Acting on both means resolving the same navigation twice —
// and the second resolve is not free: it clears the pane and refetches the
// diff. The guard is one remembered hash, and the whole subtlety is that
// `writeUrl` must update it too, because push/replaceState fire no event at
// all: without that, a Back onto the row you just left looks exactly like the
// duplicate and gets swallowed.
//
// This mirrors the component's logic rather than importing it (the component
// is DOM-bound); the pairing is what has to be pinned, and it is small enough
// to state twice and obvious enough to keep in step.

class Router {
  routedHash: string | null = null;
  hash = "";
  /** Navigations actually acted on, in order. */
  routed: string[] = [];

  /** The listener both events share. */
  reroute(): void {
    if (this.hash === this.routedHash) return;
    this.routedHash = this.hash;
    this.routed.push(this.hash);
  }

  /** A history write by the app itself — fires no event. */
  writeUrl(hash: string): void {
    if (hash === this.hash) return;
    this.hash = hash;
    this.routedHash = this.hash;
  }

  /** The browser moving the hash: a link click, or Back/Forward. */
  navigate(hash: string, events: ("hashchange" | "popstate")[]): void {
    this.hash = hash;
    for (const _ of events) this.reroute();
  }
}

Deno.test("a link click resolves once, not once per event", () => {
  const r = new Router();
  r.navigate("#/local/mono/l142", ["hashchange", "popstate"]);
  assertEquals(r.routed, ["#/local/mono/l142"]);
});

Deno.test("Back after an in-app selection is not mistaken for the duplicate", () => {
  const r = new Router();
  // Reader clicks a row: the app pushes the URL itself, no event fires.
  r.writeUrl("#/local/mono/l142");
  assertEquals(r.routed, [], "an app-initiated write resolves nothing — it already selected");
  // Reader clicks another row.
  r.writeUrl("#/local/mono/l143");
  // Back. The hash returns to a value the app wrote but never routed, and
  // this is precisely the case a naive guard swallows.
  r.navigate("#/local/mono/l142", ["popstate"]);
  assertEquals(r.routed, ["#/local/mono/l142"]);
});

Deno.test("Back and Forward keep working across repeated visits", () => {
  const r = new Router();
  r.navigate("#/local/mono/l142", ["hashchange", "popstate"]);
  r.navigate("#/local/mono/d6120", ["hashchange", "popstate"]);
  r.navigate("#/local/mono/l142", ["popstate"]); // Back
  r.navigate("#/local/mono/d6120", ["popstate"]); // Forward
  assertEquals(r.routed, [
    "#/local/mono/l142",
    "#/local/mono/d6120",
    "#/local/mono/l142",
    "#/local/mono/d6120",
  ]);
});

Deno.test("clicking the link for the row already open does nothing", () => {
  const r = new Router();
  r.writeUrl("#/local/mono/l142");
  r.navigate("#/local/mono/l142", ["hashchange", "popstate"]);
  assertEquals(r.routed, [], "no pane clear, no refetch");
});
