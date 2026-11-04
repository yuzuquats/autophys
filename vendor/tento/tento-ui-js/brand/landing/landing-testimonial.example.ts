import { Storybook } from "../../ui/storybook";
import "./landing-testimonial";
import { LandingTestimonial } from "./landing-testimonial";

export class LandingTestimonialStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Testimonial";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Testimonials (2-up grid)",
        render: () => {
          const $grid = document.createElement("div");
          $grid.style.display = "grid";
          $grid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
          $grid.style.gap = "20px";
          $grid.appendChild(LandingTestimonial.makeWith({
            quote: "The structure made it easy to compare ideas and ship a stronger landing page in days, not weeks.",
            authorName: "Kira L.",
            role: "Head of Product, Aster Labs",
            initials: "KL",
          }));
          $grid.appendChild(LandingTestimonial.makeWith({
            quote: "We replaced three tools and still had a simpler workflow at the end.",
            authorName: "Ravi N.",
            role: "VP Engineering, Meridian Health",
            initials: "RN",
            avatarBackground: "color-mix(in srgb, var(--blue-dimmed) 60%, var(--bg) 40%)",
          }));
          return $grid;
        },
      },
    ];
  }
}
