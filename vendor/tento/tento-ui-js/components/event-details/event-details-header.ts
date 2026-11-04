import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { Button } from "../button/button";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LonaIcons, TrashIcon } from "../../ui/icons";

@component({
  name: "std-event-details-header",
})
export class EventDetailsHeader extends LonaWebComponent {
  private $deleteButton: HTMLButtonElement = this.$("delete-button");
  private $editButton: HTMLButtonElement = this.$("edit-button");
  private onToggleCallback?: () => void;
  private onDeleteCallback?: (() => void) | undefined;
  isEditMode: boolean = false;

  constructor() {
    super();
    this.$deleteButton.appendChild(LonaIcons.$svg(TrashIcon));
  }

  static makeWith(props: EventDetailsHeader.Props): EventDetailsHeader {
    const $h = EventDetailsHeader.make();
    $h.bind(props.isEditMode, props.onToggle, props.onDelete);
    return $h;
  }

  bind(
    isEditMode: boolean,
    onToggle: () => void,
    onDelete?: () => void,
  ): EventDetailsHeader {
    this.isEditMode = isEditMode;
    this.onToggleCallback = onToggle;
    this.onDeleteCallback = onDelete;

    this.updateButtonState();

    GESTURE_MANAGER.addPointerEvent(this.$deleteButton, {
      onClick: () => {
        this.onDeleteCallback?.();
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$editButton, {
      onClick: () => {
        this.onToggleCallback?.();
      },
    });

    return this;
  }

  updateButtonState(): void {
    this.$editButton.toggleAttribute("active", this.isEditMode);
  }

  static $styles: Style.Compat[] = [
    Button.$style,
    css`
      #root {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding: 4px 4px;
        margin-bottom: 8px;
        background: var(--bg-surface-light);
        border-radius: 8px;
        gap: 4px;
      }

      #delete-button,
      #edit-button {
        height: 28px;
        padding: 4px 10px;
        border-radius: 8px;
        border: 1px solid var(--divider);
        background: var(--bg);
        color: var(--text-sec);
        cursor: pointer;
        transition: background 0.3s ease, color 0.3s ease, border-color 0.3s ease;
      }

      #edit-label {
        --font-size: var(--small-size, 12px);
      }

      #delete-button {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4px 6px;
      }

      #delete-button svg {
        display: block;
        width: var(--small-size, 12px);
        height: var(--small-size, 12px);
      }

      #delete-button:hover {
        background: var(--red-dimmed);
        color: var(--red);
        border-color: var(--red);
      }

      #edit-button:hover {
        background: var(--bg-hover);
      }

      #edit-button[active] {
        background: var(--blue-dimmed);
        color: var(--blue);
        border-color: var(--blue);
      }

      #delete-button:focus-visible,
      #edit-button:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root">
      <button id="delete-button" type="button" aria-label="Delete event"></button>
      <button id="edit-button" type="button"><span id="edit-label" class="text">Edit</span></button>
    </std-row>
  `;
}

export namespace EventDetailsHeader {
  export type Props = {
    isEditMode: boolean;
    onToggle: () => void;
    onDelete?: () => void;
  };
}
