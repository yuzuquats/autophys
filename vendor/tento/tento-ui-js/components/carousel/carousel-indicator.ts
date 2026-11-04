import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { Style, css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { AngleRightIcon, LonaIcons } from "../../ui/icons";

@component({
  name: "std-carousel-indicator",
})
export class CarouselIndicator extends LonaWebComponent {
  private count: number = 0;
  private isExpanded: boolean = false;
  private onToggle?: ((isExpanded: boolean) => void) | undefined;
  private onEdit?: (() => void) | undefined;
  private $chevron: HTMLElement = this.$("chevron");

  constructor() {
    super();
    const $icon = LonaIcons.make(AngleRightIcon, { sizePx: 16 });
    $icon.style.color = "inherit";
    this.$chevron.innerHTML = "";
    this.$chevron.appendChild($icon);
  }

  static makeWith(props: CarouselIndicator.Props): CarouselIndicator {
    const $element = CarouselIndicator.make();
    $element.bind(props);
    return $element;
  }

  bind(props: CarouselIndicator.Props): this {
    this.count = props.count ?? 0;
    this.isExpanded = props.isExpanded ?? false;
    this.onToggle = props.onToggle;
    this.onEdit = props.onEdit;

    this.$("count").textContent = this.count.toString();

    this.updateChevron();

    return this;
  }

  connectedCallback(): void {
    GESTURE_MANAGER.addPointerEvent(this.$("count-btn"), {
      onClick: () => {
        this.isExpanded = !this.isExpanded;
        this.updateChevron();
        this.onToggle?.(this.isExpanded);
      },
    });

    GESTURE_MANAGER.addPointerEvent(this.$("edit-btn"), {
      onClick: () => {
        this.onEdit?.();
      },
    });
  }

  private updateChevron(): void {
    this.$("count-btn").setAttribute("aria-expanded", String(this.isExpanded));
    if (this.isExpanded) {
      this.$chevron.style.transform = "rotate(-90deg)";
    } else {
      this.$chevron.style.transform = "rotate(90deg)";
    }
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: inline-flex;
        gap: 1px;
      }

      .btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: var(--carousel-indicator-bg, var(--bg-surface-light));
        border: none;
        cursor: pointer;
        transition: background 0.3s ease;
      }

      .btn:hover {
        background: var(--carousel-indicator-bg-hover, var(--bg-selected));
      }

      #count-btn {
        border-top-left-radius: 8px;
        border-bottom-left-radius: 8px;
        border-top-right-radius: 2px;
        border-bottom-right-radius: 2px;
        gap: 4px;
      }

      #edit-btn {
        border-top-left-radius: 2px;
        border-bottom-left-radius: 2px;
        border-top-right-radius: 8px;
        border-bottom-right-radius: 8px;
      }

      #count {
        --font-size: var(--text-10px);
        color: var(--carousel-indicator-color, var(--fg-icon-pri));
        font-weight: 500;
      }

      #chevron {
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.3s ease;
        color: var(--carousel-indicator-color, var(--fg-icon-pri));
      }

      .edit-icon {
        width: 16px;
        height: 16px;
        color: var(--carousel-indicator-color, var(--fg-icon-pri));
      }

      .edit-icon svg {
        width: 100%;
        height: 100%;
        stroke: currentColor;
      }

      .btn:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <button class="btn" id="count-btn" aria-expanded="false" aria-label="Toggle items">
      <span id="count">0</span>
      <div id="chevron" aria-hidden="true"></div>
    </button>
    <button class="btn" id="edit-btn" aria-label="Edit items">
      <div class="edit-icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
          />
          <path
            d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
          />
        </svg>
      </div>
    </button>
  `;
}

export namespace CarouselIndicator {
  export interface Props {
    count?: number;
    isExpanded?: boolean;
    onToggle?: (isExpanded: boolean) => void;
    onEdit?: () => void;
  }
}
