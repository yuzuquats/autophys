import { Storybook } from "../../ui/storybook";
import { Token } from "./token";

export class TokenStoryBook extends Storybook.Default {
  title(): string {
    return "Token";
  }

  tags(): string[] {
    return ["std-token"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Removable", render: () => Token.makeWith({ label: "design-system", removable: true, onRemove: () => {}, tone: null }) },
      { title: "Fixed, accent tone", render: () => Token.makeWith({ label: "core", removable: false, onRemove: null, tone: "accent" }) },
    ];
  }
}
