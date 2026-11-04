import { Storybook } from "../../ui/storybook";
import "./landing-pill";
import { LandingPill } from "./landing-pill";

export class LandingPillStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Pill";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "All variants",
        render: () => {
          const $row = document.createElement("div");
          $row.style.display = "flex";
          $row.style.flexWrap = "wrap";
          $row.style.gap = "8px";
          $row.style.alignItems = "center";
          $row.appendChild(LandingPill.makeWith({ label: "Default" }));
          $row.appendChild(LandingPill.makeWith({ label: "Trust", variant: "trust" }));
          $row.appendChild(LandingPill.makeWith({ label: "Security", variant: "security" }));
          $row.appendChild(LandingPill.makeWith({ label: "Tag", variant: "tag" }));
          $row.appendChild(LandingPill.makeWith({ label: "Integration", variant: "integration" }));
          $row.appendChild(LandingPill.makeWith({ label: "Logo", variant: "logo" }));
          return $row;
        },
      },
      {
        title: "CTA pills",
        render: () => {
          const $row = document.createElement("div");
          $row.style.display = "flex";
          $row.style.flexWrap = "wrap";
          $row.style.gap = "8px";
          $row.style.alignItems = "center";
          $row.appendChild(LandingPill.makeWith({ label: "CTA", variant: "cta", onClick: () => {} }));
          $row.appendChild(LandingPill.makeWith({ label: "CTA Primary", variant: "cta", primary: true, onClick: () => {} }));
          return $row;
        },
      },
    ];
  }
}
