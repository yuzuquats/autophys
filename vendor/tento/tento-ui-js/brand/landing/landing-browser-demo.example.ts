import { Storybook } from "../../ui/storybook";
import { LandingBrowserDemo } from "./landing-browser-demo";

export class LandingBrowserDemoStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Browser Demo";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Product screenshot",
        render: () =>
          LandingBrowserDemo.makeWith({
            src: "/@/static/img/landing/feature-calendar.webp",
            alt: "Lona time sheet product screenshot",
            width: 2400,
            height: 1600,
            fetchPriority: null,
          }),
      },
    ];
  }
}
