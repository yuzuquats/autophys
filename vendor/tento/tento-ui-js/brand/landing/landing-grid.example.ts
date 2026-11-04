import { Storybook } from "../../ui/storybook";
import "./landing-grid";
import "./landing-card";
import { LandingGrid } from "./landing-grid";
import { LandingCard } from "./landing-card";

function solidVisual(height: number, color: string): () => HTMLElement {
  return () => {
    const $div = document.createElement("div");
    $div.style.height = `${height}px`;
    $div.style.background = color;
    $div.style.width = "100%";
    return $div;
  };
}

export class LandingGridStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Grid";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Heterogeneous rows — full-width hero + 3-column cards",
        render: () => {
          const $grid = LandingGrid.makeWith({ columns: 3, gap: 20 });

          const $hero = LandingCard.makeWith({
            kicker: "FEATURED",
            title: "A full-width card spanning the entire row",
            description: "This card uses grid-column: span 3 to stretch across all columns, acting as a hero row.",
            renderVisual: solidVisual(160, "#c8d0dc"),
          });
          $hero.style.gridColumn = "span 3";
          $grid.appendChild($hero);

          for (const item of [
            { kicker: "01", title: "Ship faster", description: "Teams cut planning overhead by 40%." },
            { kicker: "02", title: "Stay aligned", description: "Real-time visibility across product and engineering." },
            { kicker: "03", title: "Scale with confidence", description: "The same workspace adapts as you grow." },
          ]) {
            $grid.appendChild(LandingCard.makeWith(item));
          }

          return $grid;
        },
      },
      {
        title: "Mixed spans — 2-wide + 1-wide cards",
        render: () => {
          const $grid = LandingGrid.makeWith({ columns: 3, gap: 20 });

          const $wide = LandingCard.makeWith({
            kicker: "AGENT WORKFLOWS",
            title: "Turn notes and feedback into prioritized work",
            description: "Capture ideas, summarize signal, and create actionable tasks with built-in agent handoff.",
            renderVisual: solidVisual(120, "#d4c8b8"),
            tags: ["Intake", "Routing", "Prioritization"],
          });
          $wide.style.gridColumn = "span 2";
          $grid.appendChild($wide);

          $grid.appendChild(LandingCard.makeWith({
            kicker: "PLANNING",
            title: "Roadmaps that stay aligned",
            description: "Initiatives, specs, and delivery status stay connected in real time.",
          }));

          $grid.appendChild(LandingCard.makeWith({
            kicker: "KNOWLEDGE",
            title: "Docs that stay useful",
            description: "Shared context for product and engineering without duplication.",
          }));

          const $wide2 = LandingCard.makeWith({
            kicker: "ECOSYSTEM",
            title: "Works with the stack your team already uses",
            tags: ["Slack", "GitHub", "Figma", "Linear", "Zapier"],
            background: "color-mix(in srgb, var(--bg) 98%, #edf2ed 2%)",
          });
          $wide2.style.gridColumn = "span 2";
          $grid.appendChild($wide2);

          return $grid;
        },
      },
      {
        title: "Hero layout — full-width top + two half-width below",
        render: () => {
          const $grid = LandingGrid.makeWith({ layout: "hero", gap: 16 });

          $grid.appendChild(LandingCard.makeWith({
            kicker: "ANNOUNCEMENTS",
            title: "Introducing Lona: A New Kind of Calendar",
            description: "Bringing planning, notes, and workflows together in one calm, high-signal workspace.",
            renderVisual: solidVisual(140, "#b8d4c8"),
          }));

          $grid.appendChild(LandingCard.makeWith({
            kicker: "ENGINEERING",
            title: "Building Design Systems at Scale",
            description: "How a shared component layer increased velocity across surfaces.",
          }));

          $grid.appendChild(LandingCard.makeWith({
            kicker: "PRODUCT",
            title: "Product Thinking for Engineers",
            description: "Understanding product context makes you a better engineer.",
          }));

          return $grid;
        },
      },
    ];
  }
}
