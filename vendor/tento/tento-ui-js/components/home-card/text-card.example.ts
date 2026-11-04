import "./text-card";

import { Storybook } from "@tento-ui/ui/storybook";
import { Toast } from "@tento-ui/components/toast/toast";
import { TextIcon, LonaIcons } from "@tento-ui/ui/icons";
import { SheetRowTextCard } from "./text-card";
import { $makeHomeCard } from "./home-grid-card.example";

export class SheetRowTextCardStoryBook extends Storybook.Default {
  title(): string {
    return "Sheet Row Text Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "In Context",
        render: () =>
          $makeHomeCard({
            title: "Daily Journal",
            icon: LonaIcons.$template(TextIcon),
            $cardContent: SheetRowTextCard.makeWith({
              value: "Hello, **world**!",
              onUpdate: (markdown) => Toast.info(`Updated: ${markdown}`),
            }),
          }),
      },
      {
        title: "Raw",
        render: () =>
          SheetRowTextCard.makeWith({
            value: "Hello, **world**! This is some markdown content.",
            onUpdate: (markdown) => Toast.info(`Updated: ${markdown}`),
          }),
      },
    ];
  }
}
