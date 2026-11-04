import { Typeahead } from "./typeahead";

export async function verifyTypeaheadLifecycle(): Promise<string[]> {
  const frame = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  const results: string[] = [];
  for (const retire of ["Escape", "rebind", "disconnect", "recycle"]) {
    const before = document.querySelectorAll("body > std-popover").length;
    const props: Typeahead.Props = { value: "", label: "Search", placeholder: null, debounceMs: 0,
      allowFreeText: false, suggest: async () => [{ id: "a", label: "A", $row: null }],
      onInput: () => {}, onSelect: () => {} };
    const f = Typeahead.makeWith(props); document.body.append(f);
    const $input = f.shadowRoot!.querySelector("input")!;
    $input.focus(); $input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
    if ($input.getAttribute("aria-expanded") !== "true") throw new Error("Resolved response did not open before retirement");
    if (retire === "Escape") $input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (retire === "rebind") f.bind({ ...props, value: "new" });
    if (retire === "disconnect") f.remove();
    if (retire === "recycle") Typeahead.recycle(f);
    await frame();
    if (document.querySelectorAll("body > std-popover").length !== before) throw new Error(`Typeahead ${retire} left a connected retired popup`);
    if (retire === "recycle") {
      const reused = Typeahead.makeWith(props);
      if (reused !== f) throw new Error("Typeahead pool reuse was not actually exercised");
      document.body.append(reused); Typeahead.recycle(reused);
    } else Typeahead.recycle(f);
    await frame(); results.push(`Typeahead resolved-response ${retire} before queued append`);
  }
  let calls = 0, selected = "";
  const f = Typeahead.makeWith({ value: "", label: "Retry", placeholder: null, debounceMs: 0,
    allowFreeText: false, suggest: async () => { if (++calls === 1) throw new Error("expected suggestion failure"); return [{ id: "retry", label: "Retry", $row: null }]; },
    onInput: () => {}, onSelect: id => selected = id });
  document.body.append(f); const input = f.shadowRoot!.querySelector("input")!; input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  await Promise.resolve(); await Promise.resolve();
  // Failed suggestions must be a closed, operable input, with no unhandled rejection.
  if (input.getAttribute("aria-expanded") !== "false") throw new Error("Rejected suggestion did not close");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); await frame();
  if (input.getAttribute("aria-expanded") !== "true" || f.shadowRoot!.activeElement !== input) throw new Error("Suggestion retry failed or passive popup took input focus");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  if (selected !== "retry" || input.value !== "Retry") throw new Error("Successful retry did not select visible value");
  Typeahead.recycle(f); await frame(); results.push("Typeahead rejection then successful passive selection");
  let choices = 0;
  const large = Typeahead.makeWith({ value: "", label: "Large", placeholder: null, debounceMs: 0,
    allowFreeText: false, suggest: async () => Array.from({ length: 100 }, (_, i) => ({ id: String(i), label: `Choice ${i}`, $row: null })),
    onInput: () => {}, onSelect: () => choices++ });
  large.style.position = "fixed"; large.style.top = `${innerHeight - 80}px`; large.style.width = "240px";
  document.body.append(large); const li = large.shadowRoot!.querySelector("input")!; li.focus();
  li.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); await frame();
  const popup = document.querySelector<HTMLElement>("body > std-popover")!;
  const row = popup.querySelector<HTMLElement>('[role="option"]')!;
  const pr = popup.getBoundingClientRect(), rr = row.getBoundingClientRect();
  if (pr.top < 0 || pr.bottom > innerHeight || rr.top < 0 || rr.bottom > innerHeight) throw new Error(`Typeahead 100-item visible placement failed: ${JSON.stringify(pr.toJSON())}`);
  row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, cancelable: true }));
  if (choices !== 1 || li.value !== "Choice 0" || popup.isConnected || li.getAttribute("aria-expanded") !== "false") throw new Error("Typeahead visible pointer selection/close failed");
  Typeahead.recycle(large); await frame(); results.push("Typeahead 100-item bounded visible placement and pointer selection/close");
  let successorSelections = 0;
  const successor = Typeahead.makeWith({ value: "", label: "Successor", placeholder: null, debounceMs: 0,
    allowFreeText: false, suggest: async () => [{ id: "new", label: "New", $row: null }],
    onInput: () => {}, onSelect: () => successorSelections++ });
  if (successor !== large) throw new Error("Typeahead stale-row actual pool reuse missing");
  document.body.append(successor); const si = successor.shadowRoot!.querySelector("input")!; si.focus();
  si.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); await frame();
  row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  if (successorSelections !== 0 || si.getAttribute("aria-expanded") !== "true") throw new Error("Retired row selected a pooled Typeahead successor");
  Typeahead.recycle(successor); await frame(); results.push("Typeahead retired row cannot notify or close a pooled successor");
  return results;
}
