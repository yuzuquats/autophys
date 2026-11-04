import { Storybook } from "../../ui/storybook";
import "./landing-section";
import { LandingSection } from "./landing-section";

export class LandingSectionStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Section";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Trust strip",
        render: () => {
          return LandingSection.trustStrip({
            label: "Trusted by teams shipping weekly",
            logos: ["OpenAI", "Figma", "Ramp", "Vercel", "Cursor"],
            metrics: [
              { value: "100M+", label: "users reached" },
              { value: "62%", label: "Fortune 100 usage" },
              { value: "3.2x", label: "faster campaign launches" },
            ],
          });
        },
      },
      {
        title: "Security strip",
        render: () => {
          return LandingSection.securityStrip({
            title: "Enterprise-ready trust signals",
            badges: ["SOC2 Type II", "ISO 27001", "GDPR", "99.99% uptime target"],
          });
        },
      },
    ];
  }
}
