import { Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";

import { LazyImage } from "./lazy-image";

const COLUMN_WIDTH_PX = 320;

// Self-contained renditions so the examples never touch the network — the
// intrinsic width/height in the SVG are the same numbers a real capture's
// metadata would carry.
function renditionUrl(label: string, width: number, height: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="${width}" height="${height}" fill="#e8e9ff"/>
<rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#999cff"/>
<text x="16" y="${Math.round(height / 2)}" font-family="monospace" font-size="14" fill="#4a4d8c">${label}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function $column($children: HTMLElement[]): HTMLElement {
  const $root = Column.make();
  $root.assignStyles({
    width: `${COLUMN_WIDTH_PX}px`,
    maxWidth: "100%",
    padding: "16px",
    gap: "8px",
  });
  $root.append(...$children);
  return $root;
}

export class LazyImageStoryBook extends Storybook.Default {
  title(): string {
    return "LazyImage (std-lazy-image)";
  }

  tags(): string[] {
    return ["std-lazy-image"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Intrinsic size reserves the box",
        render: () =>
          $column([
            LazyImage.makeWith({
              src: renditionUrl("680 × 510", 680, 510),
              alt: "",
              width: 680,
              height: 510,
              onSettled: null,
              onError: null,
            }),
          ]),
      },
      {
        title: "Unknown dimensions",
        render: () =>
          $column([
            LazyImage.makeWith({
              src: renditionUrl("no metadata", 680, 340),
              alt: "",
              width: null,
              height: null,
              onSettled: null,
              onError: null,
            }),
          ]),
      },
      {
        title: "onSettled fires on a warm cache too",
        render: () => {
          const $readout = Typography.small("settled 0");
          let settled = 0;
          const src = renditionUrl("cached twice", 680, 260);
          const onSettled = () => {
            settled += 1;
            $readout.textContent = `settled ${settled}`;
          };
          return $column([
            LazyImage.makeWith({
              src,
              alt: "",
              width: 680,
              height: 260,
              onSettled,
              onError: null,
            }),
            LazyImage.makeWith({
              src,
              alt: "",
              width: 680,
              height: 260,
              onSettled,
              onError: null,
            }),
            $readout,
          ]);
        },
      },
      {
        title: "A source that fails",
        render: () => {
          const $readout = Typography.small("waiting…");
          return $column([
            LazyImage.makeWith({
              src: "/does-not-exist.png",
              alt: "",
              width: 680,
              height: 200,
              onSettled: null,
              onError: (src) => {
                $readout.textContent = `onError ${src}`;
              },
            }),
            $readout,
          ]);
        },
      },
    ];
  }
}
