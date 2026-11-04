import { Center } from "../../component-builtin";
import { CSSLength } from "../../css-length";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { SidebarContainer, SidebarContainerState } from "./sidebar-container";

export class SidebarContainerStoryBook extends Storybook.Default {
  title(): string {
    return "Sidebar Container";
  }

  tags(): string[] {
    return ["std-sidebar-container"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Sidebar Container",
        render: () => {
          const $c = SidebarContainer.make();
          let docked = false;
          $c.assignStyles({
            height: "500px",
            width: "300px",
            maxWidth: "100%",
            display: "block",
            borderRadius: "8px",
            background: "var(--green)",
            "--sidebar-container-top": "0px",
            "--sidebar-container-height": "100%",
          });
          const syncSidebar = (animate: boolean) => {
            $c.bind({
              viewModel: docked
                ? SidebarContainerState.docked({
                    width: CSSLength.fromPx(100),
                    animate,
                    resizeEnabled: false,
                  })
                : SidebarContainerState.peek({
                    width: CSSLength.fromPx(100),
                    animate,
                    resizeEnabled: false,
                  }),
              delegate: null,
            });
          };
          syncSidebar(false);

          const $content = Center.make();
          $content.slot = "main-content";
          $content.assignStyles({
            height: "500px",
          });
          $content.appendChild(
            Typography.h4("Click me").assignStyles({
              color: "var(--text-sec)",
            }),
          );
          GESTURE_MANAGER.addPointerEvent($content, {
            onClick: () => {
              docked = !docked;
              syncSidebar(true);
            },
          });

          $c.appendChild($content);

          return $c;
        },
      },
    ];
  }
}
