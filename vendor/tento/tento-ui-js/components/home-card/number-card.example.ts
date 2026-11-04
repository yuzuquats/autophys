import "./number-card";

import { Storybook } from "@tento-ui/ui/storybook";
import { Toast } from "@tento-ui/components/toast/toast";
import { NumberIcon, LonaIcons } from "@tento-ui/ui/icons";
import { SheetRowNumberCard } from "./number-card";
import { $makeHomeCard } from "./home-grid-card.example";

export class SheetRowNumberCardStoryBook extends Storybook.Default {
  title(): string {
    return "Sheet Row Number Card";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "In Context",
        render: () =>
          $makeHomeCard({
            title: "Daily Steps",
            icon: LonaIcons.$template(NumberIcon),
            contentBg: "var(--bg-hover-opaque)",
            $cardContent: SheetRowNumberCard.makeWith({
              value: 8500,
              onUpdate: (value) => Toast.info(`Updated: ${value}`),
            }),
          }),
      },
      {
        title: "Raw",
        render: () =>
          SheetRowNumberCard.makeWith({
            value: 42,
            onUpdate: (value) => Toast.info(`Updated: ${value}`),
          }),
      },
    ];
  }
}
