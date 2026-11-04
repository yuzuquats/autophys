import "@tento-ui/components/round";

import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Round } from "@tento-ui/components/round";
import { DomUtils } from "@tento-ui/dom";
import { mutate } from "@tento-ui/fastdom";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";

export type SidebarTabs = "tasks" | "sheets" | "home";

@component({
  name: "std-sidebar-action-bar",
})
export class SidebarActionBar extends LonaWebComponent {
  private $container = this.$("cta-container");
  private actions: SidebarActionBar.Action[] = [];
  private selectedId: Option<string> = undefined;

  private $bg = this.hydrate<Round>("bg")
    .bind({
      ...Round.Props.MODAL,
      bg: "var(--bg-elevated)",
    });

  bind(props: SidebarActionBar.Props): this {
    this.actions = props.actions;
    this.selectedId = props.selectedId;
    this.renderActions();
    // Default-hidden until revealed: keep it out of the focus order /
    // accessibility tree so it isn't tabbable while invisible.
    this.inert = !this.hasAttribute("reveal");
    return this;
  }

  @mutate
  private renderActions(): void {
    DomUtils.clearChildren(this.$container);

    for (let i = 0; i < this.actions.length; i++) {
      const action = this.actions[i];
      const $wrapper = document.createElement("div");
      $wrapper.className = "action-bar-nav-button";
      $wrapper.setAttribute("data-action-id", action.id);

      if (action.id === this.selectedId) {
        $wrapper.setAttribute("selected", "");
      }

      $wrapper.appendChild(action.$icon);

      GESTURE_MANAGER.addPointerEvent($wrapper, {
        onClick: () => {
          this.setSelected(action.id);
          action.onClick?.();
        },
      });

      if (i < this.actions.length - 1) {
        $wrapper.style.marginRight = "8px";
      }

      this.$container.appendChild($wrapper);
    }
  }

  @mutate
  setSelected(actionId: string): void {
    this.selectedId = actionId;
    DomUtils.setSelected(
      this.$qsa(".action-bar-nav-button"),
      ($e) => $e.getAttribute("data-action-id") === actionId,
    );
  }

  toggleReveal(force: boolean, animate: boolean): void {
    this.toggleAttribute("reveal", force);
    // Hidden action bar must be inert: not focusable, not in the a11y tree.
    this.inert = !force;
  }

  static $styles = [
    css`
      :host([reveal]) {
        opacity: 1;
      }

      :host {
        opacity: 0;
        pointer-events: none;
        position: relative;
        display: flex;
        justify-content: center;
        width: 100%;
        transition: transform 0.3s ease, opacity 0.3s ease;
      }

      #root {
        width: min-content;
        pointer-events: all;
        position: relative;
      }

      .action-bar-nav-button {
        position: relative;
        cursor: pointer;
      }

      .action-bar-nav-button[selected],
      .action-bar-nav-button:hover {
        background-color: transparent;
      }

      .action-bar-nav-button[selected]:after,
      .action-bar-nav-button:hover:after {
        position: absolute;
        content: "";
        inset: -4px;
        background: var(--bg-surface-light);
        border-radius: 8px;
        cursor: pointer;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <div id=root>
      <std-round id=bg floating></std-round>
      <std-row id="cta-container" style="padding: 12px 12px"></std-row>
    </div>
  `;
}

export namespace SidebarActionBar {
  export type Action = {
    id: string;
    $icon: HTMLElement;
    onClick?: () => void;
  };

  export type Props = {
    actions: Action[];
    selectedId?: Option<string>;
  };
}
