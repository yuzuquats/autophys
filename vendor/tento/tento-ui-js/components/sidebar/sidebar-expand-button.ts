import "@tento-ui/components/kbd/kbd";
import "@tento-ui/components/tooltip/tooltip";

import { Kbd } from "@tento-ui/components/kbd/kbd";
import { Tooltip } from "@tento-ui/components/tooltip/tooltip";
import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Button } from "../button/button";

@component({
  name: "std-sidebar-expand-button",
})
export class SidebarExpandButton extends LonaWebComponent {
  private onClick: EmptyFunction = () => {
    const expanded = this.toggleAttribute("revealed");
    this.onToggleExpanded(expanded);
  };

  onToggleExpanded: (expanded: boolean) => void = () => {};

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$("root"), {
      onClick: () => this.onClick(),
    });
    // Static content: the tooltip and its key hint never change, so they are
    // bound once here rather than on every bind.
    this.hydrate<Tooltip>("tip").bind({ text: null, placement: "right", delayMs: null });
    this.hydrate<Kbd>("kbd").bind({ keys: ["cmd", "\\"], platform: null });
  }

  static $styles = [
    Button.$style,
    css`
      button {
        position: relative;
        width: 36px;
        height: 28px;
        color: var(--icon-primary-color);
      }
    `,
    css`
      svg {
        transition: opacity 0.3s ease-in-out;
      }

      #unopened-icon,
      :host([revealed]) #opened-icon {
        opacity: 1;
      }

      #opened-icon,
      :host([revealed]) #unopened-icon {
        opacity: 0;
      }

      button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $icons: string[] = [
    /* xml */ `
    <symbol id="three-horizontal-lines" fill="currentColor" viewBox="0 0 16 16">
      <path fill-rule="evenodd"
        d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z" />
    </symbol>
    <symbol id="double-chevron-right" fill="currentColor" viewBox="0 0 14 14">
      <path
        d="M7 12.025L8.225 13.25L14 7.125L8.225 1L7 2.225L11.55 7.125L7 12.025ZM0 12.025L1.225 13.25L7 7.125L1.225 1L8.56743e-07 2.225L4.55 7.125L0 12.025Z">
      </path>
    </symbol>
  `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <button flat id="root" aria-label="Toggle sidebar">
      <svg
        id="unopened-icon"
        width="20"
        height="20"
        fill="currentColor"
        style="position: absolute; top: 4px; left: 8px"
        aria-hidden="true"
      >
        <use href="#three-horizontal-lines" />
      </svg>
      <svg
        id="opened-icon"
        width="14"
        height="14"
        fill="currentColor"
        style="position: absolute; top: 7px; left: 11px; transform: rotate(180deg)"
        aria-hidden="true"
      >
        <use href="#double-chevron-right" />
      </svg>
      <std-tooltip id="tip">
        <std-col>
          <p style="--margin-bottom:6px;--margin-top:4px;" class="small">
            Toggle sidebar open
          </p>
          <std-kbd id="kbd"></std-kbd>
        </std-col>
      </std-tooltip>
    </button>
  `;
}
