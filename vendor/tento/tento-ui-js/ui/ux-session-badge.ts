import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css, Style } from "../component-styles";
import { Button } from "../components/button/button";
import { Badge } from "../components/badge";
import { GESTURE_MANAGER } from "../gesture-manager";

@component({
  name: "dev-ux-session-badge",
})
export class UxSessionBadge extends LonaWebComponent {
  private $btn = this.hydrate<HTMLButtonElement>("btn");
  private $badge = this.hydrate<Badge>("badge");

  onClick?: () => void;

  bind(props: UxSessionBadge.Props): this {
    this.$badge.bind({ content: props.count, variant: "purple" });
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
      <p>UX Tests</p>
    </button>
    <std-badge id="badge" variant="purple" position="top-right"></std-badge>
  `;
}

export namespace UxSessionBadge {
  export interface Props {
    count: number;
  }
}
