import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css, Style } from "../component-styles";
import { Button } from "../components/button/button";
import { Badge } from "../components/badge";
import { GESTURE_MANAGER } from "../gesture-manager";

@component({
  name: "dev-ux-flaky-badge",
})
export class UxFlakyBadge extends LonaWebComponent {
  private $btn = this.hydrate<HTMLButtonElement>("btn");
  private $badge = this.hydrate<Badge>("badge");

  onClick?: () => void;

  bind(props: UxFlakyBadge.Props): this {
    this.$badge.bind({ content: props.count, variant: "orange" });
    return this;
  }

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$btn, {
      onClick: () => this.onClick?.(),
    });
  }

  static $styles: Style.Compat[] = [
    Button.$style,
    css`
      :host {
        position: relative;
        display: flex;
        margin-right: 8px;
      }

      #btn {
        --font-size: var(--h6-size);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <button id="btn" secondary>
      <p>Flaky</p>
    </button>
    <std-badge id="badge" variant="orange" position="top-right"></std-badge>
  `;
}

export namespace UxFlakyBadge {
  export interface Props {
    count: number;
  }
}
