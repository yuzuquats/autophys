import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Column } from "../../component-builtin";
import { Texture } from "../../ui/texture";
import { LandingPill } from "./landing-pill";
import { LandingMetric } from "./landing-metric";
import { LandingCard } from "./landing-card";

@component({ name: "std-landing-section" })
export class LandingSection extends LonaWebComponent {
  private $inner: HTMLElement = this.$("inner");
  private revealObserver: Option<IntersectionObserver>;

  connectedCallback(): void {
    super.connectedCallback();

    if (!this.hasAttribute("first")) {
      this.classList.add("reveal-hidden");
    }

    this.revealObserver = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          this.classList.remove("reveal-hidden");
          this.classList.add("reveal-visible");
          this.revealObserver?.disconnect();
          this.revealObserver = undefined;
        }
      },
      { threshold: 0.1 },
    );
    this.revealObserver.observe(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.revealObserver?.disconnect();
    this.revealObserver = undefined;
  }

  static makeWith(props: LandingSection.Props): LandingSection {
    return (LandingSection.make() as LandingSection).bind(props);
  }

  bind(props: LandingSection.Props): this {
    const paddingY = props.paddingY ?? 80;
    const background = props.background ?? "var(--bg)";
    const border = props.border ?? true;
    const gap = props.gap ?? 0;

    this.style.background = background;
    this.style.paddingTop = `${props.paddingTop ?? paddingY}px`;
    this.style.paddingBottom = `${props.paddingBottom ?? paddingY}px`;
    this.style.setProperty("--section-padding-y", `${paddingY}px`);

    this.toggleAttribute("no-border", !border);
    this.toggleAttribute("first", !!props.first);
    this.$inner.style.maxWidth = props.maxWidth == null ? "" : `${props.maxWidth}px`;
    this.$inner.style.gap = props.gap == null ? "" : `${gap}px`;

    return this;
  }

  static $html = html`
    <div class="grain-overlay"></div>
    <std-col id="inner"><slot></slot></std-col>
  `;

  static $styles = [
    Texture.$grainOverlayStyle,
    css`
      :host {
        display: block;
        padding: 80px 0;
        position: relative;
        overflow: hidden;
      }

      :host(:not([first])) {
        content-visibility: auto;
        contain-intrinsic-size: auto var(--section-contain-intrinsic-size, 720px);
      }

      :host::before {
        content: "";
        display: block;
        width: 60%;
        max-width: 560px;
        height: 1px;
        background: var(--divider);
        margin: 0 auto;
        position: absolute;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
      }

      :host([first])::before {
        display: none;
      }

      .grain-overlay {
        opacity: 0.4;
        z-index: 0;
      }

      :host([no-border])::before {
        display: none;
      }

      #inner {
        position: relative;
        z-index: 1;
        width: 100%;
        max-width: var(--max-width, 1080px);
        padding: 0 var(--brand-inline-padding, 40px);
        box-sizing: border-box;
        margin-left: auto;
        margin-right: auto;
      }

      :host(.reveal-hidden) #inner {
        opacity: 0;
        transform: translateY(24px);
      }

      :host(.reveal-visible) #inner {
        opacity: 1;
        transform: translateY(0);
        transition: opacity 0.45s ease, transform 0.45s ease;
      }

      @media (prefers-reduced-motion: reduce) {
        :host(.reveal-hidden) #inner,
        :host(.reveal-visible) #inner {
          opacity: 1;
          transform: none;
          transition: none;
        }
      }

      @media (max-width: 768px) {
        :host {
          padding-top: calc(var(--section-padding-y, 80px) * 0.7);
          padding-bottom: calc(var(--section-padding-y, 80px) * 0.7);
        }

        #inner {
          padding: 0 var(--brand-inline-padding-mobile, 16px);
        }
      }
    `,
  ];
}

@component({ name: "std-section" })
export class Section extends LandingSection {
  static makeWith(props: LandingSection.Props): Section {
    return (Section.make() as Section).bind(props);
  }
}

function makeSectionTitle(text: string): HTMLElement {
  const $title = document.createElement("h3");
  $title.className = "section-title";
  $title.textContent = text;
  return $title;
}

function makeFlexRow(gap: string): HTMLElement {
  const $row = document.createElement("div");
  $row.style.display = "flex";
  $row.style.flexWrap = "wrap";
  $row.style.gap = gap;
  return $row;
}

