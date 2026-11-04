import { assertEquals } from "jsr:@std/assert";
import { assignInlineStyles } from "./html-element.global.ts";

/** An inline declaration that counts every mutation reaching it. */
class CountingStyle {
  readonly props = new Map<string, string>();
  writes = 0;
  constructor(readonly live: boolean) {
    // Named longhands the calendar layout writes (`style.zIndex = …`).
    for (const name of ["zIndex", "background", "border", "margin", "marginRight", "marginTop"]) {
      const property = name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
      Object.defineProperty(this, name, {
        get: () => this.props.get(property) ?? "",
        set: (value: Option<string>) => this.#set(property, value ?? ""),
      });
    }
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? "";
  }
  setProperty(name: string, value: string): void {
    this.#set(name, value);
  }
  removeProperty(name: string): void {
    this.#set(name, "");
  }
  get cssText(): string {
    return [...this.props].map(([name, value]) => `${name}: ${value};`).join(" ");
  }
  set cssText(text: string) {
    if (this.live) this.writes++;
    this.props.clear();
    for (const declaration of text.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0) this.props.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
  }
  #set(name: string, value: string): void {
    if (this.live) this.writes++;
    if (value === "") this.props.delete(name);
    else this.props.set(name, value);
  }
}

function element(initial: Record<string, string> = {}): HTMLElement & { style: CountingStyle } {
  const style = new CountingStyle(true);
  for (const [name, value] of Object.entries(initial)) style.props.set(name, value);
  const ownerDocument = { createElement: () => ({ style: new CountingStyle(false) }) };
  return { style, ownerDocument } as unknown as HTMLElement & { style: CountingStyle };
}

/** The calendar layout group's entry for a lane-0 cell (custom properties plus named longhands). */
const LAYOUT = {
  zIndex: "0",
  background: "",
  "--std-calendar-cell-end-inset": "1px",
  "--std-calendar-cell-x-offset": "3.5px",
  border: "",
  "--additional-width": "-8px",
  margin: "",
  "--std-calendar-cell-additional-height": "-2px",
} as const;

Deno.test("a layout pass that changes many properties is one inline-style write per element", () => {
  const $cell = element({ "--p-start-time-hrs": "9", border: "1px solid var(--bg)", opacity: "0" });
  assignInlineStyles($cell, LAYOUT);
  assertEquals($cell.style.writes, 1);
  // The final declaration equals the per-property result: foreign properties survive,
  // set values land, "" removes.
  assertEquals(Object.fromEntries($cell.style.props), {
    "--p-start-time-hrs": "9",
    opacity: "0",
    "z-index": "0",
    "--std-calendar-cell-end-inset": "1px",
    "--std-calendar-cell-x-offset": "3.5px",
    "--additional-width": "-8px",
    "--std-calendar-cell-additional-height": "-2px",
  });
});

Deno.test("an unchanged layout pass writes nothing and a single change stays a property write", () => {
  const $cell = element();
  assignInlineStyles($cell, LAYOUT);
  $cell.style.writes = 0;
  assignInlineStyles($cell, LAYOUT);
  assertEquals($cell.style.writes, 0);
  assignInlineStyles($cell, { ...LAYOUT, "--additional-width": "0px" });
  assertEquals($cell.style.writes, 1);
  assertEquals($cell.style.getPropertyValue("--additional-width"), "0px");
});

Deno.test("a time rebind of both cell properties is one write", () => {
  const $cell = element({ "--p-start-time-hrs": "9", "--p-duration-mins": "30" });
  assignInlineStyles($cell, { "--p-start-time-hrs": "10.5", "--p-duration-mins": "45" });
  assertEquals($cell.style.writes, 1);
  assertEquals($cell.style.cssText, "--p-start-time-hrs: 10.5; --p-duration-mins: 45;");
});
