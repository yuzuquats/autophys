import { Center, Column } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Carousel } from "./carousel";
import { PageIndiciatorDots } from "../page-indicator-dots";

const SLIDES: [string, string][] = [
  ["var(--blue)", "var(--purple)"],
  ["var(--green)", "var(--teal)"],
  ["var(--orange)", "var(--red)"],
];

export class CarouselStoryBook extends Storybook.Default {
  title(): string {
    return "Carousel";
  }

  tags(): string[] {
    return ["std-carousel"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Swipe",
        render: () => {
          const $container = Column.make();
          $container.style.width = "200px";

          const $c = Carousel.make();
          $c.style.height = "160px";
          $c.style.width = "100%";

          const $indicatorDots = PageIndiciatorDots.make();
          $indicatorDots.bind(0, SLIDES.length);
          $indicatorDots.style.marginTop = "8px";
          $indicatorDots.style.alignSelf = "center";

          $c.domBind(
            SLIDES.map(([from, to]) => {
              const $slide = Center.make();
              $slide.style.background = `linear-gradient(135deg, ${from}, ${to})`;
              return $slide;
            }),
            SLIDES.length,
            {
              onScroll: (_from, to) => {
                $indicatorDots.bindSelectedIndex(to);
              },
            },
          );

          $container.appendChild($c);
          $container.appendChild($indicatorDots);

          return $container;
        },
      },
    ];
  }
}
