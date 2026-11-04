import "../toggle-button/toggle-button";

import { Storybook } from "../../ui/storybook";
import { Button } from "../button/button";
import { ToggleButton } from "../toggle-button/toggle-button";
import { Toolbar } from "./toolbar";

function $toolbar(orientation: "horizontal" | "vertical"): Toolbar {
  const $t = Toolbar.makeWith({ label: "Formatting", orientation });
  $t.appendChild(ToggleButton.makeWith({ label: "Bold", icon: null, pressed: true, onChange: () => {} }));
  $t.appendChild(ToggleButton.makeWith({ label: "Italic", icon: null, pressed: false, onChange: () => {} }));
  $t.appendChild(Button.makeWith("Clear", { type: "secondary", onClick: () => {} }));
  $t.appendChild(Button.makeWith("Apply", { type: "primary", onClick: () => {} }));
  // The bar fills its container; here it stops at its controls.
  return Storybook.fill($t, "fit-content");
}

export class ToolbarStoryBook extends Storybook.Default {
  title(): string {
    return "Toolbar";
  }

  tags(): string[] {
    return ["std-toolbar"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Horizontal", render: () => $toolbar("horizontal") },
      { title: "Vertical", render: () => $toolbar("vertical") },
    ];
  }
}
