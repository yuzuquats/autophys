import { Storybook } from "../../ui/storybook";
import { LandingFooter } from "./landing-footer";

export class BrandFooterStoryBook extends Storybook.Default {
  title(): string {
    return "Brand Footer";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Footer",
        render: () => {
          return LandingFooter.make();
        },
      },
    ];
  }
}
