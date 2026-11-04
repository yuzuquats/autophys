import { LonaWebComponent, html } from "../component";
import { Div } from "../component-builtin";
import { component } from "../component-decorators";
import { css } from "../component-styles";
import { DomUtils } from "../dom";
import { $$ } from "../fastdom";
import { GESTURE_MANAGER } from "../gesture-manager";

@component({
  name: "std-page-indicator-dots",
})
export class PageIndiciatorDots extends LonaWebComponent {
  /** Dots are eagerly rendered navigation targets, not a virtualized list. */
  static readonly maxCount = 1000;
  private bgColorProvider?: ((index: number) => Option<string>) | undefined;
  onChange?: (index: number) => void;

  bind(selectedIndex: number, count: number, bgColorProvider?: (index: number) => Option<string>) {
    if (!Number.isSafeInteger(count) || count < 0 || count > PageIndiciatorDots.maxCount) {
      throw new RangeError(`Page indicator count must be an integer from 0 to ${PageIndiciatorDots.maxCount}`);
    }
    this.bgColorProvider = bgColorProvider;
    const $dots: HTMLDivElement[] = [];
    for (let i = 0; i < count; ++i) {
      const $dot = Div.make();
      $dot.classList.add("page-indicator-dot");
      $dot.setAttribute("index", String(i));
      // ARIA attributes for accessibility
      $dot.setAttribute("role", "tab");
      $dot.setAttribute("tabindex", "0");
      $dot.setAttribute("aria-label", `Page ${i + 1} of ${count}`);
      if (i === selectedIndex) {
        $dot.toggleAttribute("selected", true);
        $dot.setAttribute("aria-selected", "true");
      } else {
        $dot.setAttribute("aria-selected", "false");
      }
      const bgColor = this.bgColorProvider?.(i);
      if (bgColor !== undefined) {
        $dot.style.setProperty("--dot-bg-color", bgColor);
      }
      GESTURE_MANAGER.addPointerEvent($dot, {
        onClick: () => {
          this.bindSelectedIndex(i);
          this.onChange?.(i);
        },
      });
      // Keyboard support
      $dot.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.bindSelectedIndex(i);
          this.onChange?.(i);
        }
      });
      $dots.push($dot);
    }
    $$.mutate(() => {
      DomUtils.clearChildren(this.$("root"));
      for (const $dot of $dots) this.$("root").appendChild($dot);
    });
  }

  bindSelectedIndex(selectedIndex: number) {
    $$.mutate(() => {
      const $prev = this.$qs_maybe(".page-indicator-dot[selected]");
      if ($prev) {
        $prev.toggleAttribute("selected", false);
        $prev.setAttribute("aria-selected", "false");
      }
      const $next = this.$qs(
        `.page-indicator-dot[index="${Math.floor(selectedIndex)}"]`,
      );
      $next.toggleAttribute("selected", true);
      $next.setAttribute("aria-selected", "true");
    });
  }

  bindColors(bgColorProvider: (index: number) => Option<string>) {
    this.bgColorProvider = bgColorProvider;
    const $dots = this.$qsa(".page-indicator-dot");
    $$.mutate(() => {
      for (let i = 0; i < $dots.length; ++i) {
        const bgColor = this.bgColorProvider?.(i);
        if (bgColor !== undefined) {
          $dots[i].style.setProperty("--dot-bg-color", bgColor);
        } else {
          $dots[i].style.removeProperty("--dot-bg-color");
        }
      }
    });
  }

  static $styles = [
    css`
      :host {
        margin-top: 8px;
      }

      #root {
        position: relative;
        align-self: center;
      }
      .page-indicator-dot {
        height: var(--size, 6px);
        width: var(--size, 6px);
        border-radius: calc(var(--size, 6px) / 2);
        background-color: var(--dot-bg-color, var(--fg-icon-ter));
        margin-right: 4px;
        transition: background-color 0.3s ease, width 0.3s ease;
        cursor: pointer;
      }
      .page-indicator-dot:last-child {
        margin-right: 0px;
      }
      .page-indicator-dot[selected] {
        background-color: var(--dot-bg-color, var(--fg-icon-pri));
        width: var(--selected-width, var(--size, 6px));
      }

      .page-indicator-dot:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-row id="root" role="tablist" aria-label="Page navigation"></std-row>
  `;
}
