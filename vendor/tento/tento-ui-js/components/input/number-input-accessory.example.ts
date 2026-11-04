import "./number-input-accessory";

import { Storybook } from "@tento-ui/ui/storybook";
import { NumberInputAccessory } from "./number-input-accessory";

export class NumberInputAccessoryStoryBook extends Storybook.Default {
  title(): string {
    return "Number Input Accessory";
  }

  tags(): string[] {
    return ["std-number-input-accessory"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default (with value)",
        render: () => {
          return NumberInputAccessory.makeWith({
            value: 42,
            onEditingFinished: (n) => console.log("Finished editing:", n),
          });
        },
      },
      {
        title: "Empty (with placeholder)",
        render: () => {
          return NumberInputAccessory.makeWith({
            value: null,
            placeholder: "0",
            onEditingFinished: (n) => console.log("Finished editing:", n),
          });
        },
      },
      {
        title: "Currency format",
        render: () => {
          return NumberInputAccessory.makeWith({
            value: 99.99,
            format: "currency",
            onEditingFinished: (n) => console.log("Finished editing:", n),
          });
        },
      },
      {
        title: "Percentage format",
        render: () => {
          return NumberInputAccessory.makeWith({
            value: 0.75,
            format: "percentage",
            onEditingFinished: (n) => console.log("Finished editing:", n),
          });
        },
      },
    ];
  }
}
