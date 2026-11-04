import { Typeahead } from "./typeahead";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
function key($input: HTMLElement, name: string): void {
  $input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, composed: true, cancelable: true }));
}
function response(): { promise: Promise<Typeahead.Item[]>; resolve: (items: Typeahead.Item[]) => void } {
  let resolve: Option<(items: Typeahead.Item[]) => void>;
  const promise = new Promise<Typeahead.Item[]>((done) => { resolve = done; });
  return { promise, resolve: (items) => {
    if (resolve == null) throw new Error("Response is not initialized");
    resolve(items);
  } };
}
const item = (id: string): Typeahead.Item => ({ id, label: id, $row: null });
function props(suggest: Typeahead.Props["suggest"]): Typeahead.Props {
  return { value: "query", placeholder: null, suggest, onSelect: () => {}, onInput: () => {}, debounceMs: 0, allowFreeText: false, label: "Suggestions" };
}
function $inputOf($field: Typeahead): HTMLInputElement {
  const $input = $field.shadowRoot?.querySelector("input");
  if (!($input instanceof HTMLInputElement)) throw new Error("Typeahead input is missing");
  return $input;
}

/** Exercises the public binding and consumer-visible popup state. */
export async function verifyTypeahead(): Promise<string[]> {
  const passed: string[] = [];
  const $fields: Typeahead[] = [];
  const $mount = (p: Typeahead.Props): Typeahead => {
    const $field = Typeahead.makeWith(p);
    $fields.push($field);
    document.body.appendChild($field);
    $inputOf($field).focus();
    return $field;
  };
  try {
    const selected: string[] = [];
    const $rebound = $mount({ ...props(async () => [item("old")]), onSelect: (id) => selected.push(id) });
    const $in = $inputOf($rebound);
    key($in, "ArrowDown"); await wait(20); key($in, "ArrowDown");
    check($in.getAttribute("aria-expanded") === "true", "Initial list should open");
    $rebound.bind({ ...props(async () => [item("new")]), onSelect: (id) => selected.push(id) });
    key($in, "Enter");
    check(selected.length === 0 && $in.getAttribute("aria-expanded") === "false", "Rebind must discard the old selection");
    check(!$in.hasAttribute("aria-activedescendant"), "Rebind must clear the active option");
    key($in, "ArrowDown"); await wait(20); key($in, "ArrowDown"); key($in, "Enter");
    check(selected[0] === "new", "The new binding must remain selectable");
    passed.push("rebind discards old options and selects the new dataset");

    const pendingBind = response();
    const $binding = $mount(props(() => pendingBind.promise));
    const $bindingInput = $inputOf($binding);
    key($bindingInput, "ArrowDown");
    $binding.bind(props(async () => [item("new binding")]));
    pendingBind.resolve([item("previous binding")]); await wait(20);
    check($bindingInput.getAttribute("aria-expanded") === "false", "Old binding response must not reopen");
    passed.push("rebind cancels an in-flight response");

    const pendingEscape = response();
    const $escape = $mount(props(() => pendingEscape.promise));
    const $escapeInput = $inputOf($escape);
    key($escapeInput, "ArrowDown"); key($escapeInput, "Escape");
    pendingEscape.resolve([item("dismissed")]); await wait(20);
    check($escapeInput.getAttribute("aria-expanded") === "false", "Escape must cancel a request before its list opens");
    passed.push("Escape cancels a request before its list appears");

    const pendingOpen = response();
    let openCalls = 0;
    const $opened = $mount(props(() => ++openCalls === 1 ? Promise.resolve([item("first")]) : pendingOpen.promise));
    const $openedInput = $inputOf($opened);
    key($openedInput, "ArrowDown"); await wait(20);
    $openedInput.value = "next";
    $openedInput.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    await wait(20); key($openedInput, "Escape");
    pendingOpen.resolve([item("late")]); await wait(20);
    check($openedInput.getAttribute("aria-expanded") === "false", "A response must not reopen after Escape");
    passed.push("Escape keeps a previously opened list dismissed");

    const pendingDetach = response();
    const $detached = $mount(props(() => pendingDetach.promise));
    const $detachedInput = $inputOf($detached);
    key($detachedInput, "ArrowDown"); $detached.remove();
    pendingDetach.resolve([item("ghost")]); await wait(20);
    check($detachedInput.getAttribute("aria-expanded") === "false", "Detached response must not create a popup");
    passed.push("disconnect cancels a pending response");

    let debounceCalls = 0;
    const $debounced = $mount({ ...props(async () => { debounceCalls++; return [item("timer")]; }), debounceMs: 50 });
    $inputOf($debounced).dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    $debounced.remove(); await wait(70);
    check(debounceCalls === 0, "Disconnect must cancel the debounce timer");
    passed.push("disconnect cancels a scheduled request");

    const stale = response(); const fresh = response();
    let queryCalls = 0;
    const $queries = $mount({ ...props(() => ++queryCalls === 1 ? stale.promise : fresh.promise), debounceMs: 50 });
    const $queryInput = $inputOf($queries);
    key($queryInput, "ArrowDown");
    $queryInput.value = "new query";
    $queryInput.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    stale.resolve([item("stale")]); await wait(20);
    check($queryInput.getAttribute("aria-expanded") === "false", "Changed input must invalidate a response during debounce");
    await wait(50); fresh.resolve([item("fresh")]); await wait(20);
    check($queryInput.getAttribute("aria-expanded") === "true", "The current query must still open");
    key($queryInput, "Escape");
    passed.push("input changes invalidate results before the next request starts");

    const pendingBlur = response();
    const $blur = $mount(props(() => pendingBlur.promise));
    const $blurInput = $inputOf($blur);
    key($blurInput, "ArrowDown"); $blurInput.blur();
    pendingBlur.resolve([item("blurred")]); await wait(20);
    check($blurInput.getAttribute("aria-expanded") === "false", "Blur must cancel pending work");
    passed.push("blur keeps late results dismissed");
  } finally {
    for (const $field of $fields) $field.remove();
  }
  return passed;
}
