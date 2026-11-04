import { Div } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { AspectRatio } from "./aspect-ratio";

function $box(ratio: number): AspectRatio {
  const $a = AspectRatio.makeWith({ ratio });
  const $fill = Div.make();
  $fill.style.background = "var(--bg-surface-light)";
  $fill.style.border = "1px dashed var(--divider)";
  $a.appendChild($fill);
  return Storybook.fill($a, "240px");
}

export class AspectRatioStoryBook extends Storybook.Default {
  title(): string {
    return "Aspect Ratio";
  }

  tags(): string[] {
    return ["std-aspect-ratio"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "16 : 9", render: () => $box(16 / 9) },
      { title: "1 : 1", render: () => $box(1) },
      { title: "3 : 4 (portrait)", render: () => $box(3 / 4) },
    ];
  }
}
