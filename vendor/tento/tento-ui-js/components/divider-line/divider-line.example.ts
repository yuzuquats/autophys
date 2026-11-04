import { Storybook } from "../../ui/storybook";
import { DividerLine } from "./divider-line";

function $vertical(label: Option<string>): DividerLine {
  const $d = DividerLine.makeWith({ orientation: "vertical", label, inset: null });
  $d.style.height = "80px";
  return $d;
}

export class DividerLineStoryBook extends Storybook.Default {
  title(): string {
    return "Divider";
  }

  tags(): string[] {
    return ["std-divider"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Horizontal",
        render: () => Storybook.fill(DividerLine.makeWith({ orientation: "horizontal", label: null, inset: null }), "320px"),
      },
      {
        title: "Labelled",
        render: () => Storybook.fill(DividerLine.makeWith({ orientation: "horizontal", label: "or", inset: null }), "320px"),
      },
      {
        title: "Inset from the start",
        render: () => Storybook.fill(DividerLine.makeWith({ orientation: "horizontal", label: null, inset: "start" }), "320px"),
      },
      {
        title: "Inset both ends, labelled",
        render: () => Storybook.fill(DividerLine.makeWith({ orientation: "horizontal", label: "Yesterday", inset: "both" }), "320px"),
      },
      { title: "Vertical", render: () => $vertical(null) },
      { title: "Vertical, labelled", render: () => $vertical("vs") },
    ];
  }
}
