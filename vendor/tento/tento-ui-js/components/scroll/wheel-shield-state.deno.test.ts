import { assert, assertEquals } from "jsr:@std/assert";

/**
 * The wheel shield's style state lives on the shield element, never on the
 * scroll host. A rule keyed on a host attribute, e.g.
 * `:host([wheel-scrolling]) #wheel-shield`, compiles to a tree-boundary-
 * crossing invalidation set: toggling the attribute makes Blink's style
 * invalidator walk the host's whole subtree (shadow trees included) to find
 * the shield — measured ~4.9 ms, forced in the first frame of every wheel
 * gesture and again at settle. With the state on the shield the toggle
 * invalidates one element. The host still carries `wheel-scrolling` as an
 * observable marker (ux specs read it), so no style rule may select on it.
 *
 * This reads the component source: the stylesheet and the wheel-activity
 * callback are inert under deno, and the property under test is which
 * selector the stylesheet uses.
 */
const source = await Deno.readTextFile(new URL("./scroll-horizontal.ts", import.meta.url));

Deno.test("no style rule selects on the host's wheel-scrolling attribute", () => {
  assertEquals(source.match(/\[wheel-scrolling\][^\n{]*\{/g), null);
});

Deno.test("the shield shows through its own active state", () => {
  assert(/#wheel-shield\[active\]\s*\{\s*display:\s*block;/.test(source));
});

Deno.test("wheel activity toggles the shield's state with the host marker", () => {
  const callback = source.match(/onWheelActivity: \(active\) => \{[\s\S]*?\n    \},/)?.[0] ?? "";
  assert(callback.includes(`this.$("wheel-shield").toggleAttribute("active", active)`), callback);
  assert(callback.includes(`this.toggleAttribute("wheel-scrolling", active)`), callback);
});
