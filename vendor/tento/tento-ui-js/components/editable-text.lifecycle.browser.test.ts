import { EditableText } from "./editable-text";

export async function verifyEditableTextLifetime(): Promise<string[]> {
  const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  let old = 0, current = 0;
  const e = EditableText.makeWith("old", () => old++);
  e.controller.onEnterKey = () => old++;
  e.controller.onEditingStarted = () => old++;
  document.body.append(e); e.enableEditing(true); EditableText.recycle(e); await frame();
  const reused = EditableText.makeWith("new", () => current++);
  if (reused !== e) throw new Error("EditableText actual pool reuse not exercised");
  reused.controller.onEnterKey = () => current++;
  document.body.append(reused); const root = reused.shadowRoot!.querySelector<HTMLElement>("#root")!;
  root.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  if (old !== 0 || current !== 1 || root.hasAttribute("contenteditable") || root.textContent !== "new") {
    throw new Error(`EditableText old controller/deferred edit survived: old=${old}, current=${current}, editing=${root.hasAttribute("contenteditable")}`);
  }
  reused.enableEditing(true); await frame();
  if (reused.shadowRoot!.activeElement !== root) throw new Error("EditableText current editing focus missing");
  reused.remove(); await frame();
  document.body.append(reused); reused.bindText("reconnected"); reused.enableEditing(true); await frame();
  if (String(root.textContent) !== "reconnected" || reused.shadowRoot!.activeElement !== root) throw new Error("EditableText reconnect failed");
  EditableText.recycle(reused); await frame();
  for (const cycles of [20, 100]) {
    const f = EditableText.makeWith("connected", () => {});
    for (let i = 0; i < cycles; i++) { document.body.append(f); f.enableEditing(true); f.remove(); }
    document.body.append(f); f.enableEditing(true); await frame();
    if (f.shadowRoot!.activeElement !== f.shadowRoot!.querySelector("#root")) throw new Error(`${cycles} EditableText reconnect focus`);
    EditableText.recycle(f); await frame();
    for (let i = 0; i < cycles; i++) {
      let retired = 0, live = 0;
      const p = EditableText.makeWith("pooled", () => retired++);
      if (p !== f) throw new Error("EditableText repeated actual pool reuse missing");
      p.controller.onEnterKey = () => live++;
      document.body.append(p); p.shadowRoot!.querySelector("#root")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      if (retired !== 0 || live !== 1) throw new Error("EditableText repeated callback ownership");
      EditableText.recycle(p); await frame();
    }
  }
  return ["EditableText disposes pooled controller and pending focus; reconnect remains editable", "EditableText 20 and 100 reconnects and actual pooled replacements"];
}
