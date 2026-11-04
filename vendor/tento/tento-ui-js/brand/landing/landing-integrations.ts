import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";

@component({ name: "std-landing-integrations" })
export class LandingIntegrations extends LonaWebComponent {
  private $heading: HTMLElement = this.$("heading");
  private $logos: HTMLElement = this.$("logos");

  static makeWith(props: LandingIntegrations.Props): LandingIntegrations {
    return (LandingIntegrations.make() as LandingIntegrations).bind(props);
  }

  bind(props: LandingIntegrations.Props): this {
    DomUtils.clearChildren(this.$logos);

    const heading = props.heading ?? "integrations";
    this.$heading.textContent = heading;
    this.$logos.setAttribute(
      "aria-label",
      `${heading}: ${props.integrations.map((integration) => integration.name).join(", ")}`,
    );

    for (const integration of props.integrations) {
      this.$logos.appendChild(this.$logo(integration));
    }

    return this;
  }

  private $logo(integration: LandingIntegrations.Integration): HTMLElement {
    const $logo = document.createElement("span");
    $logo.className = "logo";
    $logo.setAttribute("aria-label", integration.name);

    if (integration.logoUrl) {
      const $image = document.createElement("img");
      $image.alt = "";
      $image.className = "logo-image";
      $image.decoding = "async";
      $image.loading = "lazy";
      $image.setAttribute("fetchpriority", "low");
      $image.src = integration.logoUrl;
      $image.addEventListener("error", () => {
        $image.remove();
        $mark.textContent = this.$initials(integration.name);
      });
      const $mark = document.createElement("span");
      $mark.className = "logo-mark";
      $mark.setAttribute("aria-hidden", "true");
      $mark.appendChild($image);
      $logo.appendChild($mark);
    } else {
      const $mark = document.createElement("span");
      $mark.className = "logo-mark";
      $mark.setAttribute("aria-hidden", "true");
      $mark.textContent = this.$initials(integration.name);
      $logo.appendChild($mark);
    }

    const $name = document.createElement("span");
    $name.className = "logo-name";
    $name.textContent = integration.name;
    $logo.appendChild($name);

    return $logo;
  }

  private $initials(name: string): string {
    return name
      .split(" ")
      .filter((part) => part.length > 0)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  static $styles = [
    css`
      :host {
        display: block;
      }

      #shell {
        display: grid;
        justify-items: center;
        gap: 34px;
        text-align: center;
      }

      #heading {
        --margin-top: 0px;
        --margin-bottom: 0px;
        --font-size: var(--text-14px);
        --line-height-ratio: 1.52;
        color: var(--text-sec);
        font-family: inherit;
        font-weight: 520;
      }

      #logos {
        display: flex;
        align-items: center;
        justify-content: center;
        width: min(100%, 760px);
        gap: 22px 30px;
        flex-wrap: wrap;
      }

      .logo {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        min-width: 0;
        height: 32px;
        gap: 8px;
        color: var(--text-ter);
        font-family: inherit;
        opacity: 0.7;
      }

      .logo-mark {
        display: inline-grid;
        place-items: center;
        flex: 0 0 24px;
        width: 24px;
        height: 24px;
        color: var(--text-ter);
        font-weight: 760;
        --font-size: var(--text-7px);
        --line-height-ratio: 1;
      }

      .logo-image {
        display: block;
        width: 24px;
        height: 24px;
        filter: grayscale(1) contrast(0.8);
        object-fit: contain;
      }

      .logo-name {
        --font-size: var(--text-9px);
        --line-height-ratio: 1;
        color: var(--text-sec);
        font-weight: 690;
        white-space: nowrap;
      }

      @media (max-width: 768px) {
        #shell {
          justify-items: start;
          text-align: left;
        }

        #logos {
          justify-content: flex-start;
          gap: 16px 22px;
        }
      }
    `,
  ];

  static $html = html`
    <section
      id="shell"
      data-analytics-scroll-point="true"
      data-analytics-name="HomepageLogoWall"
    >
      <p id="heading"></p>
      <div id="logos"></div>
    </section>
  `;
}

export namespace LandingIntegrations {
  export type Integration = {
    name: string;
    logoUrl?: Option<string>;
  };

  export type Props = {
    heading?: Option<string>;
    integrations: Integration[];
  };
}
