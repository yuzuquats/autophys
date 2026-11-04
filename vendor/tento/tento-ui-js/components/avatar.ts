import "./round";

import { LonaWebComponent, html } from "../component";
import { Center, Div } from "../component-builtin";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { DomUtils } from "../dom";
import { LonaIcons } from "../ui/icons";
import { Typography } from "../ui/typography";
import { Badge } from "./badge";
import { Round } from "./round";
import { Tooltip } from "./tooltip/tooltip";

@component({
  name: "std-avatar",
})
export class Avatar extends LonaWebComponent {
  static makeWith(): Avatar {
    const $a = Avatar.make();
    const $profile = Div.make();
    $profile.style.background = "var(--red)";
    $a.appendChild($profile);
    return $a;
  }

  static makeWithInitials(props: Avatar.Props): Avatar {
    const $a = Avatar.make();
    $a.bind(props);
    return $a;
  }

  bind(props: Avatar.Props): this {
    return this.bindInitials(props);
  }

  bindInitials(props: Avatar.Props): this {
    this.clearChildren();
    // The tooltip child is rebound in place rather than torn down and
    // re-appended: it is a registered element now, and re-creating it on every
    // bind would re-attach its trigger listeners for nothing.
    this.bindTooltipChild(props);

    this.setAttribute("size", props.size ?? "");

    const $round = Round.makeWith({
      bg: props.backgroundColor,
      sideCurvature: props.sideCurvature,
      radius: 100,
      shadow: props.shadow != null ? props.shadow : "0 1px 2px rgba(0,0,0,0.4)",
    });

    // Create center container for avatar content
    const $c = Center.make();
    $c.assignStyles({
      color: props.color,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "100%",
      height: "100%",
    });
    const size = props.size ?? "24";
    $c.appendChild(Avatar.renderAvatarContent(props, size));

    $round.appendChild($c);

    if (props.badge) {
      const $badge = Badge.makeWith(props.badge);
      $badge.slot = "badge";
      $badge.setAttribute("avatar-size", size);
      this.appendChild($badge);
    }

    this.appendChild($round);
    return this;
  }

  private bindTooltipChild(props: Avatar.Props): void {
    const $host = this.$("tooltip");
    const $existing = $host.firstElementChild;
    if (props.tooltip == null) {
      if ($existing != null) DomUtils.clearChildren($host);
      return;
    }
    let $t =
      $existing != null && $existing.tagName === "STD-TOOLTIP"
        ? ($existing as Tooltip)
        : null;
    if ($t == null) {
      DomUtils.clearChildren($host);
      $t = Tooltip.make();
      $host.appendChild($t);
    }
    $t.bind({
      text: props.tooltip,
      placement: props.tooltipPosition ?? "top",
      delayMs: null,
    });
  }

  static makeWithImage(
    url: string,
    badge?: Badge.Props,
    size?: Avatar.Props["size"],
  ): Avatar {
    const $a = Avatar.make();
    const $profile = new Image();
    $profile.src = url;
    const dim = Number.parseInt(size ?? "24");
    $profile.width = dim;
    $profile.height = dim;
    $a.appendChild($profile);

    if (size) {
      $a.setAttribute("size", size);
    }

    if (badge) {
      const $badge = Badge.makeWith(badge);
      $badge.slot = "badge";
      // Pass avatar size to badge for proper positioning
      $badge.setAttribute("avatar-size", size ?? "24");
      $a.appendChild($badge);
    }

    return $a;
  }

