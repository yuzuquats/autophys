import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LandingTestimonial } from "./landing-testimonial";

@component({ name: "std-landing-social-proof" })
export class LandingSocialProof extends LonaWebComponent {
  private $shell: HTMLElement = this.$("shell");
  private $label: HTMLElement = this.$("label");
  private $testimonials: HTMLElement = this.$("testimonials");

  static makeWith(props: LandingSocialProof.Props): LandingSocialProof {
    return (LandingSocialProof.make() as LandingSocialProof).bind(props);
  }

  bind(props: LandingSocialProof.Props): this {
    const variant = props.variant ?? "signal-strip";
    const label = props.label ?? "Trusted every day by teams that build world-class software";
    const testimonials = props.testimonials ?? [];
    this.setAttribute("variant", variant);
    this.$label.textContent = label;
    this.$shell.setAttribute("aria-label", label);
    DomUtils.clearChildren(this.$testimonials);
    this.$testimonials.hidden = testimonials.length === 0;

    for (const testimonial of testimonials) {
      this.$testimonials.appendChild(this.$testimonial(testimonial));
    }

    return this;
  }

  private $testimonial(
    testimonial: LandingSocialProof.Testimonial,
  ): LandingTestimonial {
    // Testimonials lead with the person: name on top, role/affiliation beneath.
    return LandingTestimonial.makeWith({
      quote: testimonial.quote,
      authorName: testimonial.authorName,
      role: testimonial.authorTitle ?? testimonial.company ?? "",
      avatarName: testimonial.authorName,
      initials: testimonial.initials ?? null,
      avatarUrl: testimonial.avatarUrl ?? null,
      avatarBackground: null,
    });
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #shell {
        display: grid;
        justify-items: center;
        gap: 36px;
        text-align: center;
      }

      /* Matches the section-header treatment used everywhere else on the page
         (std-landing-section-intro #heading): an h2 at --text-22px, so the
         testimonials header reads as a real section heading, not a small
         bold trust strip. */
      #label {
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-family: inherit;
        max-width: 720px;
        --font-size: var(--text-22px);
        --line-height-ratio: 1.06;
        color: var(--text-pri);
      }

      #testimonials {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        width: min(100%, 840px);
        text-align: left;
      }

      #testimonials[hidden] {
        display: none;
      }

      std-landing-testimonial {
        background: var(--bg);
      }

      @media (max-width: 768px) {
        #shell {
          justify-items: start;
          text-align: left;
        }

        #testimonials {
          grid-template-columns: 1fr;
          width: 100%;
        }
      }
    `,
  ];

  static $html = html`
    <section id="shell">
      <h2 id="label"></h2>
      <div id="testimonials"></div>
    </section>
  `;
}

export namespace LandingSocialProof {
  export type Variant = "signal-strip";

  export type Testimonial = {
    authorName: string;
    authorTitle?: Option<string>;
    avatarUrl?: Option<string>;
    company?: Option<string>;
    initials?: Option<string>;
    quote: string;
  };

  export type Props = {
    label?: Option<string>;
    testimonials?: Option<Testimonial[]>;
    variant?: Option<Variant>;
  };
}
