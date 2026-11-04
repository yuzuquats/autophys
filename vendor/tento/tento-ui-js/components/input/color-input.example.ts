import { Storybook } from "../../ui/storybook";
import { Toast } from "../toast/toast";
import { ColorField } from "./color-field";
import { ColorInput } from "./color-input";

export class ColorInputStoryBook extends Storybook.Default {
  title(): string {
    return "Color Input";
  }

  tags(): string[] {
    return ["std-color-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "With Label",
        render: () => {
          return ColorInput.makeWith({
            label: "Theme Color",
            value: "#3B82F6",
            onChange: (color) => {
              Toast.info(`Selected: ${color}`);
            },
          });
        },
      },
      {
        title: "With Label and Helper Text",
        render: () => {
          return ColorInput.makeWith({
            label: "Background Color",
            helperText: "Choose your preferred background color",
            value: "#10B981",
            onChange: (color) => {
              Toast.info(`Selected: ${color}`);
            },
          });
        },
      },
      {
        title: "Required Field",
        render: () => {
          return ColorInput.makeWith({
            label: "Brand Color",
            required: true,
            value: "#EF4444",
            onChange: (color) => {
              Toast.info(`Selected: ${color}`);
            },
          });
        },
      },
      {
        title: "Field Only (No Layout)",
        render: () => {
          return ColorField.makeWith({
            value: "#8B5CF6",
            onChange: (color) => {
              Toast.info(`Selected: ${color}`);
            },
          });
        },
      },
    ];
  }
}