  static $styles = [
    css`
      :host {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      :host([size="16"]) {
        --_dim: 16px;
      }
      :host([size="20"]) {
        --_dim: 20px;
      }
      :host([size="24"]) {
        --_dim: 24px;
      }
      :host([size="32"]) {
        --_dim: 32px;
      }
      :host([size="40"]) {
        --_dim: 40px;
      }

      slot::slotted(*) {
        box-sizing: border-box;
        border-radius: 50%;
        height: var(--_dim, 24px);
        width: var(--_dim, 24px);
      }
      ::slotted([slot="badge"]) {
        box-sizing: unset;
        border-radius: unset;
        height: unset;
        width: unset;
      }

      #tooltip {
        z-index: 1;
        position: absolute;
        height: 100%;
        width: 100%;
      }

      #badge-slot {
        position: absolute;
        top: 0;
        right: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> =
    html`<slot></slot><div id=tooltip></div><slot name="badge"></slot>`;
}

export namespace Avatar {
  export type Icon =
    | {
      kind: "svg";
      svg: LonaIcons.RawSvg;
    }
    | {
      kind: "image";
      url: string;
    };

  export interface Props {
    initials: string;
    backgroundColor: string;
    color: string;
    size?: "16" | "20" | "24" | "32" | "40" | undefined;
    icon?: Option<Icon>;
    iconFallback?: "initials" | "empty";
    tooltip?: string | undefined;
    tooltipPosition?: "right" | "left" | "bottom";
    badge?: Badge.Props;
    sideCurvature?: Option<number>;
    shadow?: Option<boolean | string>;
  }

  export namespace Props {
    const AVATAR_COLORS = [
      { bg: "var(--red-dimmed)", text: "var(--text-sec-on-solid)" },
      { bg: "var(--orange-dimmed)", text: "var(--text-sec-on-solid)" },
      { bg: "var(--yellow-dimmed)", text: "var(--text-sec-on-solid)" },
      { bg: "var(--green-dimmed)", text: "var(--text-sec-on-solid)" },
      { bg: "var(--blue-dimmed)", text: "var(--text-sec-on-solid)" },
      { bg: "var(--purple-dimmed)", text: "var(--text-sec-on-solid)" },
      { bg: "var(--teal-dimmed)", text: "var(--text-sec-on-solid)" },
    ];

    function hashString(str: string): number {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
      }
      return Math.abs(hash);
    }

    function extractInitials(username: string): string {
      const parts = username.trim().split(/\s+/);
      if (parts.length >= 2) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      }
      return username.slice(0, 2).toUpperCase();
    }

    export function fromUsername(
      username: string,
      options?: { size?: "16" | "20" | "24" | "32" | "40"; tooltip?: string },
    ): Props {
      const colorIndex = hashString(username) % AVATAR_COLORS.length;
      const color = AVATAR_COLORS[colorIndex];

      return {
        initials: extractInitials(username),
        backgroundColor: color.bg,
        color: color.text,
        size: options?.size,
        tooltip: options?.tooltip ?? username,
      };
    }

    export function custom(
      initials: string,
      backgroundColor: string,
      color: string,
      options?: { size?: "16" | "20" | "24" | "32" | "40"; tooltip?: string },
    ): Props {
      return {
        initials: initials.toUpperCase(),
        backgroundColor,
        color,
        size: options?.size,
        tooltip: options?.tooltip,
      };
    }
  }

  export function renderAvatarContent(
    props: Avatar.Props,
    size: NonNullable<Avatar.Props["size"]>,
  ): HTMLElement {
    if (props.icon == null) {
      if (props.iconFallback === "empty") {
        return Div.make();
      }
      return renderInitials(props.initials, size);
    }

    if (props.icon.kind === "image") {
      const $image = new Image();
      $image.alt = "";
      $image.src = props.icon.url;
      $image.style.objectFit = "contain";
      $image.style.width = "70%";
      $image.style.height = "70%";
      return $image;
    }

    return LonaIcons.make(props.icon.svg, {
      sizePx: avatarIconSizePx(size),
      color: props.color,
    });
  }

  export function renderInitials(
    initials: string,
    size: NonNullable<Avatar.Props["size"]>,
  ): HTMLElement {
    const $profile = Typography.p(initials, "small");
    switch (size) {
      case "16":
        $profile.style.setProperty("--font-size", "var(--text-6px)");
        break;
      case "20":
        $profile.style.setProperty("--font-size", "var(--text-8px)");
        break;
      case "24":
        $profile.style.setProperty("--font-size", "var(--text-9px)");
        break;
      case "32":
      case "40":
        $profile.style.setProperty("--font-size", "var(--text-10px)");
        break;
    }
    return $profile;
  }

  export function avatarIconSizePx(
    size: NonNullable<Avatar.Props["size"]>,
  ): number {
    switch (size) {
      case "16":
        return 12;
      case "20":
        return 14;
      case "24":
        return 16;
      case "32":
        return 18;
      case "40":
        return 22;
    }
  }
}
