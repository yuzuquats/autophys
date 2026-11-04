import { Storybook } from "../../ui/storybook";
import { ToggleButtonGroup } from "./toggle-button";

const ITEMS = [{ id: "b", label: "Bold", icon: null }, { id: "i", label: "Italic", icon: null }, { id: "u", label: "Underline", icon: null }];

export class ToggleButtonGroupStoryBook extends Storybook.Default {
  title(): string {
    return "Toggle Button Group";
  }

  tags(): string[] {
    return ["std-toggle-button-group"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Multiple (role=group)", render: () => ToggleButtonGroup.makeWith({ items: ITEMS, values: ["b"], multiple: true, onChange: () => {}, label: "Text style" }) },
      { title: "Single (one tab stop; arrows select)", render: () => ToggleButtonGroup.makeWith({ items: [{ id: "l", label: "Left", icon: null }, { id: "c", label: "Center", icon: null }, { id: "r", label: "Right", icon: null }], values: ["l"], multiple: false, onChange: () => {}, label: "Alignment" }) },
    ];
  }
}
