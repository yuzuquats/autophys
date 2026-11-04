import "./home-list-cell";

import { Storybook } from "@tento-ui/ui/storybook";
import { HomeListCell } from "./home-list-cell";
import { TextPromptSubtitle } from "./text-prompt-subtitle";
import { Typography } from "@tento-ui/ui/typography";
import { TimezoneRegion } from "@tento-chrono";
import { Round } from "@tento-ui/components/round";
import { NumberInputAccessory } from "@tento-ui/components/input/number-input-accessory";
import { AvatarEditable } from "@tento-ui/components/core/avatar-editable";
import { CheckmarkIcon, LonaIcons } from "@tento-ui/ui/icons";
import { Toast } from "@tento-ui/components/toast/toast";

function card($child: HTMLElement): HTMLElement {
  const $r = Round.makeWith({
    bg: "var(--bg-hover-opaque)",
    radius: 24,
    transformTopLeft: true,
    shadow: "0 1px 2px rgba(0,0,0,0.4)",
  });
  $r.appendChild($child);
  return $r;
}

function $avatar(emoji: string): AvatarEditable {
  const $a = AvatarEditable.make();
  $a.slot = "avatar";
  $a.assignStyles({
    height: "32px",
    width: "32px",
    "--badge-height": "20px",
    "--badge-offset": "-4px",
    marginRight: "12px",
  });
  const $checkmark = LonaIcons.make(CheckmarkIcon, {
    sizePx: 20,
  });
  $a.bind({
    content: $checkmark,
    contentBg: "var(--bg)",
    badgeBg: "var(--bg)",
    badgeContent: Typography.p(emoji),
    onClickContent: () => {
      Toast.info("Checked");
    },
    noHover: true,
    radius: 64,
  });
  return $a;
}

export class HomeListCellStoryBook extends Storybook.Default {
  title(): string {
    return "Home List Cell";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "With Text Prompt",
        render: async () => {
          const $cell = HomeListCell.make().bind({
            title: "Daily Standup",
            caption: "Today",
          });
          const $content = TextPromptSubtitle.makeWith({
            date: (await TimezoneRegion.local()).now().ndt.date.toPartialExp(),
            placeholder: "Add an entry",
          });
          $content.slot = "content";
          $cell.appendChild($content);
          $cell.appendChild($avatar("📅"));
          return card($cell);
        },
      },
      {
        title: "No content",
        render: () => {
          const $cell = HomeListCell.make();
          $cell.bind({
            title: "Checkmark",
            caption: "Today",
          });
          $cell.appendChild($avatar("✅"));
          return card($cell);
        },
      },
      {
        title: "With Number Input Accessory",
        render: () => {
          const $cell = HomeListCell.make();
          $cell.bind({
            title: "Water Intake",
            caption: "Cups today",
          });
          const $accessory = NumberInputAccessory.makeWith({
            value: 4,
            placeholder: "0",
            onEditingFinished: (n) => {
              Toast.info(`Updated to ${n ?? 0} cups`);
            },
          });
          $accessory.slot = "accessory";
          $cell.appendChild($accessory);
          $cell.appendChild($avatar("💧"));
          return card($cell);
        },
      },
    ];
  }
}