export namespace LandingSection {
  export type Props = {
    maxWidth?: Option<number>;
    paddingY?: Option<number>;
    /** Explicit section seams; omitted sides follow paddingY. */
    paddingTop?: Option<number>;
    paddingBottom?: Option<number>;
    background?: Option<string>;
    border?: Option<boolean>;
    gap?: Option<number>;
    first?: Option<boolean>;
  };

  export type TrustStripProps = {
    label: string;
    logos: string[];
    metrics: LandingMetric.Props[];
  };

  export type OutcomesProps = {
    title: string;
    items: { index: string; title: string; description: string }[];
  };

  export type SecurityStripProps = {
    title: string;
    badges: string[];
  };

  export type CtaBlockProps = {
    kicker: string;
    title: string;
    copy: string;
    actions?: Option<{ label: string; primary?: Option<boolean>; onClick?: Option<() => void> }[]>;
  };

  export function trustStrip(props: TrustStripProps): LandingSection {
    const $section = LandingSection.makeWith({
      paddingY: 64,
      background: "var(--bg)",
      gap: 16,
    });

    const $label = document.createElement("p");
    $label.className = "kicker";
    $label.style.setProperty("--margin-bottom", "12px");
    $label.textContent = props.label;
    $section.appendChild($label);

    const $logoRow = makeFlexRow("8px");
    for (const logo of props.logos) {
      $logoRow.appendChild(LandingPill.makeWith({ label: logo, variant: "trust" }));
    }
    $section.appendChild($logoRow);

    const $metricsRow = makeFlexRow("10px");
    $metricsRow.style.marginTop = "4px";
    for (const metric of props.metrics) {
      $metricsRow.appendChild(LandingMetric.makeWith(metric));
    }
    $section.appendChild($metricsRow);

    return $section;
  }

  export function outcomes(props: OutcomesProps): LandingSection {
    const $section = LandingSection.makeWith({
      paddingY: 80,
      background: "var(--bg)",
      gap: 24,
    });

    $section.appendChild(makeSectionTitle(props.title));

    const $grid = document.createElement("div");
    $grid.style.display = "grid";
    $grid.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
    $grid.style.gap = "16px";

    for (const item of props.items) {
      $grid.appendChild(LandingCard.makeWith({
        kicker: item.index,
        title: item.title,
        description: item.description,
      }));
    }

    $section.appendChild($grid);
    return $section;
  }

  export function securityStrip(props: SecurityStripProps): LandingSection {
    const $section = LandingSection.makeWith({
      paddingY: 56,
      gap: 12,
    });

    $section.appendChild(makeSectionTitle(props.title));

    const $row = makeFlexRow("8px");
    for (const badge of props.badges) {
      $row.appendChild(LandingPill.makeWith({ label: badge, variant: "security" }));
    }
    $section.appendChild($row);

    return $section;
  }

  export function ctaBlock(props: CtaBlockProps): LandingSection {
    const $section = LandingSection.makeWith({
      paddingY: 56,
    });

    const $card = Column.make();
    $card.assignStyles({
      border: "1px solid var(--divider)",
      borderRadius: "12px",
      padding: "22px",
      background: "var(--bg)",
      gap: "10px",
    });

    const $kicker = document.createElement("p");
    $kicker.className = "kicker";
    $kicker.style.setProperty("--margin-bottom", "12px");
    $kicker.style.color = "var(--text-pri)";
    $kicker.textContent = props.kicker;
    $card.appendChild($kicker);

    $card.appendChild(makeSectionTitle(props.title));

    const $copy = document.createElement("p");
    $copy.className = "card-description";
    $copy.style.setProperty("--margin-bottom", "0px");
    $copy.textContent = props.copy;
    $card.appendChild($copy);

    $section.appendChild($card);

    if (props.actions && props.actions.length > 0) {
      const $actionRow = makeFlexRow("8px");
      $actionRow.style.marginTop = "16px";
      for (const action of props.actions) {
        $actionRow.appendChild(LandingPill.makeWith({
          label: action.label,
          variant: "cta",
          primary: action.primary,
          onClick: action.onClick,
        }));
      }
      $section.appendChild($actionRow);
    }

    return $section;
  }
}
