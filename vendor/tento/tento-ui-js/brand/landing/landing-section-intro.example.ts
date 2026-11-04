import { Storybook } from "../../ui/storybook";
import { LandingSectionIntro } from "./landing-section-intro";

export class LandingSectionIntroStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Section Intro";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () =>
          LandingSectionIntro.makeWith({
            heading: "Calculate across time",
            subtext:
              "Events, tasks, habits, and formulas share the same time axis.",
          }),
      },
      {
        title: "Heading only",
        render: () =>
          LandingSectionIntro.makeWith({
            heading: "Questions",
            subtext: null,
          }),
      },
    ];
  }
}
