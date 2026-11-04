import { CheckmarkIcon } from "../../icon-exports";
import { Storybook } from "../../ui/storybook";
import { ToggleButton } from "./toggle-button";

export class ToggleButtonStoryBook extends Storybook.Default {
  title(): string {
    return "Toggle Button";
  }

  tags(): string[] {
    return ["std-toggle-button"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Unpressed", render: () => ToggleButton.makeWith({ label: "Bold", icon: null, pressed: false, onChange: () => {} }) },
      { title: "Pressed, with a glyph", render: () => ToggleButton.makeWith({ label: "Done", icon: CheckmarkIcon, pressed: true, onChange: () => {} }) },
    ];
  }
}
