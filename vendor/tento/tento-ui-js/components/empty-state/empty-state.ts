import "../icon/icon";

import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { LonaIcons } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { Icon } from "../icon/icon";

// The region that has nothing in it, said well. `std-no-cards-state` is a
// home-card component with product copy; this is the generic block: a title,
// a description, an optional glyph or illustration, and up to two actions as
// `std-button`s. It is `role=status` only when asked — a page with three empty
// regions must not announce three times.
@component({ name: "std-empty-state" })
export class EmptyState extends LonaWebComponent {
  private $art: HTMLElement = this.$("art");
  private $title: HTMLElement = this.$("title");
  private $description: HTMLElement = this.$("description");
  private $actions: HTMLElement = this.$("actions");

  bind(props: EmptyState.Props): this {
    DomUtils.clearChildren(this.$art);
    if (props.$illustration != null) {
      this.$art.appendChild(props.$illustration());
    } else if (props.icon != null) {
      this.$art.appendChild(Icon.makeWith({ svg: props.icon, label: null, size: 32 }));
    }
    this.$art.toggleAttribute("hidden", props.$illustration == null && props.icon == null);

    this.$title.textContent = props.title;
    const description = props.description;
    this.$description.textContent = description ?? "";
    this.$description.toggleAttribute("hidden", description == null);

    DomUtils.clearChildren(this.$actions);
    if (props.primary != null) {
      this.$actions.appendChild(
        Button.makeWith(props.primary.label, { type: "primary", onClick: props.primary.onClick }),
      );
    }
    if (props.secondary != null) {
      this.$actions.appendChild(
        Button.makeWith(props.secondary.label, { type: "secondary", onClick: props.secondary.onClick }),
      );
    }
    this.$actions.toggleAttribute("hidden", props.primary == null && props.secondary == null);

    if (props.announce) this.setAttribute("role", "status");
    else this.removeAttribute("role");
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    DomUtils.clearChildren(this.$art);
    DomUtils.clearChildren(this.$actions);
    this.$title.textContent = "";
    this.$description.textContent = "";
    this.removeAttribute("role");
  }

  static makeWith(props: EmptyState.Props): EmptyState {
    return EmptyState.make().bind(props);
  }

  static $styles = [
    Typography.$style,
    Button.$style,
    css`
      :host {
        --empty-state-max-width: var(--empty-state-max-width-preset, 360px);
        --empty-state-gap: 8px;

        display: flex;
        width: 100%;
        justify-content: center;
      }

      #root {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: var(--empty-state-gap);
        max-width: var(--empty-state-max-width);
        padding: 24px 16px;
      }

      #art {
        color: var(--text-ter);
        margin-bottom: 4px;
      }

      #title {
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-weight: 600;
        color: var(--text-pri);
      }

      #description {
        --margin-top: 0px;
        --margin-bottom: 0px;
        color: var(--text-sec);
      }

      #actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
      }

      #art[hidden],
      #description[hidden],
      #actions[hidden] {
        display: none;
      }
    `,
  ];

  static $html = html`
    <div id="root">
      <div id="art" hidden></div>
      <p id="title"></p>
      <p id="description" hidden></p>
      <div id="actions" hidden></div>
    </div>
  `;
}

export namespace EmptyState {
  export type Action = { label: string; onClick: EmptyFunction };
  export type Props = {
    title: string;
    description: Option<string>;
    icon: Option<LonaIcons.RawSvg>;
    /** Wins over `icon` when both are given. */
    $illustration: Option<() => HTMLElement>;
    primary: Option<Action>;
    secondary: Option<Action>;
    /** `role=status`, so the empty region is announced when it appears. */
    announce: boolean;
  };
}
