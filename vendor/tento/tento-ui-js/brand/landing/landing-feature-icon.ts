import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaCardIcon } from "../../components/icons/card-icon";
import { LonaChartIcon } from "../../components/icons/chart-icon";
import { LonaChatIcon } from "../../components/icons/chat-icon";
import { LonaGlobeIcon } from "../../components/icons/globe-icon";
import { LonaHeartIcon } from "../../components/icons/heart-icon";
import { LonaLinkIcon } from "../../components/icons/link-icon";
import { LonaSearchIcon } from "../../components/icons/search-icon";
import { SheetsIcon } from "../../components/icons/sheets-icon";
import { LonaStickerIcon } from "../../components/icons/sticker-icon";
import { TasksIcon } from "../../components/icons/tasks-icon";
import { CloudIcon, LonaIcons, SparkleIcon } from "../../ui/icons";

@component({ name: "std-landing-feature-icon" })
export class LandingFeatureIcon extends LonaWebComponent {
  private static readonly SIZE = 34;

  private $root: HTMLElement = this.$("root");

  static makeWith(props: LandingFeatureIcon.Props): LandingFeatureIcon {
    return (LandingFeatureIcon.make() as LandingFeatureIcon).bind(props);
  }

  bind(props: LandingFeatureIcon.Props): this {
    DomUtils.clearChildren(this.$root);
    this.$root.appendChild(LandingFeatureIcon.$icon(props.kind));
    this.setAttribute("kind", props.kind);
    return this;
  }

  private static $icon(kind: LandingFeatureIcon.Kind): HTMLElement {
    const props = {
      variant: "filled" as const,
      size: LandingFeatureIcon.SIZE,
    };

    switch (kind) {
      case "calendar":
        return LonaCardIcon.makeWith(props);
      case "chart":
        return LonaChartIcon.makeWith(props);
      case "chat":
        return LonaChatIcon.makeWith(props);
      case "focus":
        return LandingFeatureIcon.$rawIcon(SparkleIcon, "var(--purple)");
      case "heart":
        return LonaHeartIcon.makeWith(props);
      case "link":
        return LonaLinkIcon.makeWith(props);
      case "lightning":
        return LandingFeatureIcon.$rawIcon(SparkleIcon, "var(--yellow)");
      case "rows":
        return SheetsIcon.makeWith(props);
      case "search":
        return LonaSearchIcon.makeWith(props);
      case "sticker":
        return LonaStickerIcon.makeWith(props);
      case "tasks":
        return TasksIcon.makeWith(props);
      case "timezone":
        return LonaGlobeIcon.makeWith(props);
      case "weather":
        return LandingFeatureIcon.$rawIcon(CloudIcon, "var(--blue)");
    }
  }

  private static $rawIcon(
    icon: LonaIcons.RawSvg,
    background: string,
  ): HTMLElement {
    const $tile = document.createElement("div");
    $tile.className = "raw-icon-tile";
    $tile.assignStyles({
      background,
    });
    $tile.appendChild(LonaIcons.make(icon, {
      color: "var(--bg)",
      sizePx: 18,
    }));
    return $tile;
  }

  static $styles = [
    css`
      :host {
        display: block;
        width: fit-content;
      }

      #root {
        display: block;
      }

      .raw-icon-tile {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        border-radius: 8px;
      }
    `,
  ];

  static $html = html`<div id="root"></div>`;
}

export namespace LandingFeatureIcon {
  export type Kind =
    | "calendar"
    | "chart"
    | "chat"
    | "focus"
    | "heart"
    | "link"
    | "lightning"
    | "rows"
    | "search"
    | "sticker"
    | "tasks"
    | "timezone"
    | "weather";

  export type Props = {
    kind: Kind;
  };

  export function renderer(kind: Option<string>): Option<() => HTMLElement> {
    const normalized = normalize(kind);
    return normalized == null
      ? null
      : () => LandingFeatureIcon.makeWith({ kind: normalized });
  }

  export function normalize(kind: Option<string>): Option<Kind> {
    switch (kind) {
      case "calendar":
      case "chart":
      case "chat":
      case "focus":
      case "heart":
      case "link":
      case "lightning":
      case "rows":
      case "search":
      case "sticker":
      case "tasks":
      case "timezone":
      case "weather":
        return kind;
      default:
        return null;
    }
  }
}
