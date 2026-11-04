import "@tento-ui/components/round";

import { html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { Style, css } from "@tento-ui/component-styles";
import { Button } from "@tento-ui/components/button/button";
import { Divider } from "@tento-ui/components/divider";
import { Overlay } from "@tento-ui/components/overlay";
import { RadioButtonCell } from "@tento-ui/components/radio-button-cell";
import { Round } from "@tento-ui/components/round";
import { DomUtils } from "@tento-ui/dom";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";
import { LonaModalWebComponent } from "@tento-ui/ui/modal-component";
import { Typography } from "@tento-ui/ui/typography";

export type RecurringEditOption = "this" | "following" | "all";
export type RecurringEditAction = "delete" | "move" | "resize" | "edit";

interface ActionStrings {
  title: string;
  description: string;
  buttonLabel: string;
  thisSubtitle: string;
  followingSubtitle: string;
  allSubtitle: string;
}

const ACTION_STRINGS: Record<RecurringEditAction, ActionStrings> = {
  delete: {
    title: "Delete Recurring Event",
    description: "is a recurring event. What would you like to delete?",
    buttonLabel: "Delete",
    thisSubtitle: "Delete only this occurrence",
    followingSubtitle: "Delete this and all future occurrences",
    allSubtitle: "Delete all occurrences of this event",
  },
  move: {
    title: "Move Recurring Event",
    description: "is a recurring event. What would you like to move?",
    buttonLabel: "Move",
    thisSubtitle: "Move only this occurrence",
    followingSubtitle: "Move this and all future occurrences",
    allSubtitle: "Move all occurrences of this event",
  },
  resize: {
    title: "Resize Recurring Event",
    description: "is a recurring event. What would you like to resize?",
    buttonLabel: "Resize",
    thisSubtitle: "Resize only this occurrence",
    followingSubtitle: "Resize this and all future occurrences",
    allSubtitle: "Resize all occurrences of this event",
  },
  edit: {
    title: "Edit Recurring Event",
    description: "is a recurring event. What would you like to change?",
    buttonLabel: "Save",
    thisSubtitle: "Change only this occurrence",
    followingSubtitle: "Change this and all future occurrences",
    allSubtitle: "Change all occurrences of this event",
  },
};

@component({
  name: "std-recurring-edit-modal",
})
export class RecurringEditModal extends LonaModalWebComponent {
  private $bg: Round = this.hydrate<Round>("bg")
    .bind(Round.Props.MODAL);

  private $radioGroup: RadioButtonCell.Group;
  private $thisCell: RadioButtonCell;
  private $followingCell: RadioButtonCell;
  private $allCell: RadioButtonCell;
  private $thisSubtitle: HTMLElement;
  private $followingSubtitle: HTMLElement;
  private $allSubtitle: HTMLElement;
  private selectedOption: RecurringEditOption = "this";
  private onOption?: ((option: RecurringEditOption) => void) | undefined;
  private onResolve?: ((option: RecurringEditOption | null) => void) | undefined;

  static async show(
    action: RecurringEditAction,
    eventTitle: string,
    onOption: (option: RecurringEditOption) => void,
  ): Promise<void> {
    const $modal = RecurringEditModal.make();
    $modal.bind(action, eventTitle, onOption);
    $modal.reveal();
  }

  /**
   * Awaitable variant of {@link show}: resolves with the chosen option, or
   * `null` when the modal is dismissed/cancelled. Lets a caller hold gesture
   * state alive across the decision — e.g. keep a drag ghost at the dropped
   * position through the prompt instead of snapping it back.
   */
  static prompt(
    action: RecurringEditAction,
    eventTitle: string,
  ): Promise<RecurringEditOption | null> {
    return new Promise<RecurringEditOption | null>((resolve) => {
      const $modal = RecurringEditModal.make();
      let settled = false;
      const settle = (option: RecurringEditOption | null) => {
        if (settled) return;
        settled = true;
        resolve(option);
      };
      // Resolve on the CHOICE itself (the primary button fires `onOption`),
      // not only via `onModalDismiss` — relying on the dismiss hook alone left
      // the promise hanging when the button-dismiss didn't route through it, so
      // the recurring move never ran. Cancel / outside-dismiss resolves null.
      $modal.onResolve = () => settle(null);
      $modal.bind(action, eventTitle, (option) => settle(option));
      $modal.reveal();
    });
  }

  constructor() {
    super();

    const $content = this.$("content");

    {
      this.$thisSubtitle = Typography.p("", "caption").assignStyles({
        color: "var(--text-ter)",
      });
      this.$thisCell = RadioButtonCell.makeWith({
        title: "This event only",
        options: { $subtitle: this.$thisSubtitle },
      });
      this.$thisCell.setAttribute("value", "this");
      this.$thisCell.checked = true;
      $content.appendChild(this.$thisCell);
    }

    {
      this.$followingSubtitle = Typography.p("", "caption").assignStyles({
        color: "var(--text-ter)",
      });
      this.$followingCell = RadioButtonCell.makeWith({
        title: "This and following events",
        options: { $subtitle: this.$followingSubtitle },
      });
      this.$followingCell.setAttribute("value", "following");
      $content.appendChild(this.$followingCell);
    }

    {
      this.$allSubtitle = Typography.p("", "caption").assignStyles({
        color: "var(--text-ter)",
      });
      this.$allCell = RadioButtonCell.makeWith({
        title: "All events",
        options: { $subtitle: this.$allSubtitle },
      });
      this.$allCell.setAttribute("value", "all");
      $content.appendChild(this.$allCell);
    }

    this.$radioGroup = new RadioButtonCell.Group({
      onSelected: (cell) => {
        this.selectedOption = cell.getAttribute("value") as RecurringEditOption;
        return true;
      },
    });
    this.$radioGroup.bind([this.$thisCell, this.$followingCell, this.$allCell]);

    GESTURE_MANAGER.addPointerEvent(this.$("cancel-button"), {
      onClick: () => Overlay.dismiss(this),
    });

    GESTURE_MANAGER.addPointerEvent(this.$("primary-button"), {
      onClick: () => {
        this.onOption?.(this.selectedOption);
        Overlay.dismiss(this);
      },
    });
  }

  bind(
    action: RecurringEditAction,
    eventTitle: string,
    onOption: (option: RecurringEditOption) => void,
  ): this {
    this.onOption = onOption;
    this.selectedOption = "this";
    this.$thisCell.checked = true;
    const strings = ACTION_STRINGS[action];
    this.$("title").textContent = strings.title;
    this.$("description").textContent =
      `"${eventTitle}" ${strings.description}`;
    this.$("primary-button").textContent = strings.buttonLabel;
    this.$thisSubtitle.textContent = strings.thisSubtitle;
    this.$followingSubtitle.textContent = strings.followingSubtitle;
    this.$allSubtitle.textContent = strings.allSubtitle;
    return this;
  }

  onModalDismiss() {
    this.onOption = undefined;
    // Cancel / outside-dismiss path for the awaitable `prompt()` — resolves
    // `null`. (Confirm resolves earlier, via the `onOption` callback, so this
    // is a no-op after a choice; `prompt` guards against a double-resolve.)
    const resolve = this.onResolve;
    this.onResolve = undefined;
    resolve?.(null);
  }

  static $styles: Style.Compat[] = [
    LonaModalWebComponent.$style,
    Divider.$hr,
    Button.$style,
    css`
      :host {
        --std-modal-max-width: 440px;
        --std-modal-min-height: 0px;
        background: var(--bg);
        border-radius: 12px;
      }

      #root {
        height: 100%;
        position: relative;
      }

      #header {
        padding: 20px 20px;
      }

      #title {
        --margin-bottom: 8px;
      }

      #description {
        color: var(--text-sec);
      }

      hr {
        margin: 0;
      }

      #content {
        padding: 20px;
        gap: 8px;
      }

      #footer {
        padding: 12px 20px;
        gap: 12px;
        justify-content: flex-end;
        border-top: 1px solid var(--divider);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-round id=bg floating></std-round>

      <std-col id="header">
        <h1 id="title" class="h6"></h1>
        <p id="description" class=small></p>
      </std-col>
      <hr />
      <std-col id="content">
        <!-- Radio button cells will be added dynamically -->
      </std-col>
      <std-row id="footer">
        <button id="cancel-button">Cancel</button>
        <button id="primary-button" primary></button>
      </std-row>
    </std-col>
  `;
}
