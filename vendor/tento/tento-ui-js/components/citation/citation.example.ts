import { Storybook } from "../../ui/storybook";
import { Citation } from "./citation";

export class CitationStoryBook extends Storybook.Default {
  title(): string {
    return "Citation";
  }

  tags(): string[] {
    return ["std-citation"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Linked, indexed, authored", render: () => Citation.makeWith({ title: "Astryx components", url: "https://astryx.atmeta.com/components", author: "Meta", index: 1 }) },
      { title: "Plain", render: () => Citation.makeWith({ title: "charter.md", url: null, author: null, index: null }) },
    ];
  }
}
