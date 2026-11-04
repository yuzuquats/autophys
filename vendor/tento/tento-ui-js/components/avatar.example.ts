import { Row } from "../component-builtin";
import { Storybook } from "../ui/storybook";
import { Avatar } from "./avatar";
import { Badge } from "./badge";

export class AvatarStoryBook extends Storybook.Default {
  title(): string {
    return "Avatar";
  }

  tags(): string[] {
    return ["std-avatar"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Avatar with Initials",
        render: () => {
          const $container = Row.make();
          $container.style.gap = "16px";
          $container.style.padding = "16px";
          $container.style.alignItems = "center";

          const sizes: Array<"16" | "20" | "24" | "32"> = [
            "16",
            "20",
            "24",
            "32",
          ];

          for (const size of sizes) {
            const $avatar = Avatar.makeWithInitials(
              Avatar.Props.fromUsername("John Doe", { size }),
            );
            $container.appendChild($avatar);
          }

          return $container;
        },
      },
      {
        title: "Avatar with Images",
        render: () => {
          const $container = Row.make();
          $container.style.gap = "16px";
          $container.style.padding = "16px";
          $container.style.alignItems = "center";

          const images = [
            "https://static.lona.so/examples/profiles/markz.jpg",
            "https://static.lona.so/examples/profiles/huberman.jpg",
            "https://static.lona.so/examples/profiles/satya.jpg",
          ];

          for (const url of images) {
            const $avatar = Avatar.makeWithImage(url, undefined, "32");
            $container.appendChild($avatar);
          }

          return $container;
        },
      },
      {
        title: "Avatar with Badges",
        render: () => {
          const $container = Row.make();
          $container.style.gap = "24px";
          $container.style.padding = "16px";
          $container.style.alignItems = "center";

          const $avatar1 = Avatar.makeWithInitials({
            ...Avatar.Props.fromUsername("John Doe", { size: "32" }),
            badge: { content: "3", variant: "error" },
          });
          $container.appendChild($avatar1);

          const $avatar2 = Avatar.makeWithInitials({
            ...Avatar.Props.fromUsername("Jane Smith", { size: "32" }),
            badge: { content: "99+", variant: "info" },
          });
          $container.appendChild($avatar2);

          const $avatar3 = Avatar.makeWithImage(
            "https://static.lona.so/examples/profiles/markz.jpg",
            { variant: "dot" },
            "32",
          );
          $container.appendChild($avatar3);

          const $avatar4 = Avatar.makeWithInitials({
            ...Avatar.Props.fromUsername("Alice Brown", { size: "32" }),
            badge: { content: "!", variant: "warning" },
          });
          $container.appendChild($avatar4);

          return $container;
        },
      },
      {
        title: "Avatar with Different Badge Positions",
        render: () => {
          const $container = Row.make();
          $container.style.gap = "24px";
          $container.style.padding = "16px";
          $container.style.alignItems = "center";

          const positions: Array<Badge.Props["position"]> = [
            "top-right",
            "top-left",
            "bottom-right",
            "bottom-left",
          ];

          for (const position of positions) {
            const $avatar = Avatar.makeWithInitials({
              ...Avatar.Props.fromUsername("User", { size: "32" }),
              badge: { content: "1", variant: "error", position },
            });
            $container.appendChild($avatar);
          }

          return $container;
        },
      },
      {
        title: "Avatar with Tooltips",
        render: () => {
          const $container = Row.make();
          $container.style.gap = "16px";
          $container.style.padding = "16px";
          $container.style.alignItems = "center";

          const $avatar1 = Avatar.makeWithInitials(
            Avatar.Props.fromUsername("John Doe", {
              size: "32",
              tooltip: "Product Manager",
            }),
          );
          $container.appendChild($avatar1);

          const $avatar2 = Avatar.makeWithInitials({
            ...Avatar.Props.fromUsername("Jane Smith", {
              size: "32",
              tooltip: "Senior Developer",
            }),
            badge: { content: "5", variant: "error" },
          });
          $container.appendChild($avatar2);

          const $avatar3 = Avatar.makeWithInitials(
            Avatar.Props.custom(
              "AB",
              "var(--purple-dimmed)",
              "var(--text-sec-on-solid)",
              {
                size: "32",
                tooltip: "Custom Avatar with tooltip",
              },
            ),
          );
          $container.appendChild($avatar3);

          return $container;
        },
      },
    ];
  }
}
