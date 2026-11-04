import { Storybook } from "../../ui/storybook";
import { PresentationAsset } from "./presentation-asset";

function $frame(
  $asset: HTMLElement,
  size: { width: number; height: number },
): HTMLElement {
  const $frame = document.createElement("div");
  $frame.assignStyles({
    width: `${size.width}px`,
    height: `${size.height}px`,
    border: "1px solid var(--divider)",
    borderRadius: "12px",
    background: "var(--bg)",
    overflow: "hidden",
  });
  $frame.appendChild($asset);
  return $frame;
}

function $illustrationFrame(src: string): HTMLElement {
  const $frame = document.createElement("div");
  $frame.assignStyles({
    width: "120px",
    height: "120px",
    borderRadius: "20px",
    background: "color-mix(in srgb, var(--bg) 86%, var(--text-pri) 14%)",
    color: "var(--text-ter)",
  });
  $frame.appendChild(
    PresentationAsset.makeWith({
      src,
      alt: null,
      fit: null,
      decorative: true,
      registry: null,
    }),
  );
  return $frame;
}

export class PresentationAssetStoryBook extends Storybook.Default {
  title(): string {
    return "Presentation Asset";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Stars illustration",
        render: () => $illustrationFrame("illustration/stars"),
      },
      {
        title: "Checkmark illustration",
        render: () => $illustrationFrame("illustration/checkmark"),
      },
      {
        title: "Feature hero",
        render: () =>
          $frame(
            PresentationAsset.makeWith({
              src: "hero/feature/quick-add",
              alt: "Quick add",
              fit: null,
              decorative: null,
              registry: null,
            }),
            { width: 360, height: 220 },
          ),
      },
      {
        title: "Missing asset",
        render: () =>
          $frame(
            PresentationAsset.makeWith({
              src: "missing/example",
              alt: "Missing example",
              fit: null,
              decorative: null,
              registry: null,
            }),
            { width: 240, height: 120 },
          ),
      },
    ];
  }
}
