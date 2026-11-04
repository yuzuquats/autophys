import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Typography } from "../ui/typography";

@component({
  name: "std-badge",
})
export class Badge extends LonaWebComponent {
  static makeWith(props: Badge.Props): Badge {
    const $badge = Badge.make();
    $badge.bind(props);
    return $badge;
  }

  bind(props: Badge.Props): this {
    this.setAttribute("variant", props.variant ?? "");
    this.setAttribute("position", props.position ?? "top-right");
    return this.bindContent(props.content);
  }

  bindContent(content: Option<string | number | HTMLElement>): this {
    this.clearChildren();

    if (content == null || content === "") return this;
    if (typeof content === "string" || typeof content === "number") {
      const $text = Typography.small(String(content));
      $text.style.color = "var(--badge-text-color, var(--text-sec-on-solid))";
      $text.style.setProperty("--font-size", "var(--text-6px)");
      this.appendChild($text);
      return this;
    }

    this.appendChild(content);
    return this;
  }

  static $styles = [
    css`
      :host {
        position: absolute;
        width: 0;
        height: 0;
        z-index: 1;
        pointer-events: none;
      }

      /* Wrapper positions the origin point (0,0) on the avatar's arc */
      #wrapper {
        position: absolute;
        width: 0;
        height: 0;
        transform: translate(var(--wrapper-x, 0), var(--wrapper-y, 0));
      }

      /* Inner badge is pre-positioned so its left semicircle center (or dot center)
         aligns with the wrapper's origin (0,0) */
      #inner {
        position: absolute;
        min-width: 12px;
        height: 12px;
        padding: var(--badge-padding, 0px 4px);
        border-radius: 6px;
        background: var(--badge-bg, var(--red));
        box-shadow: 0 0 0 1.5px var(--badge-shadow, var(--bg));

        /* Pre-position: move badge so left semicircle center is at origin */
        /* For pill: left edge at -6px, top at -6px (semicircle center at 0,0) */
        left: -6px;
        top: -6px;
      }

      /* For dot variant, adjust the pre-positioning */
      :host([variant="dot"]) #inner {
        min-width: 6px;
        height: 6px;
        padding: 0;
        /* For dot: center at origin, so left edge at -3px, top at -3px */
        left: -3px;
        top: -3px;
      }

      :host([variant="dot"]) #inner > * {
        display: none;
      }

      /* Avatar size-specific wrapper transforms
       * Position wrapper origin at 45° arc point: (r×cos45, -r×cos45)
       * Transform from host position (r, -r) to target: (r×cos45-r, -r×cos45+r)
       * Simplified: (r×(cos45-1), r×(1-cos45)) ≈ (r×-0.293, r×0.293)
       */
      :host([avatar-size="16"]) {
        --wrapper-x: -2.343px;
        --wrapper-y: 2.343px;
      }

      :host([avatar-size="20"]) {
        --wrapper-x: -2.929px;
        --wrapper-y: 2.929px;
      }

      :host([avatar-size="24"]) {
        --wrapper-x: -3.515px;
        --wrapper-y: 3.515px;
      }

      :host([avatar-size="32"]) {
        --wrapper-x: -4.686px;
        --wrapper-y: 4.686px;
      }

      :host([avatar-size="40"]) {
        --wrapper-x: -5.858px;
        --wrapper-y: 5.858px;
      }

      /* Position host at avatar corners */
      :host([position="top-right"]) { top: 0; right: 0; }
      :host([position="top-left"]) { top: 0; left: 0; }
      :host([position="bottom-right"]) { bottom: 0; right: 0; }
      :host([position="bottom-left"]) { bottom: 0; left: 0; }

      /* Adjust wrapper transforms for different corner positions */
      :host([position="top-left"]) #wrapper {
        transform: translate(calc(-1 * var(--wrapper-x)), var(--wrapper-y));
      }

      :host([position="bottom-right"]) #wrapper {
        transform: translate(var(--wrapper-x), calc(-1 * var(--wrapper-y)));
      }

      :host([position="bottom-left"]) #wrapper {
        transform: translate(calc(-1 * var(--wrapper-x)), calc(-1 * var(--wrapper-y)));
      }

      :host([variant="success"]) #inner {
        --badge-bg: var(--green);
      }

      :host([variant="warning"]) #inner {
        --badge-bg: var(--yellow);
      }

      :host([variant="error"]) #inner {
        --badge-bg: var(--red);
      }

      :host([variant="info"]) #inner {
        --badge-bg: var(--blue);
      }

      :host([variant="purple"]) #inner {
        --badge-bg: var(--purple);
      }

      :host([variant="default"]) #inner {
        --badge-bg: var(--gray);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="wrapper">
      <std-center id="inner">
        <slot></slot>
      </std-center>
    </div>
  `;
}

export namespace Badge {
  export interface Props {
    content?: Option<string | number | HTMLElement>;
    variant?:
      | "default"
      | "success"
      | "warning"
      | "error"
      | "info"
      | "purple"
      | "dot"
      | "orange";
    position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  }
}
