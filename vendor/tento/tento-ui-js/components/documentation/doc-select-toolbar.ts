import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";

// ── Selection mini-toolbar ───────────────────────────────────────────────────

@component({ name: "std-doc-select-toolbar" })
export class SelectToolbar extends LonaWebComponent {
  private $comment: HTMLElement = this.$("comment");

  private onComment: Option<EmptyFunction> = null;

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$comment, {
      onClick: () => this.onComment?.(),
    });
  }

  bind(vm: SelectToolbar.ViewModel): void {
    this.onComment = vm.onComment;
  }

  positionAt(left: number, top: number): void {
    this.style.position = "fixed";
    this.style.left = `${Math.max(4, left)}px`;
    this.style.top = `${Math.max(4, top)}px`;
    this.style.transform = "translateY(-100%)";
  }

  onRecycle(): void {
    super.onRecycle();
    this.onComment = null;
  }

  static $styles = [
    css`
      :host {
        display: flex;
        gap: 4px;
        z-index: 2147483000;
        padding: 4px;
        border-radius: 10px;
        border: 1px solid var(--divider);
        background: var(--bg-elevated);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      }

      button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        border-radius: 7px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-pri);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }

      button:hover {
        background: var(--hover-color);
      }

      .glyph {
        font-size: 13px;
        line-height: 1;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <button id="comment" type="button"><span class="glyph">💬</span>Comment</button>
  `;
}

export namespace SelectToolbar {
  export interface ViewModel {
    onComment: EmptyFunction;
  }
}
