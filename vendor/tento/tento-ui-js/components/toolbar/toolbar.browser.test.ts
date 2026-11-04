import { ToggleButton } from "../toggle-button/toggle-button";
import { Toolbar } from "./toolbar";

export async function verifyToolbar(): Promise<string[]> {
  const passed: string[] = [];
  for (const orientation of ["horizontal", "vertical"] as const) {
    const $toolbar = Toolbar.makeWith({ label: "Formatting", orientation });
    const $controls = ["One", "Two", "Three"].map((label) => ToggleButton.makeWith({ label, icon: null, pressed: false, onChange: () => {} }));
    for (const $control of $controls) $toolbar.appendChild($control);
    document.body.appendChild($toolbar);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    try {
      const $buttons = $controls.map(($control) => {
        const $button = $control.shadowRoot?.querySelector("button");
        if (!($button instanceof HTMLButtonElement)) throw new Error("Toggle button is missing");
        return $button;
      });
      $buttons[1].focus();
      $buttons[1].dispatchEvent(new KeyboardEvent("keydown", { key: orientation === "horizontal" ? "ArrowRight" : "ArrowDown", bubbles: true, composed: true, cancelable: true }));
      if ($controls[2].shadowRoot?.activeElement !== $buttons[2]) throw new Error("Arrow must advance from the focused shadow control");
      if ($buttons.map(($button) => $button.tabIndex).join(",") !== "-1,-1,0") throw new Error("The focused control must own the single tab stop");
      passed.push(`${orientation} arrows follow focus across shadow roots`);
    } finally { $toolbar.remove(); }
  }
  return passed;
}
