import { Storybook } from "../../ui/storybook";
import "./landing-card";
import "./landing-grid";
import { LandingCard } from "./landing-card";
import { LandingGrid } from "./landing-grid";

export class LandingCardStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Card";
  }

  examples(): Storybook.Example[] {
    const positions: Array<"top" | "bottom" | "left" | "right"> = [
      "bottom",
      "top",
      "left",
      "right",
    ];

    return [
      {
        title: "Image positions",
        render: () => {
          const $grid = LandingGrid.makeWith({ columns: 2, gap: 14 });
          for (const imagePosition of positions) {
            $grid.appendChild(
              LandingCard.makeWith({
                title: `Image on ${imagePosition}`,
                description:
                  "A short subtitle sits just below the title, then the image fills the rest of the card.",
                imagePosition,
                showPlaceholderVisual: true,
                href: "#",
              }),
            );
          }
          return $grid;
        },
      },
      {
        title: "Grid",
        render: () => {
          const $grid = LandingGrid.makeWith({ columns: 3, gap: 14 });
          for (let i = 0; i < 3; i++) {
            $grid.appendChild(
              LandingCard.makeWith({
                title: "Placeholder card title",
                description: "One line of supporting copy goes here.",
                showPlaceholderVisual: true,
                href: "#",
              }),
            );
          }
          return $grid;
        },
      },
      {
        title: "Text only (no image)",
        render: () => {
          return LandingCard.makeWith({
            title: "A minimal card with just a title and subtitle.",
            description:
              "When no image is supplied the card collapses to its content height.",
            href: "#",
          });
        },
      },
    ];
  }
}
