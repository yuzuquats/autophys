import { Storybook } from "../../ui/storybook";
import { Skeleton } from "./skeleton";

export class SkeletonStoryBook extends Storybook.Default {
  title(): string {
    return "Skeleton";
  }

  tags(): string[] {
    return ["std-skeleton"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Three lines of text", render: () => Storybook.fill(Skeleton.makeWith({ shape: "text", lines: 3, widthPx: null, heightPx: null, animated: true }), "320px") },
      { title: "Rectangle 200×120", render: () => Storybook.fill(Skeleton.makeWith({ shape: "rect", lines: null, widthPx: 200, heightPx: 120, animated: true }), "200px") },
      { title: "Circle 48", render: () => Storybook.fill(Skeleton.makeWith({ shape: "circle", lines: null, widthPx: 48, heightPx: null, animated: true }), "48px") },
      { title: "Static (animated: false)", render: () => Storybook.fill(Skeleton.makeWith({ shape: "text", lines: 2, widthPx: null, heightPx: null, animated: false }), "320px") },
    ];
  }
}
