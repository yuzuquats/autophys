import "../../deno-noop.ts";

import { assertEquals } from "jsr:@std/assert";
import { NaiveDate } from "@tento-chrono";
import type { ProseMirrorEditor } from "@tento-ui/components/prosemirror";
import { TextPromptSubtitle } from "./text-prompt-subtitle.ts";

/**
 * `TextPromptSubtitle.bind` hands its entry (`value`) to its editor, painted
 * lazily, with the placeholder, and reports each edit through `onSubmit`. The
 * prompt is built over stand-in shadow parts: the date label and an editor
 * that records what it is bound with.
 */
function prompt(): { $prompt: TextPromptSubtitle; editorBinds: ProseMirrorEditor.Props[] } {
  const editorBinds: ProseMirrorEditor.Props[] = [];
  const parts = new Map<string, HTMLElement>([
    ["#date-label", Object.assign(Object.create(HTMLElement.prototype), { textContent: "" })],
    ["#input", Object.assign(Object.create(HTMLElement.prototype), { bind: (props: ProseMirrorEditor.Props) => editorBinds.push(props) })],
  ]);
  const inflate = Object.getOwnPropertyDescriptor(TextPromptSubtitle, "inflate");
  Object.defineProperty(TextPromptSubtitle, "inflate", {
    configurable: true,
    value: (_constructor: typeof TextPromptSubtitle, $prompt: TextPromptSubtitle) => {
      Object.defineProperty($prompt, "shadowRoot", { value: { querySelector: (selector: string) => parts.get(selector) ?? null } });
    },
  });
  try {
    return { $prompt: new TextPromptSubtitle(), editorBinds };
  } finally {
    if (inflate) Object.defineProperty(TextPromptSubtitle, "inflate", inflate);
    else Reflect.deleteProperty(TextPromptSubtitle, "inflate");
  }
}

const DAY = NaiveDate.Partial.fromDate(NaiveDate.fromYmd1Exp(2026, 10, 6));

Deno.test("text prompt subtitle: the entry is the editor's document", () => {
  const { $prompt, editorBinds } = prompt();
  $prompt.bind({ date: DAY, value: "the note", placeholder: "Add an entry" });
  assertEquals(editorBinds.map((props) => props.markdown), ["the note"]);
  assertEquals(editorBinds[0]?.placeholder, "Add an entry");
  assertEquals(editorBinds[0]?.lazy, true, "painted statically until the user reaches for it");
});

Deno.test("text prompt subtitle: no entry is an empty document, which shows the placeholder", () => {
  const { $prompt, editorBinds } = prompt();
  $prompt.bind({ date: DAY, placeholder: "Add an entry" });
  $prompt.bind({ date: DAY, value: null, placeholder: "Add an entry" });
  assertEquals(editorBinds.map((props) => props.markdown), ["", ""]);
});

Deno.test("text prompt subtitle: an edit is submitted", () => {
  const { $prompt, editorBinds } = prompt();
  const submitted: string[] = [];
  $prompt.bind({ date: DAY, value: "the note", onSubmit: (markdown) => submitted.push(markdown) });
  editorBinds[0]?.onUpdate?.("the note, edited");
  assertEquals(submitted, ["the note, edited"]);
});
