import { Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Button } from "./button";

type Style = "primary" | "secondary" | "flat" | "destructive";

const STYLES: Array<[string, Style]> = [
  ["Save", "primary"],
  ["Duplicate", "secondary"],
  ["Cancel", "flat"],
  ["Delete", "destructive"],
];

function $row(thin: boolean): HTMLElement {
  const $row = Row.make();
  $row.assignStyles({ gap: "8px", flexWrap: "wrap", alignItems: "center" });
  for (const [label, type] of STYLES) {
    const $button = Button.makeWith(label, { type, onClick: () => {} });
    $button.toggleAttribute("thin", thin);
    $row.appendChild($button);
  }
  return $row;
}

export class ButtonStoryBook extends Storybook.Default {
  title(): string {
    return "Button";
  }

  tags(): string[] {
    return ["std-button"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Styles", render: () => $row(false) },
      { title: "Thin", render: () => $row(true) },
      {
        // Every style disables to the same fill, so one button shows it.
        title: "Disabled",
        render: () => {
          const $button = Button.makeWith("Save", { type: "primary" });
          $button.toggleAttribute("disabled", true);
          const $row = Row.make();
          $row.appendChild($button);
          return $row;
        },
      },
    ];
  }
}
