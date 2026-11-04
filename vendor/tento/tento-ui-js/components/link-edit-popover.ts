import "./round";

import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Button } from "./button/button";
import { Round } from "./round";

@component({
  name: "std-link-edit-popover",
})
export class LinkEditPopover extends LonaWebComponent {
  #bg = this.hydrate<Round>("bg").bind(Round.Props.MODAL);

  private $urlInput: HTMLInputElement = this.$("url-input") as HTMLInputElement;
  private $openBtn: Button = this.hydrate("open-btn");
  private $saveBtn: Button = this.hydrate("save-btn");
  private $removeBtn: Button = this.hydrate("remove-btn");

  private onOpen?: ((href: string) => void) | undefined;
  private onSave?: ((href: string) => void) | undefined;
  private onRemove?: (() => void) | undefined;

  constructor() {
    super();
    this.$urlInput.addEventListener("keydown", (e) => e.stopPropagation());
    GESTURE_MANAGER.addPointerEvent(this.$openBtn, {
      onClick: () => this.onOpen?.(this.$urlInput.value),
    });
    GESTURE_MANAGER.addPointerEvent(this.$saveBtn, {
      onClick: () => this.onSave?.(this.$urlInput.value),
    });
    GESTURE_MANAGER.addPointerEvent(this.$removeBtn, {
      onClick: () => this.onRemove?.(),
    });
  }

  bind(props: LinkEditPopover.Props): this {
    this.$urlInput.value = props.href;
    this.onOpen = props.onOpen;
    this.onSave = props.onSave;
    this.onRemove = props.onRemove;
    return this;
  }

  static $styles = [
    css`
      :host {
        position: relative;
        display: block;
        padding: 12px;
        min-width: 280px;
      }

      #url-input {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--divider);
        border-radius: 4px;
        background: var(--bg);
        color: var(--text-pri);
        font-size: var(--text-14px);
        margin-bottom: 12px;
        box-sizing: border-box;
      }

      #url-input:focus {
        outline: none;
        border-color: var(--blue);
      }

      #actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
    `,
  ];

  static $html = html`
    <std-round id=bg floating></std-round>
    <input id="url-input" type="text" placeholder="Enter URL..." />
    <std-row id="actions">
      <std-button id="remove-btn" style="secondary">Remove</std-button>
      <std-button id="open-btn" style="secondary">Open</std-button>
      <std-button id="save-btn" style="primary">Save</std-button>
    </std-row>
  `;
}

export namespace LinkEditPopover {
  export interface Props {
    href: string;
    onOpen?: (href: string) => void;
    onSave?: (href: string) => void;
    onRemove?: () => void;
  }
}
