import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { Constants } from "@tento-core/constants";
import { DomUtils } from "../dom";
import { $$ } from "../fastdom";
import { GESTURE_MANAGER } from "../gesture-manager";
import { Typography } from "../ui/typography";
import { Button } from "./button/button";

type TabSelectedCallback<T extends string> = (tab: T) => void;

@component({
  name: "std-button-group-row",
})
export class ButtonGroupRow<T extends string> extends LonaWebComponent {
  onSelected: TabSelectedCallback<T> = Constants.EMPTY_FUNCTION;
  selectedTab: Option<T>;
  private entries: ButtonGroupRow.Item<T>[] = [];
  private resizeObserver = new ResizeObserver(() =>
    this.updateSelectedTabBackground(false),
  );
  private ownerWindow: Option<Window>;

  // NOTE: needed for PIP - disconnect ResizeObserver when page is hidden
  private handlePageHide = () => {
    this.resizeObserver.disconnect();
  };

  connectedCallback() {
    this.ownerWindow = this.ownerDocument.defaultView ?? undefined;
    this.ownerWindow?.addEventListener("pagehide", this.handlePageHide);
    this.resizeObserver.observe(this.$("container"));
  }

  disconnectedCallback() {
    this.ownerWindow?.removeEventListener("pagehide", this.handlePageHide);
    this.resizeObserver.disconnect();
  }

  static makeWith<T extends string>(
    props: ButtonGroupRow.Props<T>,
  ): ButtonGroupRow<T> {
    const $e = ButtonGroupRow.make() as unknown as ButtonGroupRow<T>;
    $e.bind(props.selected, props.entries);
    $e.onSelected = props.onSelected;
    return $e;
  }

  /** Tightens the control for dense surfaces such as popovers and menus. */
  setCompact(compact: boolean = true): this {
    this.toggleAttribute("compact", compact);
    return this;
  }

  bindSelected(selected: T, notify: boolean = true): ButtonGroupRow<T> {
    if (this.selectedTab === selected) return this;

    this.selectedTab = selected;
    for (const $button of this.$qsa("button")) {
      $button.toggleAttribute("selected", false);
      $button.setAttribute("aria-pressed", "false");
    }
    const $button = this.$qs(`button[tab="${selected}"]`);
    $button.toggleAttribute("selected", true);
    $button.setAttribute("aria-pressed", "true");
    this.selectedTab = $button.getAttribute("tab") as T;
    this.$("selected-background").toggleAttribute("no-transition", false);
    this.updateSelectedTabBackground();
    notify && this.onSelected(this.selectedTab);
    return this;
  }

  bind(
    selected: T,
    entries: ButtonGroupRow.Item<T>[],
    onBind: () => void = Constants.EMPTY_FUNCTION,
  ) {
    $$.mutate(() => {
      DomUtils.clearChildren(this.$("button-container"));
    });
    this.selectedTab = selected;
    this.entries = entries;
    for (const entry of this.entries) {
      const $button = Button.makeLight();
      $button.setAttribute("tab", entry.identifier);
      const $text =
        typeof entry.label === "string"
          ? Typography.p(entry.label, "caption")
          : entry.label;
      $button.appendChild($text);
      $button.toggleAttribute("selected", entry.identifier === selected);
      $button.setAttribute(
        "aria-pressed",
        String(entry.identifier === selected),
      );
      GESTURE_MANAGER.addPointerEvent($button, {
        onClick: () => {
          // Pointer gestures suppress the native mouse focus action. Restore
          // button semantics so keyboard input continues from the clicked tab.
          $button.focus({ preventScroll: true });
          this.bindSelected(entry.identifier);
        },
      });
      $$.mutate(() => {
        this.$("button-container").appendChild($button);
      });
    }
    $$.mutateEnd(() => {
      this.style.setProperty("--num-entries", String(this.entries.length));
      this.updateSelectedTabBackground();
      onBind();
    });
  }

  private updateSelectedTabBackground(animate: boolean = true) {
    const $selectedTab = this.$qs_maybe(`[tab="${this.selectedTab}"]`);
    $$.measure(() => {
      if (!$selectedTab) return;
      const left = $selectedTab.offsetLeft;
      const width = $selectedTab.offsetWidth;
      $$.mutate(() =>
        this.$("selected-background").assignStyles({
          width: width - 4 + "px",
          transform: `translate(${left + 2}px, 2px)`,
          display: "block",
          transition: animate ? "" : "none",
        }),
      );
    });
  }

  static $styles = [
    css`
      :host {
        min-height: 32px;
      }
      #container {
        height: inherit;
        min-height: inherit;
        border-radius: 9px;
        background-color: var(--bg-btn-group-underlay, var(--bg-surface-light));
        position: relative;
        width: 100%;
      }
      button {
        border: none;
        background: none;
        cursor: pointer;
        flex-basis: calc(100% / var(--num-entries));
        border-radius: 8px;
        z-index: 1;
        font-family: inherit;
        padding-inline: 16px;
        padding-block: 8px;
      }
      #button-container {
        width: 100%;
      }
      #selected-background {
        position: absolute;
        height: calc(100% - 4px);
        background-color: var(--bg-btn-group-selected, var(--bg-elevated-2));
        box-shadow: 0px 0px 2px 1px rgb(0 0 0 / 12%);
        z-index: 0;
        border-radius: 8px;
        transition: transform 0.3s ease;
        display: none;
      }
      button:hover::after {
        background-color: var(--bg-hover);
      }

      button:focus-visible {
        outline: var(--button-group-focus-outline, 2px solid var(--blue));
        outline-offset: 2px;
      }

      :host([compact]) {
        min-height: 24px;
      }
      :host([compact]) #container {
        border-radius: 6px;
      }
      :host([compact]) button {
        border-radius: 5px;
        padding: 4px 7px;
      }
      :host([compact]) #selected-background {
        border-radius: 5px;
      }
    `,
  ];

  static $html = html`
    <std-row id="container">
      <div id="selected-background"></div>
      <std-row id="button-container"></std-row>
    </std-row>
  `;
}

export namespace ButtonGroupRow {
  export type Props<T extends string> = {
    selected: T;
    entries: Item<T>[];
    onSelected: TabSelectedCallback<T>;
  };

  export type Item<T extends string> = {
    label: string | HTMLElement;
    identifier: T;
  };
}
