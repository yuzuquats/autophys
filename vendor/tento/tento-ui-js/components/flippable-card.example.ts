import { Storybook } from "@tento-ui/ui/storybook";
import { Typography } from "@tento-ui/ui/typography";
import { Column } from "../component-builtin";
import { FlippableCard } from "./flippable-card";

export class FlippableCardStoryBook extends Storybook.Default {
  title(): string {
    return "Flippable Card";
  }

  tags(): string[] {
    return ["std-flippable-card"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Click to flip",
        render: () => {
          const $card = FlippableCard.make()
            .assignStyles<FlippableCard>({
              height: "200px",
            })
            .addPointerEvent<FlippableCard>({
              onClick: () => {
                $card.flip();
              },
            });
          $card.appendChild(makeCardFace("front", "Flip Me", "var(--blue)"));
          $card.appendChild(makeCardFace("back", "Back Face", "var(--orange)"));

          return $card;
        },
      },
    ];
  }
}

function makeCardFace(
  slot: string,
  title: string,
  background: string,
): HTMLElement {
  const $face = Column.make();
  $face.slot = slot;
  $face.assignStyles({
    padding: "24px",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    background,
  });

  $face.appendChild(
    Typography.h4(title).assignStyles({
      color: "var(--text-sec)",
    }),
  );
  return $face;
}
