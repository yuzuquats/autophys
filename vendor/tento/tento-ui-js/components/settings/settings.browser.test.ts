import { Switch } from "../controls/switch";
import { Settings } from "./settings";
import type { SettingsRow } from "./settings-row";

// Regressions from the publication review of shared-settings-library:
// a disabled row's control must not take focus (so no key reaches it),
// a refused action must not leave an unhandled rejection, and setText /
// setDescription must survive a later `update`.
export async function verifySettingsRow(): Promise<string[]> {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const results: string[] = [];
  const focusable = ($switch: Switch): boolean => {
    const $container = $switch.shadowRoot!.querySelector<HTMLElement>("#container")!;
    $container.focus();
    const focused = $switch.shadowRoot!.activeElement === $container;
    $container.blur();
    return focused;
  };
  const $host = document.createElement("div");
  document.body.append($host);
  try {
    let selected = 0;
    const $navigation = Settings.render({ sections: [{ rows: [
      { id: "standard-cell", label: "Navigation", onClick: () => selected++ },
    ] }] });
    $host.append($navigation);
    const $navigationRow = $navigation.row("standard-cell")!;
    const $cell = $navigationRow.shadowRoot!.querySelector<HTMLElement>("std-list-cell-layout")!;
    if (!$cell) throw new Error("SettingsRow must compose the standard list cell");
    $cell.focus();
    $cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    $navigationRow.update({ description: "Still the same cell" });
    if (selected !== 1 || $navigationRow.shadowRoot!.activeElement !== $cell) {
      throw new Error("standard cell lost its activation or focus across update");
    }
    $navigationRow.update({ disabled: true });
    $cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    if (selected !== 1 || $cell.hasAttribute("tabindex") || $cell.hasAttribute("role")) {
      throw new Error("disabled standard cell remains interactive");
    }
    results.push("standard list cell owns activation and preserves focus, with disabled navigation inert");

    const $stacked = Settings.render({ sections: [{ rows: [
      { id: "balanced", label: "Short label", value: "Value", layout: "stacked" },
    ] }] });
    $host.append($stacked);
    await frame();
    const balancedShadow = $stacked.row("balanced")!.shadowRoot!
    const bounds = balancedShadow.querySelector("#cell")!.getBoundingClientRect();
    const top = balancedShadow.querySelector("#copy")!.getBoundingClientRect().top - bounds.top;
    const bottom = bounds.bottom - balancedShadow.querySelector("#value")!.getBoundingClientRect().bottom;
    if (Math.abs(top - bottom) > 1) throw new Error(`stacked cell padding is uneven: ${top} / ${bottom}`);
    results.push("short stacked content is vertically centered inside its standard cell");

    // A builder's switch, disabled later through `update`.
    let changes = 0;
    const $section = Settings.section({
      rows: [
        Settings.toggle({ id: "builder", label: "Builder", checked: false, onChange: () => void changes++ }),
        { id: "caller", label: "Caller", disabled: true, value: Switch.makeWith({ checked: false }) },
        { id: "text", label: "Text", value: "before", description: "before" },
      ],
    });
    $host.append($section);
    await frame();
    const row = (id: string) => $section.querySelector<SettingsRow>(`#${id}`)!;
    const $builder = row("builder").querySelector<Switch>("std-switch")!;
    if (!focusable($builder)) throw new Error("an enabled builder switch should take focus");
    row("builder").update({ disabled: true });
    await frame();
    if (focusable($builder)) throw new Error("update({disabled: true}) left the builder's switch focusable");
    row("builder").update({ disabled: false });
    await frame();
    if (!focusable($builder)) throw new Error("update({disabled: false}) did not restore the builder's switch");
    if (focusable(row("caller").querySelector<Switch>("std-switch")!)) {
      throw new Error("a row bound disabled left the caller's switch focusable");
    }
    results.push("disabled rows: controls leave the focus order and come back");

    // Builders created disabled come back with the row: the row owns
    // `disabled`, a builder's control only locks itself while saving.
    const enabledLater = Settings.section({
      rows: [
        Settings.toggle({ id: "t", label: "Toggle", disabled: true, checked: false, onChange: () => void changes++ }),
        Settings.choice({ id: "c", label: "Choice", disabled: true, value: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], onChange: () => {} }),
        Settings.select({ id: "s", label: "Select", disabled: true, value: "a", options: [{ value: "a", label: "A" }], onChange: () => {} }),
        Settings.action({ id: "a", label: "Action", disabled: true, action: { label: "Go", onClick: () => {} } }),
      ],
    });
    $host.append(enabledLater);
    await frame();
    const later = (id: string) => enabledLater.querySelector<SettingsRow>(`#${id}`)!;
    const $toggle = later("t").querySelector<Switch>("std-switch")!;
    if (focusable($toggle)) throw new Error("a toggle built disabled should not take focus");
    for (const id of ["t", "c", "s", "a"]) later(id).update({ disabled: false });
    await frame();
    if (!focusable($toggle)) throw new Error("update({disabled: false}) left a toggle built disabled unfocusable");
    const before = changes;
    const $container = $toggle.shadowRoot!.querySelector<HTMLElement>("#container")!;
    $container.focus();
    $container.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true }));
    await frame();
    if (changes !== before + 1) throw new Error("a toggle built disabled did not change after the row was enabled");
    const stuck = [
      later("c").querySelector("std-segmented-control")?.hasAttribute("inert") && "choice",
      later("s").querySelector("[slot=value]")?.hasAttribute("disabled") && "select",
      later("a").querySelector("std-button")?.hasAttribute("disabled") && "action",
    ].filter(Boolean);
    if (stuck.length) throw new Error(`still locked after update({disabled: false}): ${stuck.join(", ")}`);
    results.push("builders built disabled come back when the row is enabled");

    // An update that leaves the value element alone keeps it attached, and focused.
    $container.focus();
    later("t").update({ description: "Still focused" });
    await frame();
    if ($toggle.shadowRoot!.activeElement !== $container) throw new Error("update({description}) dropped the control's focus");
    results.push("update keeps an unchanged control attached and focused");

    // setText / setDescription survive an unrelated update.
    row("text").setText("after").setDescription("after");
    row("text").update({ disabled: true });
    const shadow = row("text").shadowRoot!;
    if (shadow.querySelector("#text")!.textContent !== "after" || shadow.querySelector("#description")!.textContent !== "after") {
      throw new Error("update() restored text or description replaced by setText/setDescription");
    }
    results.push("setText and setDescription survive update");

    // A refused action re-enables its button without an unhandled rejection.
    let unhandled = 0;
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled++;
      event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      const action = Settings.action({
        label: "Refused",
        action: { label: "Go", onClick: () => Promise.reject(new Error("refused")) },
      });
      const $button = action.value as HTMLElement;
      $host.append($button);
      $button.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
      $button.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true }));
      $button.click();
      await frame();
      await new Promise((resolve) => setTimeout(resolve, 50));
      if ($button.hasAttribute("disabled")) throw new Error("a refused action left its button disabled");
      if (unhandled !== 0) throw new Error(`a refused action raised ${unhandled} unhandled rejection(s)`);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
    results.push("a refused action settles without an unhandled rejection");
    void changes;
  } finally {
    $host.remove();
  }
  return results;
}


