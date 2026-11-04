import { Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { LoadingButton } from "./loading-button";

type Style = "primary" | "secondary" | "flat" | "destructive";

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeLoadingButton(
  label: string,
  style: Style,
  widthPx: number,
): LoadingButton {
  const $button = LoadingButton.make();
  $button.textContent = label;
  $button.toggleAttribute(style, true);
  // The spinner replaces the label while loading; a fixed width keeps the
  // button from collapsing to the spinner's 16px and shifting its neighbours.
  $button.style.width = `${widthPx}px`;
  $button.addLoadingClickEvent(() => wait(1200));
  return $button;
}

function $row(thin: boolean): HTMLElement {
  const $row = Row.make();
  $row.assignStyles({ gap: "8px", flexWrap: "wrap" });
  const styles: Array<[string, Style]> = [
    ["Publish", "primary"],
    ["Duplicate", "secondary"],
    ["Refresh", "flat"],
    ["Delete", "destructive"],
  ];
  for (const [label, style] of styles) {
    const $button = makeLoadingButton(label, style, 96);
    $button.toggleAttribute("thin", thin);
    $row.appendChild($button);
  }
  return $row;
}

export class CoreLoadingButtonStoryBook extends Storybook.Default {
  title(): string {
    return "Loading Button";
  }

  tags(): string[] {
    return ["std-loading-button"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Idle",
        render: () => makeLoadingButton("Save changes", "primary", 140),
      },
      {
        title: "Loading",
        render: () => {
          const $button = makeLoadingButton("Save changes", "primary", 140);
          $button.toggleLoading(true);
          return $button;
        },
      },
      { title: "Styles", render: () => $row(false) },
      { title: "Thin", render: () => $row(true) },
    ];
  }
}
