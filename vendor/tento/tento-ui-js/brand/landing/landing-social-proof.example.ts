import { Storybook } from "../../ui/storybook";
import { LandingSocialProof } from "./landing-social-proof";

const testimonials: LandingSocialProof.Testimonial[] = [
  {
    quote: "The win is not another calendar view. It is that I stopped rebuilding the week before making every decision.",
    authorName: "Mara P.",
    authorTitle: "Founder",
    initials: "MP",
  },
  {
    quote: "The upgrade made sense when Lona replaced the tabs I used just to understand what Friday could handle.",
    authorName: "Evan R.",
    authorTitle: "Consultant",
    initials: "ER",
  },
];

function renderProof(props: LandingSocialProof.Props): HTMLElement {
  const $frame = document.createElement("div");
  $frame.assignStyles({
    maxWidth: "960px",
    padding: "28px",
    background: "var(--bg)",
  });
  $frame.appendChild(LandingSocialProof.makeWith(props));
  return $frame;
}

export class LandingSocialProofStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Social Proof";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Default",
        render: () => renderProof({ testimonials }),
      },
      {
        title: "Custom copy",
        render: () =>
          renderProof({
            label: "Trusted every day by people who plan from one live week",
            testimonials,
          }),
      },
    ];
  }
}
