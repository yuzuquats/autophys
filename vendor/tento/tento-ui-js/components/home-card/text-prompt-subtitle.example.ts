import "./text-prompt-subtitle";

import { Storybook } from "@tento-ui/ui/storybook";
import { Toast } from "@tento-ui/components/toast/toast";
import { NaiveDate } from "@tento-chrono";
import { TextIcon, LonaIcons } from "@tento-ui/ui/icons";
import { TextPromptSubtitle } from "./text-prompt-subtitle";
import { SheetRowTextCard } from "./text-card";
import { $makeHomeCard } from "./home-grid-card.example";

export class TextPromptSubtitleStoryBook extends Storybook.Default {
  title(): string {
    return "Text Prompt Subtitle";
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
              value: "",
              onUpdate: (markdown) => Toast.info(`Updated: ${markdown}`),
            }),
            $listContent: TextPromptSubtitle.makeWith({
              date: NaiveDate.Partial.fromDate(NaiveDate.today()),
              placeholder: "Add an entry...",
              onSubmit: (text) => Toast.info(`Submitted: ${text}`),
            }),
            mode: "list",
          }),
      },
      {
        title: "Raw",
        render: () =>
          TextPromptSubtitle.makeWith({
            date: NaiveDate.Partial.fromDate(NaiveDate.today()),
            placeholder: "Type a message...",
            onSubmit: (text) => Toast.info(`Submitted: ${text}`),
          }),
      },
    ];
  }
}
