import { Storybook } from "../../ui/storybook";
import { LinkText } from "./link-text";

export class LinkTextStoryBook extends Storybook.Default {
  title(): string {
    return "Link";
  }

  tags(): string[] {
    return ["std-link"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Internal",
        render: () => LinkText.makeWith({ href: "#lib:core", text: "Core library", external: false, onClick: null, tone: null }),
      },
      {
        title: "External",
        render: () => LinkText.makeWith({ href: "https://lona.so", text: "lona.so", external: true, onClick: null, tone: null }),
      },
      {
        title: "Quiet",
        render: () => LinkText.makeWith({ href: "#lib:core", text: "Settings", external: false, onClick: null, tone: "quiet" }),
      },
    ];
  }
}
