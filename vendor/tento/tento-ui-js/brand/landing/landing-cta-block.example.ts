import { Storybook } from "../../ui/storybook";
import { LandingCtaBlock } from "./landing-cta-block";

export class LandingCtaBlockStoryBook extends Storybook.Default {
  title(): string {
    return "Landing CTA Block";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () =>
          LandingCtaBlock.makeWith({
            heading: "Bring your time into focus",
            subtext:
              "Use one sheet to plan, compute, and review the work around your calendar.",
            primaryCta: { label: "Try Lona", href: "#" },
            secondaryCta: { label: "Contact us", href: "#" },
          }),
      },
    ];
  }
}
