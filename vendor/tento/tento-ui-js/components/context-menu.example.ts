import { Center, Row } from "../component-builtin";
import { css, Style } from "../component-styles";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { LinkIcon, PencilIcon, TrashIcon } from "../ui/icons";
import { ContextMenu } from "./context-menu";
import { Position } from "../anchor-positioning-utils";

function builder(): ReturnType<typeof ContextMenu.builder> {
  const dismisses = (state: { shouldDismiss: boolean }) => {
    state.shouldDismiss = true;
  };
  return ContextMenu.builder()
    .cellRow("Rename", PencilIcon, dismisses)
    .cellRow("Copy link", LinkIcon, dismisses)
    .cellRow("Move to…", null, null)
    .cellRow("Delete", TrashIcon, dismisses, "var(--red)");
}

export class ContextMenuStoryBook extends Storybook.Default {
  title(): string {
    return "Context Menu";
  }

  tags(): string[] {
    return ["std-context-menu-anchor"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        // The menu a right-click reveals, laid in place.
        title: "Menu",
        render: () => builder().build({ onDismiss: () => {} }),
      },
      {
        title: "Targets",
        render: () => {
          const $container = Row.make();
          $container.style.gap = "8px";

          const styles = {
            height: "200px",
            width: "120px",
            borderRadius: "8px",
            transition: "background 0.3s ease",
            justifyContent: "center",
          };

          {
            const $target = Center.make();
            $target.assignStyles(styles);
            $target.classList.add("context-menu-target");
            $target.toggleAttribute("first");
            $target.appendChild(
              Typography.p("Context Menu").assignStyles({
                color: "var(--text-sec)",
              }),
            );
            GESTURE_MANAGER.addPointerEvent($target, {
              onContextMenu: (p) =>
                builder().buildAndReveal($target, {
                  position: Position.fromPoint(p),
                }),
            });
            $container.appendChild($target);
          }

          {
            // Rows here keep the menu open when chosen.
            const persists = (state: { shouldDismiss: boolean }) => {
              state.shouldDismiss = false;
            };
            const $target = Center.make();
            $target.assignStyles(styles);
            $target.classList.add("context-menu-target");
            $target.toggleAttribute("second");
            $target.appendChild(
              Typography.p("Right Click").assignStyles({
                color: "var(--text-sec)",
              }),
            );
            GESTURE_MANAGER.addPointerEvent($target, {
              onContextMenu: (p) =>
                ContextMenu.builder()
                  .cellRow("Pie", null, persists)
                  .cellRow("Cake", null, persists)
                  .cellRow("Croissant", null, persists)
                  .buildAndReveal($target, {
                    position: Position.fromPoint(p),
                  }),
            });
            $container.appendChild($target);
          }

          $container.appendChild(
            Style.makeWith(css`
              .context-menu-target[first] {
                background: var(--red);
              }
              .context-menu-target[second] {
                background: var(--yellow);
              }
              .context-menu-target[context-menu-open] {
                background: var(--orange);
              }
            `),
          );

          return $container;
        },
      },
    ];
  }
}
