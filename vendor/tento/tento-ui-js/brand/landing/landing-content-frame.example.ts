import { Storybook } from "../../ui/storybook";
import { LandingContentFrame } from "./landing-content-frame";

function pricingPlaceholder(): HTMLElement {
  const $content = document.createElement("div");
  $content.assignStyles({
    display: "grid",
    placeItems: "center",
    minHeight: "520px",
    border: "1px solid var(--divider)",
    borderRadius: "12px",
    background: "var(--bg)",
    color: "var(--text-sec)",
  });
  $content.textContent = "Plan selector surface";
  return $content;
}

export class LandingContentFrameStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Content Frame";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Pricing frame",
        render: () =>
          LandingContentFrame.makeWith({
            variant: "pricing",
            content: pricingPlaceholder(),
          }),
      },
    ];
  }
}
