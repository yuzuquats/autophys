import { Column } from "../component-builtin";
import { Storybook } from "../ui/storybook";
import { Typography } from "../ui/typography";
import { Button } from "./button/button";
import { Round } from "./round";
import { Transition } from "./transition";

export class TransitionStoryBook extends Storybook.Default {
  title(): string {
    return "Standard Transition";
  }

  tags(): string[] {
    return ["std-transition"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          const $e = Column.make();

          const $transition = Transition.make();
          $transition
            .bind({
              state: "before",
              callbacks: {},
              $before: Typography.h6("Before"),
              $after: Typography.h6("After"),
            })
            .assignStyles({
              padding: "12px",
            });
          $e.appendChild(
            Round.makeWithContent($transition, {
              radius: 12,
              bg: "var(--red)",
            }).assignStyles({
              height: "200px",
              width: "200px",
              marginBlock: "4px",
              color: "var(--text-sec)",
            }),
          );

          const $btn = Button.makeWithLight("toggle", {
            onClick: () => {
              $transition.toggleState();
            },
          });
          $e.appendChild($btn);

          return $e;
        },
      },
    ];
  }
}
