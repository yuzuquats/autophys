import { Storybook } from "@tento-ui/ui/storybook";
import { AvatarEditable } from "./avatar-editable";
import { Toast } from "../toast/toast";

export class AvatarEditableStoryBook extends Storybook.Default {
  title(): string {
    return "Avatar Editable";
  }

  tags(): string[] {
    return ["std-editable-avatar", "std-avatar-editable-badge"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Avatar Editable",
        render: () => {
          return AvatarEditable.make().bind({
            content: "A",
            contentBg: "var(--blue)",
            badgeBg: "var(--orange)",
            badgeContent: "",
          });
        },
      },
      {
        title: "Avatar Editable (Active)",
        render: () => {
          const $i = AvatarEditable.make().bind({
            content: "A",
            contentBg: "var(--blue)",
            badgeBg: "var(--orange)",
            badgeContent: "",
          });
          $i.toggleAttribute("active");
          return $i;
        },
      },
      {
        title: "Both Click Handlers",
        render: () => {
          return AvatarEditable.make().bind({
            content: "🎯",
            contentBg: "var(--blue)",
            badgeBg: "var(--green)",
            badgeContent: "📅",
            onClickContent: () => {
              Toast.info("Content Clicked!");
            },
            onClickBadge: () => {
              Toast.info("Badge Clicked!");
            },
          });
        },
      },
      {
        title: "Only Content Handler",
        render: () => {
          return AvatarEditable.make().bind({
            content: "😀",
            contentBg: "var(--purple)",
            badgeBg: "",
            badgeContent: null,
            onClickContent: () => {
              Toast.info("Content handler triggered");
            },
          });
        },
      },
      {
        title: "Only Badge Handler",
        render: () => {
          return AvatarEditable.make().bind({
            content: "🎨",
            contentBg: "var(--orange)",
            badgeBg: "var(--red)",
            badgeContent: "🔔",
            onClickBadge: () => {
              Toast.info("Badge handler triggered");
            },
          });
        },
      },
    ];
  }
}
