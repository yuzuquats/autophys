import { CarouselIndicator } from "./carousel-indicator";
import { Storybook } from "@tento-ui/ui/storybook";

export class CarouselIndicatorStoryBook extends Storybook.Default {
  title(): string {
    return "Carousel Indicator";
  }

  tags(): string[] {
    return ["std-carousel-indicator"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () => {
          return CarouselIndicator.makeWith({
            count: 3,
            onToggle: () => {},
            onEdit: () => {},
          });
        },
      },
    ];
  }
}
