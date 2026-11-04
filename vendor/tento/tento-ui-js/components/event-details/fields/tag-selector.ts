import { LonaWebComponent, html } from "../../../component";
import { component } from "../../../component-decorators";
import { css, Style } from "../../../component-styles";
import { DomUtils } from "../../../dom";
import { GESTURE_MANAGER } from "../../../gesture-manager";
import { Typography } from "../../../ui/typography";
import { Anchor, AnchorInstance } from "../../anchor";
import { ContextMenu } from "../../context-menu";
import { PillButton } from "../../pill-button";
import { Tooltip } from "../../tooltip/tooltip";
import { Position } from "../../../anchor-positioning-utils";
import { EventDetailsField } from "../event-details-field";

@component({
  name: "std-tag-selector",
})
export class TagSelector<
  TagType extends {
    name: string;
    color(): string;
    colorDimmed?: () => string;
    emoji?: string;
  },
> extends LonaWebComponent {
  private $container: HTMLElement = this.$("container");
  private $tagContent: HTMLElement = this.$("tag-content");
  private $star: HTMLElement = this.$("star");
  private $starTooltip: Tooltip = this.hydrate("star-tooltip");
  private currentTag: TagType | null = null;
  private categorySource: TagSelector.CategorySource = "none";
  private starState: TagSelector.StarState = "off";
  private placeholder: string = "Add tags";
  private editable: boolean = true;
  private onToggleSource: Option<() => void>;
  private onSelectTag: Option<(tag: TagType) => void>;
  private makeTagList: Option<
    (onSelect: (tag: TagType) => void) => HTMLElement
  >;
  private $popover: Option<AnchorInstance>;

  constructor() {
    super();

    this.addPointerEvent({
      onClick: (_capturedElement, _offset, e) => {
        if (e.composedPath().includes(this.$star)) return;
        if (!this.editable) return;
        if (!this.makeTagList) return;
        this.toggleMenu();
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$star, {
      onClick: (_capturedElement, _offset, e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!this.editable) return;
        this.onToggleSource?.();
      },
    });
  }

  private toggleMenu(): void {
    if (this.$popover != null) {
      this.dismissPopover();
      return;
    }
    this.openMenu();
  }

  private dismissPopover(): void {
    const popover = this.$popover;
    this.$popover = null;
    popover?.dismiss();
  }

  // Anchor the tag list to the field itself (absolute, width-matched,
  // scroll-tracked), matching the calendar-list / recurrence pickers — rather
  // than a viewport-fixed context menu placed at a click point.
  private openMenu(): void {
    if (!this.makeTagList) return;
    const $parent = this.parentElement;
    if ($parent == null) return;

    const $builder = ContextMenu.builder(this.offsetWidth);
    const $tagList = this.makeTagList((tag) => {
      this.currentTag = tag;
      this.categorySource = "manual";
      this.starState = "off";
      this.onSelectTag?.(tag);
      this.updateDisplay();
      this.dismissPopover();
    });
    $builder.row($tagList);
    const $menu = $builder.build({ onDismiss: () => {} });

    // Field wrapper is the positioned containing block, so the menu stays glued
    // to the field. Lift its position/overflow and restore on dismiss.
    const prevPosition = $parent.style.position;
    const prevParentOverflow = $parent.style.overflow;
    $parent.style.position = "relative";
    $parent.style.overflow = "visible";

    // The field wrapper sits inside the fields container (FieldContainer), which
    // clips with `overflow: hidden`; an anchor-relative menu that drops below the
    // field gets cut off there. Lift the container's overflow while open.
    const $container = $parent.parentElement;
    const prevContainerOverflow = $container?.style.overflow;
    if ($container != null) $container.style.overflow = "visible";

    this.$popover = Anchor.reveal({
      $anchor: this,
      $content: $menu,
      escapeContainer: false,
      positionRelativeTo: "anchor",
      position: Position.BOTTOM_LEFT_X,
      offset: {
        outer: {
          vertical: 0,
          horizontal: 0,
        },
      },
      onDismiss: () => {
        $parent.style.position = prevPosition;
        $parent.style.overflow = prevParentOverflow;
        if ($container != null) {
          $container.style.overflow = prevContainerOverflow ?? "";
        }
        this.$popover = null;
      },
    });
  }

  static create<
    TagType extends {
      name: string;
      color(): string;
      colorDimmed?: () => string;
      emoji?: string;
    },
  >(
    onSelectTag: (tag: TagType) => void,
    makeTagList: (onSelect: (tag: TagType) => void) => HTMLElement,
    placeholder: string = "Add tags",
  ): TagSelector<TagType> {
    const $e = new TagSelector<TagType>();
    $e.onSelectTag = onSelectTag;
    $e.makeTagList = makeTagList;
    $e.placeholder = placeholder;
    $e.updateDisplay();
    return $e;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    GESTURE_MANAGER.unregister(this.$star);
    this.dismissPopover();
  }

  onRecycle(): void {
    super.onRecycle();
    this.dismissPopover();
  }

  setSourceToggleHandler(onToggle: Option<() => void>): void {
    this.onToggleSource = onToggle;
    this.updateStar();
  }

  bind(tag: Option<TagType>, editable: boolean) {
    this.bindWithSource(tag, editable, tag ? "manual" : "none", "off");
  }

  bindWithSource(
    tag: Option<TagType>,
    editable: boolean,
    categorySource: TagSelector.CategorySource,
    starState: TagSelector.StarState,
  ) {
    this.currentTag = tag ?? null;
    this.categorySource = categorySource;
    this.starState = starState;
    this.editable = editable;
    this.$container.style.cursor = editable ? "pointer" : "default";
    this.updateDisplay();
  }

  private updateDisplay() {
    DomUtils.clearChildren(this.$tagContent);

    if (!this.currentTag) {
      const $placeholder = Typography.p(this.placeholder, "small");
      $placeholder.style.color = "var(--text-ter)";
      this.$tagContent.appendChild($placeholder);
    } else {
      const $pill = PillButton.makeWith(this.currentTag.name, {
        background: this.currentTag.color(),
        ...PillButton.Options.SMALL,
      });
      this.$tagContent.appendChild($pill);
    }
    this.updateStar();
  }

  private updateStar() {
    const disabled = !this.editable || this.onToggleSource == null;
    const tooltip = this.categorySource === "suggested"
      ? "Use manual category"
      : "Use suggested category";
    this.$star.dataset.state = this.starState;
    this.$star.setAttribute("aria-label", tooltip);
    if (disabled) {
      this.$star.setAttribute("aria-disabled", "true");
    } else {
      this.$star.removeAttribute("aria-disabled");
    }
    this.$star.tabIndex = disabled ? -1 : 0;
    this.$starTooltip.bind({ text: tooltip, placement: "left", delayMs: null });
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        width: 100%;
      }

      #container {
        gap: 4px;
        width: 100%;
        align-items: center;
        min-height: 36px;
        padding-inline: 12px;
        cursor: pointer;
      }

      #tag-content {
        align-items: center;
        flex: 1 1 auto;
        min-width: 0;
      }

      #star {
        align-items: center;
        appearance: none;
        background: transparent;
        border-radius: 7px;
        display: flex;
        flex-shrink: 0;
        border: 0;
        color: var(--fg-icon-ter);
        cursor: inherit;
        font: inherit;
        height: 26px;
        justify-content: center;
        margin-left: auto;
        padding: 0;
        pointer-events: auto;
        position: relative;
        transition: background 0.3s ease, color 0.3s ease;
        width: 26px;
      }

      #star:not([aria-disabled="true"]):hover,
      #star:not([aria-disabled="true"]):focus-visible {
        background: var(--bg-hover);
      }

      #star[aria-disabled="true"] {
        pointer-events: none;
      }

      #star svg {
        display: block;
        height: 19px;
        width: 19px;
      }

      #star[data-state="off"] {
        color: var(--fg-icon-ter);
      }

      #star[data-state="ready"] {
        color: var(--fg-icon-sec);
      }

      #star[data-state="suggesting"] {
        color: var(--purple);
      }

      #star .sparkle {
        fill: currentColor;
        stroke: currentColor;
        stroke-linejoin: round;
        stroke-width: 1.5;
      }

      #star-tooltip {
        bottom: auto;
        text-align: center;
        top: 50%;
        transform: translateY(-50%);
        white-space: nowrap;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="container">
      <std-row id="tag-content"></std-row>
      <button id="star" type="button" aria-label="Toggle suggested category">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path class="sparkle" d="M8 15c4.875 0 7-2.051 7-7c0 4.949 2.11 7 7 7c-4.89 0-7 2.11-7 7c0-4.89-2.125-7-7-7ZM2 6.5c3.134 0 4.5-1.318 4.5-4.5c0 3.182 1.357 4.5 4.5 4.5c-3.143 0-4.5 1.357-4.5 4.5c0-3.143-1.366-4.5-4.5-4.5Z"/>
        </svg>
        <std-tooltip id="star-tooltip"></std-tooltip>
      </button>
    </std-row>
  `;
}

export namespace TagSelector {
  export type CategorySource = "none" | "suggested" | "manual";
  export type StarState = "off" | "ready" | "suggesting";
}

export namespace EventDetailsFieldTagSelector {
  export function make<
    TagType extends {
      name: string;
      color(): string;
      colorDimmed?: () => string;
      emoji?: string;
    },
  >(
    onSelectTag: (tag: TagType) => void,
    makeTagList: (onSelect: (tag: TagType) => void) => HTMLElement,
    selectedTag: Option<TagType> = null,
    placeholder: string = "Add tags",
  ): EventDetailsField<TagSelector<TagType>> {
    const $selector = TagSelector.create(onSelectTag, makeTagList, placeholder);
    $selector.bind(selectedTag, true);
    const $field = EventDetailsField.makeWith($selector, { padding: "0px" });
    return $field;
  }
}
