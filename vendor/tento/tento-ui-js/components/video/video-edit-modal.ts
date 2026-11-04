import "../disclaimer";
import "../round";

import { html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { DomUtils } from "../../dom";
import { Button } from "../button/button";
import { Disclaimer } from "../disclaimer";
import { EditableText } from "../editable-text";
import { IconButton } from "../icon-button";
import { Overlay } from "../overlay";
import { Prompt } from "../prompt";
import { Round } from "../round";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { LonaIcons, TrashIcon } from "../../ui/icons";
import { Typography } from "../../ui/typography";
import { LonaModalWebComponent } from "../../ui/modal-component";
import { YoutubeUrl } from "./youtube-url";

@component({
  name: "std-video-edit-modal",
})
export class VideoEditModal extends LonaModalWebComponent {
  private $bg: Round = this.hydrate<Round>("bg")
    .bind(Round.Props.MODAL);

  private $disclaimer: Disclaimer = this.hydrate<Disclaimer>("disclaimer");
  private $addBtn: HTMLButtonElement = this.$<HTMLButtonElement>("add-btn");
  private $saveBtn: HTMLButtonElement = this.$<HTMLButtonElement>("save-btn");

  private urlInputs: EditableText[] = [];
  private onSave?: (urls: string[]) => void;
  private maxUrls: number = 10;
  private initialUrls: string[] = [];
  private initialInputCount: number = 0;

  static makeWith(props: VideoEditModal.Props): VideoEditModal {
    const modal = VideoEditModal.make();
    modal.bind(props);
    return modal;
  }

  bind(props: VideoEditModal.Props): this {
    this.onSave = props.onSave;
    this.maxUrls = props.maxUrls ?? 10;
    this.initialUrls = props.urls.slice(0, this.maxUrls);

    this.$("title").textContent = `Edit Videos for ${props.date}`;

    DomUtils.clearChildren(this.$("list-container"));
    this.urlInputs = [];

    const urlsToShow = props.urls.slice(0, this.maxUrls);
    for (const url of urlsToShow) this.addVideoRow(url);
    if (urlsToShow.length === 0) this.addVideoRow();

    this.initialInputCount = this.urlInputs.length;

    this.updateMaxUrlState();
    this.updateSaveButtonState();
    this.setupButtons();

    return this;
  }

  reveal(
    $overlay: Overlay = Overlay.instance.get(),
    context: Option<string> = undefined,
  ): void {
    $overlay.reveal(this, {
      canDismiss: () => this.canDismiss(),
      position: null,
    });
    $overlay.setContext(context);
  }

  private async canDismiss(): Promise<boolean> {
    const currentUrls = this.urlInputs
      .map((input) => (input.text ?? "").trim())
      .filter((url) => url.length > 0);

    const hasUrlChanges = this.hasUrlChanges(currentUrls);
    const hasInputCountChange =
      this.urlInputs.length !== this.initialInputCount;

    if (!hasUrlChanges && !hasInputCountChange) {
      return true;
    }

    const result = await Prompt.Alert.show(
      {
        title: "Unsaved Changes",
        description:
          "You have unsaved changes. Are you sure you want to discard them?",
        type: "destructive",
      },
      this.$childOverlay.get(),
    );

    return result.didComplete();
  }

  private setupButtons(): void {
    GESTURE_MANAGER.addPointerEvent(this.$addBtn, {
      onClick: () => {
        if (this.urlInputs.length >= this.maxUrls) return;
        const $input = this.addVideoRow();
        $input.enableEditing(true);
        this.updateSaveButtonState();
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$("cancel-btn"), {
      onClick: async () => {
        if (await this.canDismiss()) {
          Overlay.dismiss(this);
        }
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$("save-btn"), {
      onClick: () => this.handleSave(),
    });
  }

  private handleSave(): void {
    const urls = this.urlInputs
      .map((input) => (input.text ?? "").trim())
      .filter((url) => url.length > 0);
    this.onSave?.(urls);
    Overlay.dismiss(this);
  }

  private addVideoRow(url: string = ""): EditableText {
    const $container = document.createElement("std-col");
    $container.assignStyles({ gap: "4px" });

    const $row = document.createElement("std-row");
    $row.assignStyles({ gap: "4px", alignItems: "center" });

    const $input = EditableText.make();
    $input.classList.add("url-row");
    $input.bind(url, "YouTube URL", false);
    $input.enableEditing(false);
    this.urlInputs.push($input);

    const $errorText = this.createErrorText();
    const validateUrl = () => this.validateUrl($input, $errorText);

    $input.controller.onTextChange = validateUrl;
    validateUrl();

    const $deleteBtn = this.createDeleteButton($input, $container);

    $row.appendChild($input);
    $row.appendChild($deleteBtn);
    $container.appendChild($row);
    $container.appendChild($errorText);
    this.$("list-container").appendChild($container);

    this.updateMaxUrlState();

    return $input;
  }

  private createErrorText(): HTMLElement {
    const $errorText = Typography.small("");
    $errorText.assignStyles({
      color: "var(--red)",
      paddingLeft: "8px",
      display: "none",
    });
    return $errorText;
  }

  private validateUrl($input: EditableText, $errorText: HTMLElement): void {
    const text = ($input.text ?? "").trim();

    if (text.length === 0) {
      $errorText.style.display = "none";
      $input.classList.remove("error");
      this.updateSaveButtonState();
      return;
    }

    const isValid = YoutubeUrl.couldBeValid(text);
    if (isValid) {
      $errorText.style.display = "none";
      $input.classList.remove("error");
    } else {
      $errorText.textContent = "Invalid YouTube URL";
      $errorText.style.display = "";
      $input.classList.add("error");
    }
    this.updateSaveButtonState();
  }

  private createDeleteButton(
    $input: EditableText,
    $container: HTMLElement,
  ): IconButton {
    return IconButton.makeWith({
      content: LonaIcons.$svg(TrashIcon),
      sizePx: 28,
    }).addPointerEvent({
      onClick: async () => {
        const result = await Prompt.Alert.show(
          {
            title: "Delete Video",
            description: "Are you sure you want to delete this video URL?",
            type: "destructive",
          },
          this.$childOverlay.get(),
        );
        if (!result.didComplete()) return;

        const index = this.urlInputs.indexOf($input);
        if (index > -1) {
          this.urlInputs.splice(index, 1);
        }
        $container.remove();
        this.updateMaxUrlState();
        this.updateSaveButtonState();
      },
    });
  }

  private updateMaxUrlState(): void {
    const isAtMax = this.urlInputs.length >= this.maxUrls;

    this.$addBtn.disabled = isAtMax;
    this.$disclaimer.style.display = isAtMax ? "" : "none";

    if (isAtMax) {
      this.$disclaimer.bind(`Maximum ${this.maxUrls} videos reached`);
    }
  }

  private updateSaveButtonState(): void {
    const currentUrls = this.urlInputs
      .map((input) => (input.text ?? "").trim())
      .filter((url) => url.length > 0);

    const hasChanges = this.hasUrlChanges(currentUrls);
    this.$saveBtn.disabled = !hasChanges;
  }

  private hasUrlChanges(currentUrls: string[]): boolean {
    if (currentUrls.length !== this.initialUrls.length) {
      return true;
    }

    const sortedCurrent = [...currentUrls].sort();
    const sortedInitial = [...this.initialUrls].sort();

    for (let i = 0; i < sortedCurrent.length; i++) {
      if (sortedCurrent[i] !== sortedInitial[i]) {
        return true;
      }
    }

    return false;
  }

  static $styles: Style.Compat[] = [
    LonaModalWebComponent.$headerStyle,
    LonaModalWebComponent.$style,
    Button.$style,
    css`
      :host {
        --std-modal-max-width: 480px;
        position: relative;
      }

      #root {
        position: relative;
        height: min-content;
        min-height: unset;
      }

      #list-container {
        gap: 4px;
        margin-bottom: 4px;
      }

      .url-row {
        position: relative;
        --padding-block: 10px;
        --padding-inline: 8px;
        cursor: text;
        flex: 1;
      }

      .url-row::after {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 8px;
        border: 1px solid var(--divider);
        transition: border 0.3s ease;
        pointer-events: none;
      }

      .url-row:hover::after {
        border: 1px solid var(--blue);
      }

      .url-row.error::after {
        border: 1px solid var(--red);
      }

      #content {
        padding: 12px;
        flex-grow: 1;
        overflow-y: auto;
        max-height: 240px;
      }

      #footer {
        padding: 12px 16px;
        border-top: 1px solid var(--divider);
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-round floating id=bg></std-round>

      <std-col id="header" class=modal-header>
        <h3 id="title" class="h6 modal-title"></h3>
      </std-col>

      <std-col id=content>
        <std-col id="list-container"></std-col>
        <std-disclaimer id="disclaimer" style="display: none; margin-top: 8px;margin-bottom:4px;"></std-disclaimer>
        <button id="add-btn" secondary>+ Add Video</button>
      </std-col>

      <std-row id="footer">
        <button id="cancel-btn" secondary>Cancel</button>
        <button id="save-btn" primary>Save</button>
      </std-row>
    </std-col>
    <slot></slot>
  `;
}

export namespace VideoEditModal {
  export interface Props {
    date: string;
    urls: string[];
    onSave: (urls: string[]) => void;
    maxUrls?: Option<number>;
  }
}
