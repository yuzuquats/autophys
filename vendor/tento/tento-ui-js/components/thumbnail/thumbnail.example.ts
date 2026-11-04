import { SearchIcon } from "../../icon-exports";
import { Storybook } from "../../ui/storybook";
import { Thumbnail } from "./thumbnail";

// A 1×1 data URI so the "loaded" case needs no network.
const PIXEL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#7b83ff"/><circle cx="120" cy="30" r="18" fill="#fff"/></svg>',
  );

export class ThumbnailStoryBook extends Storybook.Default {
  title(): string {
    return "Thumbnail";
  }

  tags(): string[] {
    return ["std-thumbnail"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Square, cover",
        render: () => Thumbnail.makeWith({ src: PIXEL, alt: "A moon over blue", sizePx: 80, ratio: null, fit: "cover", fallback: null, onError: null }),
      },
      {
        title: "16:9, contain",
        render: () => Thumbnail.makeWith({ src: PIXEL, alt: "", sizePx: 160, ratio: 16 / 9, fit: "contain", fallback: null, onError: null }),
      },
      {
        title: "No source — initials",
        render: () => Thumbnail.makeWith({ src: null, alt: "James Kao", sizePx: 64, ratio: null, fit: "cover", fallback: { initials: "JK" }, onError: null }),
      },
      {
        title: "Broken source — glyph fallback",
        render: () => Thumbnail.makeWith({ src: "https://invalid.invalid/x.png", alt: "Search result", sizePx: 64, ratio: null, fit: "cover", fallback: { svg: SearchIcon }, onError: null }),
      },
    ];
  }
}
