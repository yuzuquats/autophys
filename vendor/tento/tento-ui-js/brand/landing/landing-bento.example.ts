import { Storybook } from "../../ui/storybook";
import "./landing-bento";
import { LandingBento } from "./landing-bento";

export class LandingBentoStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Bento";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Bento grid",
        render: () => {
          return LandingBento.makeWith({
            title: "A modern operating surface for product teams",
            items: [
              {
                kicker: "Agent workflows",
                title: "Turn notes and feedback into prioritized work",
                description: "Capture ideas, summarize signal, and create actionable tasks.",
                showPlaceholderVisual: true,
                visualHeight: 120,
                tags: ["Intake", "Routing", "Prioritization"],
                span: 2,
                background: "color-mix(in srgb, var(--bg) 98%, #eceff4 2%)",
              },
              {
                kicker: "Planning",
                title: "Roadmaps that stay aligned with execution",
                description: "Initiatives, specs, and delivery status stay connected.",
                showPlaceholderVisual: true,
              },
              {
                kicker: "Knowledge",
                title: "Docs that stay useful as teams scale",
                description: "Shared context without duplication.",
                showPlaceholderVisual: true,
              },
              {
                kicker: "Ecosystem",
                title: "Works with the stack your team already uses",
                tags: ["Slack", "GitHub", "Figma", "Linear", "Zapier"],
                span: 2,
                background: "color-mix(in srgb, var(--bg) 98%, #edf2ed 2%)",
              },
            ],
          });
        },
      },
    ];
  }
}
