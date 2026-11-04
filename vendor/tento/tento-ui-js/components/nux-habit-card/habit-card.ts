import "@tento-ui/component-builtin";
import "@tento-ui/components/page-indicator-dots";
import "@tento-ui/components/disclaimer";

import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { Carousel } from "@tento-ui/components/carousel/carousel";
import { PageIndiciatorDots } from "@tento-ui/components/page-indicator-dots";
import { Disclaimer } from "@tento-ui/components/disclaimer";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";
import { Column } from "@tento-ui/component-builtin";
import { Typography } from "@tento-ui/ui/typography";
import { Button } from "@tento-ui/components/button/button";
import { ArrowDownIcon, LonaIcons } from "@tento-ui/ui/icons";

const HABITS = [
  { emoji: "🏃", label: "Exercise", image: "/@/static/img/ill/exercise@2x.png" },
  { emoji: "📖", label: "Reading", image: "/@/static/img/ill/reading@2x.png" },
  { emoji: "🧘", label: "Meditation", image: "/@/static/img/ill/meditation@2x.png" },
  { emoji: "💧", label: "Hydration", image: "/@/static/img/ill/hydration@2x.png" },
  { emoji: "😴", label: "Sleep", image: "/@/static/img/ill/sleep@2x.png" },
];

@component({ name: "std-nux-habit-card" })
export class NuxHabitCard extends LonaWebComponent {
  private $carouselContainer: HTMLElement = this.$("carousel-container");
  private $prevBtn: HTMLElement = this.$("prev-btn");
  private $nextBtn: HTMLElement = this.$("next-btn");
  private $dots: PageIndiciatorDots = this.hydrate("dots");
  private $disclaimer: Disclaimer = this.hydrate("disclaimer");
  private $addBtn: HTMLElement = this.$("add-btn");

  private carousel: Carousel = Carousel.make();
  private onAddHabit: Option<
    (habit: { emoji: string; label: string; image: string }) => void
  > = null;

  static makeWith(callbacks?: NuxHabitCard.Callbacks): NuxHabitCard {
    return NuxHabitCard.make().bind(callbacks);
  }

  bind(callbacks?: NuxHabitCard.Callbacks): this {
    this.onAddHabit = callbacks?.onAddHabit ?? null;

    const $cells = HABITS.map(this.createCell.bind(this));

    // Bind dots first before carousel to avoid race condition
    this.$dots.bind(0, HABITS.length);
    this.$dots.onChange = (idx) => {
      this.carousel.setPage(idx);
    };

    this.carousel.assignStyles({
      width: "100%",
      height: "100%",
    });
    this.$carouselContainer.appendChild(this.carousel);

    this.carousel.domBind($cells, $cells.length, {
      onScroll: (_from, to) => {
        this.$dots.bindSelectedIndex(Math.round(to));
      },
    });

    this.$disclaimer.bind("Track daily habits and build streaks");

    this.$prevBtn.appendChild(
      LonaIcons.make(ArrowDownIcon, { sizePx: 16, color: "currentColor" }),
    );
    this.$nextBtn.appendChild(
      LonaIcons.make(ArrowDownIcon, { sizePx: 16, color: "currentColor" }),
    );
    GESTURE_MANAGER.addPointerEvent(this.$prevBtn, {
      onClick: () => this.carousel.previousPage(),
    });
    GESTURE_MANAGER.addPointerEvent(this.$nextBtn, {
      onClick: () => this.carousel.nextPage(),
    });

    GESTURE_MANAGER.addPointerEvent(this.$addBtn, {
      onClick: () => {
        const habit = HABITS[this.carousel.currentPageIndex];
        this.onAddHabit?.(habit);
      },
    });

    return this;
  }

  private createCell(habit: (typeof HABITS)[number]): HTMLElement {
    const $cell = Column.make();
    $cell.assignStyles({
      alignItems: "center",
      justifyContent: "center",
      gap: "8px",
      height: "100%",
    });

    const $emoji = document.createElement("div");
    $emoji.textContent = habit.emoji;
    $emoji.assignStyles({
      fontSize: "64px",
    });

    const $label = Typography.p(habit.label);
    $label.classList.add("small");
    $label.assignStyles({
      color: "var(--text-sec)",
    });

    $cell.appendChild($emoji);
    $cell.appendChild($label);

    return $cell;
  }

  static $styles = [
    Button.$style,
    css`
      :host {
        display: block;
        height: 100%;
      }

      #container {
        height: 100%;
        padding: 12px;
      }

      #carousel-container {
        flex: 1;
        min-height: 0;
        position: relative;
        --std-carousel-background-color: transparent;
        --std-carousel-container-box-shadow: none;
      }

      .nav-btn {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--bg-surface-light);
        color: var(--text-sec);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 1;
        transition: background 0.15s ease;
      }

      .nav-btn:hover {
        background: var(--bg-selected);
        color: var(--text-pri);
      }

      #prev-btn {
        left: 0;
        transform: translateY(-50%) rotate(90deg);
      }

      #next-btn {
        right: 0;
        transform: translateY(-50%) rotate(-90deg);
      }

      #dots {
        --size: 6px;
        margin-top: 8px;
        margin-bottom: 8px;
        align-self: center;
      }

      #disclaimer {
        margin-bottom: 4px;
      }

      #add-btn {
        align-self: stretch;
      }
    `,
  ];

  static $html = html`
    <std-col id="container">
      <div id="carousel-container">
        <div id="prev-btn" class="nav-btn"></div>
        <div id="next-btn" class="nav-btn"></div>
      </div>
      <std-page-indicator-dots id="dots"></std-page-indicator-dots>
      <std-disclaimer id="disclaimer"></std-disclaimer>
      <button id="add-btn" primary>Add habit</button>
    </std-col>
  `;
}

export namespace NuxHabitCard {
  export type Callbacks = {
    onAddHabit?: (habit: { emoji: string; label: string; image: string }) => void;
  };
}
