import "../../deno-noop.ts";

import { assertEquals, assertStrictEquals } from "jsr:@std/assert";
import { CalendarColumnCellContent } from "./calendar-column-cell-content.ts";

/** A label element holding `children`; counts `textContent` writes (each one replaces the text node). */
class Host implements CalendarColumnCellContent.TextHost {
  replaced = 0;
  constructor(public children: { nodeType: number; data?: string }[]) {}
  get firstChild() {
    return this.children[0] ?? null;
  }
  get childNodes() {
    return { length: this.children.length };
  }
  get textContent(): string {
    return this.children.map((child) => child.data ?? "").join("");
  }
  set textContent(text: string | null) {
    this.replaced++;
    this.children = text ? [{ nodeType: 3, data: text }] : [];
  }
}

Deno.test("cell content text: a rebind to another event updates the label's text node in place", () => {
  const $text = { nodeType: 3, data: "Standup" };
  const $label = new Host([$text]);
  CalendarColumnCellContent.writeText($label, "Design review");
  assertEquals($label.replaced, 0, "no node replaced: no inserted-text style invalidation");
  assertStrictEquals($label.firstChild, $text);
  assertEquals($text.data, "Design review");
});

Deno.test("cell content text: unchanged text writes nothing", () => {
  const $text = { nodeType: 3, data: "9:00 – 9:30" };
  const $label = new Host([$text]);
  CalendarColumnCellContent.writeText($label, "9:00 – 9:30");
  assertEquals([$label.replaced, $text.data], [0, "9:00 – 9:30"]);
});

Deno.test("cell content text: an empty label gets its text node once, then rebinds in place", () => {
  const $label = new Host([]);
  CalendarColumnCellContent.writeText($label, "");
  assertEquals($label.replaced, 0, "empty stays empty without a write");
  CalendarColumnCellContent.writeText($label, "Lunch");
  assertEquals($label.replaced, 1);
  const $text = $label.firstChild;
  CalendarColumnCellContent.writeText($label, "Gym");
  assertEquals($label.replaced, 1);
  assertStrictEquals($label.firstChild, $text);
  assertEquals($label.textContent, "Gym");
});

Deno.test("cell content text: a label holding anything but one text node is replaced whole", () => {
  const $label = new Host([{ nodeType: 1 }]);
  CalendarColumnCellContent.writeText($label, "Untitled");
  assertEquals([$label.replaced, $label.textContent], [1, "Untitled"]);
});