/** Initial fills must be settled before Settings reveals, while later changes
 * retain Round's normal transitions. */
export async function verifySettingsSurface(): Promise<string[]> {
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const section = Settings.section({ rows: [{ label: "Surface", value: "Ready" }] });
  const bg = section.shadowRoot!.querySelector<HTMLElement>("#bg")!;
  document.body.append(section);
  try {
    for (let i = 0; i < 3; i++) await frame();
    const initial = getComputedStyle(bg);
    if (initial.borderRadius !== "16px" || initial.backgroundColor === "rgba(0, 0, 0, 0)" || bg.getAnimations().length) {
      throw new Error("section surface is still transitioning at the initial ready frame");
    }
    for (let i = 0; i < 3; i++) await frame();
    if (bg.style.transition || getComputedStyle(bg).transitionDuration !== "0.3s") {
      throw new Error("section did not restore normal transitions after initial paint");
    }
    bg.setAttribute("bg", "rgb(12, 34, 56)");
    for (let i = 0; i < 2; i++) await frame();
    if (!bg.getAnimations().some(animation => (animation as CSSTransition).transitionProperty === "background-color")) {
      throw new Error("later section background changes should still transition");
    }
    return ["initial section fill and corners are settled at ready", "later surface changes retain their normal transition"];
  } finally {
    section.remove();
  }
}

/** A JSON row stacks a tinted code block under its label: the exact
 * pretty-printed text, user strings as text, long lines scrolling inside. */
export async function verifySettingsJson(): Promise<string[]> {
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const value = { nested: { x: 8, y: 6 }, on: true, nil: null, n: -1.25e10, markup: "<img src=x onerror=alert(1)>", long: "x".repeat(400) };
  const $body = Settings.render({ sections: [{ rows: [Settings.json({ id: "options", label: "Options", json: value })] }] });
  const $host = document.createElement("div");
  $host.style.width = "420px";
  $host.append($body);
  document.body.append($host);
  try {
    await frame();
    const $row = $body.row("options")!;
    const $code = $row.querySelector("std-settings-code") as HTMLElement & { text: string };
    if ($row.getAttribute("layout") !== "stacked" || !$code) throw new Error("JSON row is not a stacked code block");
    if ($code.text !== JSON.stringify(value, null, 2)) throw new Error("code block text is not the pretty-printed JSON");
    const $pre = $code.shadowRoot!.querySelector("pre")!;
    if ($pre.querySelector("img")) throw new Error("a JSON string was parsed as markup");
    if (getComputedStyle($pre).backgroundColor === "rgba(0, 0, 0, 0)") throw new Error("code block has no background");
    const label = $row.shadowRoot!.querySelector("#label")!.getBoundingClientRect();
    const block = $pre.getBoundingClientRect();
    if (block.top < label.bottom) throw new Error("code block is not beneath its label");
    if ($pre.scrollWidth <= $pre.clientWidth || document.documentElement.scrollWidth > document.documentElement.clientWidth) {
      throw new Error("a long line must scroll inside the block, not the page");
    }
    return ["a JSON row stacks a tinted, exact, inert code block under its label", "long JSON lines scroll inside the block"];
  } finally {
    $host.remove();
  }
}
