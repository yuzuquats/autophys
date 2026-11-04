import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { Typography } from "../../ui/typography";
import { ChevronDownIcon, ChevronUpIcon, LonaIcons } from "../../ui/icons";

// Caps slotted content at a maximum height and reveals the rest behind a
// floating "Show more" pill. Content that fits shows no pill and no fade at
// all, so a consumer can wrap every item unconditionally and only the tall ones
// pay for the affordance.
//
// Overflow is MEASURED, not predicted. `#content` is a plain block outside the
// clamp, so its offsetHeight is the natural height whatever the children are;
// `#viewport` is the clamped, overflow-hidden window. A ResizeObserver on
// `#content` re-checks as late content settles (images decoding, fonts
// swapping, a nested list expanding), which is why callers do not have to
// declare an expected height or wait for load events themselves.
@component({ name: "std-clamp-box" })
export class ClampBox extends LonaWebComponent {
  private $viewport: HTMLElement = this.$("viewport");
  private $content: HTMLElement = this.$("content");
  private $toggle: HTMLElement = this.$("toggle");
  private $toggleLabel: HTMLElement = this.$("toggle-label");
  private $toggleIcon: HTMLElement = this.$("toggle-icon");

  private vm: Option<ClampBox.ViewModel> = null;
  private expanded = false;

  // Re-measures whenever the natural content height changes. Observing
  // `#content` (never `#viewport`, whose height is pinned by the clamp) is what
  // makes the check independent of when the content actually arrives.
  private readonly contentObserver = new ResizeObserver(() => {
    this.measureOverflow();
  });

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$toggle, {
      onClick: () => this.setExpanded(!this.expanded),
    });
  }

  static makeWith(vm: ClampBox.ViewModel): ClampBox {
    return ClampBox.make().bind(vm);
  }

  bind(vm: ClampBox.ViewModel): this {
    this.vm = vm;
    if (vm.maxHeightPx != null) {
      this.style.setProperty("--clamp-box-max-height", `${vm.maxHeightPx}px`);
    }
    this.setExpanded(false);
    this.contentObserver.observe(this.$content);
    return this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.contentObserver.disconnect();
  }

  onRecycle(): void {
    super.onRecycle();
    this.contentObserver.disconnect();
    this.vm = null;
    this.expanded = false;
    this.removeAttribute("expanded");
    this.removeAttribute("clamped");
    this.style.removeProperty("--clamp-box-max-height");
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  // Whether the content is currently taller than the cap. False both when the
  // content fits and before it has been measured.
  isClamped(): boolean {
    return this.hasAttribute("clamped");
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.toggleAttribute("expanded", expanded);
    this.renderToggle();
    // Expanding removes the cap, so the measurement that decided `clamped` no
    // longer holds — re-run it on the way back down.
    if (!expanded) this.measureOverflow();
    this.vm?.onToggle?.(expanded);
  }

  private renderToggle(): void {
    const vm = this.vm;
    this.$toggleLabel.textContent = this.expanded
      ? vm?.collapseLabel ?? "Show less"
      : vm?.expandLabel ?? "Show more";
    this.$toggleIcon.replaceChildren(
      LonaIcons.$svg(this.expanded ? ChevronUpIcon : ChevronDownIcon),
    );
  }

  // Compares the natural content height against the resolved cap. Only ever
  // ADDS `clamped`: once a block is known to overflow it keeps its pill, so a
  // reader who expands and collapses again is not left without the control that
  // got them there. A 1px slack absorbs sub-pixel layout rounding.
  private measureOverflow(): void {
    if (this.expanded) return;
    const capPx = this.$viewport.clientHeight;
    if (capPx <= 0) return;
    if (this.$content.offsetHeight > capPx + 1) {
      this.toggleAttribute("clamped", true);
    }
  }

  static $styles = [
    Typography.$style,
    css`
      :host {
        position: relative; /* anchors the fade + the floating toggle */
        display: block;
        box-sizing: border-box;
        width: 100%;
      }

      #viewport {
        max-height: var(--clamp-box-max-height, 480px);
        overflow: hidden;
      }

      :host([expanded]) #viewport {
        max-height: none;
      }

      /* The fade only exists while content is actually being cut off. It fades
         to --clamp-box-fade-color rather than the page background: the bottom
         of the clipped region often belongs to the content (a white screenshot,
         a code block), and fading to the wrong ground reads as a seam. */
      #fade {
        display: none;
        position: absolute;
        inset-inline: 0;
        bottom: 0;
        height: var(--clamp-box-fade-height, 88px);
        background: linear-gradient(
          to bottom,
          transparent,
          var(--clamp-box-fade-color, var(--bg))
        );
        pointer-events: none;
      }

      :host([clamped]:not([expanded])) #fade {
        display: block;
      }

      #toggle {
        /* Inherit the page's face — the UA stylesheet gives form controls a
           family of their own, so a bare button opts out of the page font. */
        font-family: inherit;
        display: none;
      }

      :host([clamped]) #toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        position: absolute;
        left: 50%;
        bottom: var(--clamp-box-toggle-inset, 16px);
        /* translateX(-50%) centers the pill — it is NOT a hover lift. Never add
           a translateY here: a pill that jumps on hover reads as a glitch. */
        transform: translateX(-50%);
        z-index: 1;
        padding: 8px 18px;
        border: 1px solid color-mix(in srgb, var(--divider) 60%, transparent);
        border-radius: 999px;
        background: var(--bg);
        color: var(--text-pri);
        cursor: pointer;
        /* Floating: lift the pill off the faded content with a soft shadow. */
        box-shadow:
          0 6px 20px color-mix(in srgb, black 24%, transparent),
          0 1px 4px color-mix(in srgb, black 16%, transparent);
        transition: box-shadow 120ms ease;
      }

      /* Hover deepens the shadow only — see the transform note above. */
      :host([clamped]) #toggle:hover {
        box-shadow:
          0 10px 28px color-mix(in srgb, black 28%, transparent),
          0 2px 6px color-mix(in srgb, black 18%, transparent);
      }

      #toggle:focus-visible {
        outline: 2px solid var(--blue);
        outline-offset: 2px;
      }

      #toggle-label {
        --font-size: var(--text-9px);
        --margin-top: 0px;
        --margin-bottom: 0px;
      }

      #toggle-icon {
        display: inline-flex;
        align-items: center;
        width: 10px;
        height: 10px;
        color: var(--text-sec);
      }

      #toggle-icon svg {
        width: 100%;
        height: 100%;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="viewport">
      <div id="content"><slot></slot></div>
    </div>
    <div id="fade" aria-hidden="true"></div>
    <button id="toggle" type="button">
      <span id="toggle-label" class="small"></span>
      <span id="toggle-icon" aria-hidden="true"></span>
    </button>
  `;
}

export namespace ClampBox {
  export interface ViewModel {
    // Cap height in px; null keeps whatever `--clamp-box-max-height` resolves to
    // (the CSS default, or a value the consumer set in its own stylesheet).
    maxHeightPx: Option<number>;
    expandLabel: Option<string>;
    collapseLabel: Option<string>;
    // Fires after the state flips — a masonry parent reflows here.
    onToggle: Option<(expanded: boolean) => void>;
  }
}
