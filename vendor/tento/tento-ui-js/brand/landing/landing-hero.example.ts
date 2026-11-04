import { Storybook } from "../../ui/storybook";
import "./landing-hero";
import { LandingHero } from "./landing-hero";

function makeProductShot(): HTMLElement {
  const $shot = document.createElement("div");
  $shot.style.border = "1px solid var(--divider)";
  $shot.style.borderRadius = "14px";
  $shot.style.padding = "14px";
  $shot.style.background = "color-mix(in srgb, var(--bg) 98%, #efefed 2%)";
  $shot.style.maxWidth = "680px";

  const $rail = document.createElement("div");
  $rail.style.height = "16px";
  $rail.style.borderRadius = "8px";
  $rail.style.background = "color-mix(in srgb, var(--bg) 90%, #e8e8e5 10%)";
  $rail.style.marginBottom = "10px";
  $shot.appendChild($rail);

  const $grid = document.createElement("div");
  $grid.style.display = "grid";
  $grid.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
  $grid.style.gap = "10px";
  for (let i = 0; i < 3; i++) {
    const $cell = document.createElement("div");
    $cell.style.height = "84px";
    $cell.style.borderRadius = "10px";
    $cell.style.border = "1px solid var(--divider)";
    $cell.style.background = "color-mix(in srgb, var(--bg) 96%, #ececea 4%)";
    $grid.appendChild($cell);
  }
  $shot.appendChild($grid);

  return $shot;
}

export class LandingHeroStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Hero";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Hero",
        render: () => {
          return LandingHero.makeWith({
            kicker: "Productivity landing example",
            headline: "Build, ship, and learn in one calm workspace.",
            subtitle: "Bring planning, documentation, and execution into a single flow that works for both teams and AI agents.",
            ctas: [
              { label: "Start free", primary: true },
              { label: "Watch demo" },
            ],
            renderVisual: () => makeProductShot(),
          });
        },
      },
    ];
  }
}
