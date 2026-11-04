import { Storybook } from "@tento-ui/ui/storybook";
import { SwatchRow } from "./swatch-row";

const THEME_GRADIENTS: SwatchRow.Swatch[] = [
  { background: "linear-gradient(135deg, var(--yellow) 25%, var(--blue) 25%, var(--green) 50%, var(--red) 50%, var(--red) 75%, var(--purple) 75%)", label: "Default" },
  { background: "linear-gradient(45deg, #f8e7dc 25%, #c7d5ba 25%, #c7d5ba 50%, #f2bab9 50%, #f2bab9 75%, #f8e7dc 75%)", label: "Grass" },
  { background: "linear-gradient(90deg, #5c8eb7 33%, #5aada5 33%, #5aada5 66%, #8789b0 66%)", label: "Solarized" },
  { background: "linear-gradient(to right, #ff85ea 33%, #85c1ff 33%, #85c1ff 66%, #a5ff85 66%)", label: "Bubblegum" },
  { background: "linear-gradient(to bottom, #a67c59 33%, #cba642 33%, #cba642 66%, #7d9158 66%)", label: "Fall" },
];

const SOLID_COLORS: SwatchRow.Swatch[] = [
  { background: "var(--red)" },
  { background: "var(--yellow)" },
  { background: "var(--green)" },
  { background: "var(--teal)" },
  { background: "var(--blue)" },
  { background: "var(--purple)" },
];

export class SwatchRowStoryBook extends Storybook.Default {
  title(): string {
    return "Swatch Row";
  }

  tags(): string[] {
    return ["std-swatch-row"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Solid colors",
        render: () => SwatchRow.makeWith({ swatches: SOLID_COLORS }),
      },
      {
        title: "Theme gradients",
        render: () => SwatchRow.makeWith({ swatches: THEME_GRADIENTS }),
      },
      {
        title: "Larger squares (CSS vars)",
        render: () =>
          SwatchRow.makeWith({ swatches: THEME_GRADIENTS }).assignStyles({
            "--swatch-size": "40px",
            "--swatch-gap": "12px",
          }),
      },
    ];
  }
}
