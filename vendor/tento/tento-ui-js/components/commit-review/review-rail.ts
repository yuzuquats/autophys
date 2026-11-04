import "../modal-close-button/modal-close-button";
import "../round";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { GESTURE_MANAGER } from "../../gesture-manager";
import { SimpleKeyframe } from "../../keyframe";
import { Typography } from "../../ui/typography";
import { IconButton } from "../icon-button";
import { ModalCloseButton } from "../modal-close-button/modal-close-button";
import { COLLAPSE_RAIL_ICON, EXPAND_RAIL_ICON } from "../rail/rail-icons";
import { RailState } from "../rail/rail-state";
import { Round } from "../round";

// The commit-review subsidebar's frame.
//
// Everything here used to live inside `stack-review.ts`, which also owns the
// diff pane, the router, the tab set and the assignment flow. That made the
// rail unreviewable in isolation: one mount site, no storybook, and every
// change to a 7px drag handle was a change to the largest file in the review
// UI. This component is the frame and nothing else — it renders no rows.
//
// The split is by QUESTION, not by pixel. The rail owns what is true about
// the rail no matter what is in it: how wide it is, whether it is collapsed
// to its graph lane, which of its two faces is showing, where its buttons put
// their tooltips, and whether a panel has taken it over. The OWNER keeps
// everything that needs to know what the rail is pointed at — which repo tab
// is live, what the log's mode means, what the inbox refresh costs, what a
// view switch does to the URL. So the view toggle's STATE is here and its
// CONSEQUENCE is reported through `onViewChange`.
//
// The body arrives through a slot, because the rail genuinely does not care
// which of the two lists it is holding. That is also the one place the
// extraction can silently regress: a slotted element is styled from the
// OUTER scope, so every rule that used to reach the log or the inbox by id
// has to become `::slotted(...)` or it simply stops applying — quietly, with
// no error, as a lost padding or a view that will not hide.
//
// The host IS the scrollport, exactly as `#rail` was. That is deliberate: the
// sticky title, the two scroll-driven shadow edges and the overscroll
// containment are all defined against it, and re-parenting the scroll into an
// inner div would have re-tuned three subtle behaviours to gain nothing.

/** The rail's width and collapsed keys — `tento-stack-rail-width` and
 * `tento-stack-rail-collapsed`, unchanged since before `RailState` existed, so
 * no operator loses a remembered width. View preferences, like the fleet
 * shell's own `tento-sidebar-collapsed`: they belong to the browser rather
 * than to the stack it happens to be pointed at. */
const RAIL_KEYS = RailState.keys("tento-stack-rail");

/** Which face the subsidebar shows: `stack` = the git/branch log (with its
 * own flat ⇄ nodes toggle), `inbox` = the attention-ordered review inbox
 * (commit-review-inbox). A view, not a mode: the two are different answers
 * to different questions, and the switch swaps the rail's whole body. */
const RAIL_VIEW_KEY = "tento-stack-rail-view";

/** Rail width, resizable by the divider drag handle. One preference for
 * every repo and host — width is a property of the operator's window, not
 * of the stack it happens to show. The bounds are the kit's: the same
 * 220/600 `std-rail` and ux-rail use. */
const RAIL_WIDTH_DEFAULT = 300;
const RAIL_BOUNDS: RailState.Bounds = { minPx: 220, maxPx: 600 };
/** The rail's own width ease, kept in step with the `transition` declared on
 * `:host`. Read here so the panel knows when the edge has stopped moving and
 * the frozen contents can safely be handed back their natural widths. */
const RAIL_WIDTH_ANIM_MS = 220;
/** How many times the freeze's backstop timer will wait another interval for
 * a width transition that is still visibly advancing before giving up on it. */
const RAIL_WIDTH_SETTLE_RETRIES = 4;

/** The modal card's corner radius and its enter/exit duration.
 *
 * Both borrowed from lona.so's docked panels rather than chosen: the point of
 * this treatment is that a panel here reads the same as a panel there. */
const PANEL_RADIUS = 24;
const PANEL_ANIM_MS = 300;
/** How long past the animation's own duration the teardown will wait for it
 * before giving up and running anyway. */
const PANEL_ANIM_SLACK_MS = 60;

/** How far the card's surface runs PAST the rail's bottom edge.
 *
 * lona.so's docked panels do the same thing, with the same number: the card is
 * flush to the bottom and its surface continues underneath, so the rail clips
 * it rather than the card stopping short with two rounded corners floating
 * above the edge. A modal that runs off the bottom reads as a panel the
 * viewport is cropping; one that stops short reads as a small box that failed
 * to fill its space. */
const PANEL_BLEED_PX = 24;

@component({ name: "std-review-rail" })
export class ReviewRail extends LonaWebComponent {
  private $railTitle: HTMLElement = this.$("rail-title");
  private $viewToggle: HTMLElement = this.$("view-toggle");
  private $btnTip: HTMLElement = this.$("btn-tip");
  private $panel: HTMLElement = this.$("panel");
  private $panelTitle: HTMLElement = this.$("panel-title");
  private $panelBody: HTMLElement = this.$("panel-body");

  /** The head's buttons, exposed because what they DO is the owner's: a
   * reload knows about fetches, a mode toggle about the log's rendering, a
   * columns button about the inbox's field menu. The rail owns only that
   * they exist, where they sit, and how they name themselves. */
  readonly $modeToggle: IconButton = this.hydrate("mode-toggle");
  readonly $columns: IconButton = this.hydrate("columns");
  readonly $reload: IconButton = this.hydrate("reload");
  private $collapse: IconButton = this.hydrate("collapse");
  private $panelBg: Round = this.hydrate("panel-bg");
  private $panelClose: ModalCloseButton = this.hydrate("panel-close");

  /** The repo tab strip and the orphan-warning list. The rail places them;
   * the owner fills them, because both are statements about a particular
   * host's stack. */
  readonly $tabs: HTMLElement = this.$("tabs");
  readonly $orphans: HTMLElement = this.$("orphans");

  private railCollapsed = false;
  private railView: ReviewRail.View = "stack";
  /** The width to restore when a panel closes, or null when no panel has
   * taken the rail over. Also the flag for "a panel is open". */
  private panelDismissWidth: Option<string> = null;
  /** Where the list was scrolled to when the panel took over, so closing
   * puts the reader back rather than at the top. */
  private panelDismissScroll = 0;

  onViewChange: Option<(view: ReviewRail.View, persist: boolean) => void> = null;
  onCollapsedChange: Option<(collapsed: boolean) => void> = null;
  onPanelClose: Option<() => void> = null;

  constructor() {
    super();
    this.$collapse.addEventListener("click", () => this.setCollapsed(!this.railCollapsed));
    this.bindTip(this.$collapse);
    this.bindTip(this.$modeToggle);
    this.bindTip(this.$reload);
    // stack ⇄ inbox, by delegation — the two segments are spans, not buttons.
    GESTURE_MANAGER.addPointerEvent(this.$viewToggle, {
      onClick: (_captured, _offset, event) => {
        const view = (event.target as HTMLElement).closest<HTMLElement>(".vseg[data-view]")
          ?.dataset.view;
        if ((view === "stack" || view === "inbox") && view !== this.railView) {
          this.setView(view);
        }
      },
    });
    // The modal's surface, drawn BEHIND its contents (std-round[floating] is
     // z-index: -1) so the card reads as one elevated object rather than a
     // header stacked on a body. Same treatment lona.so gives its own docked
     // panels: a continuous-corner squircle on --bg-elevated, not a
     // border-radius on a div.
    this.$panelBg.bind({
      ...Round.Props.MODAL,
      bg: "var(--bg-elevated)",
      radius: PANEL_RADIUS,
      transformTopLeft: true,
    });
    this.$panelBg.toggleAttribute("floating", true);
    this.$panelBg.style.setProperty("--bg-height", `calc(100% + ${PANEL_BLEED_PX}px)`);
    this.$panelClose.bind({ onDismiss: () => this.closePanel() });
  }

  /** Adopt the operator's remembered width and collapse state.
   *
   * Explicit rather than automatic, for two reasons that happen to agree. A
   * custom element constructor MUST NOT touch its own attributes — the spec
   * enforces it, and `make()` goes through `document.createElement`, which is
   * the strict path that throws — so this cannot run at construction. And a
   * caller that wants a rail in a KNOWN state (a storybook card, a test)
   * should not have to fight `localStorage` to get one: nothing is restored
   * unless it is asked for.
   *
   * The collapse is applied unanimated: the rail must open in its remembered
   * state, not slide into it on every page load. */
  restorePreferences(): void {
    const stored = RailState.restoreWidth(localStorage.getItem(RAIL_KEYS.width), RAIL_BOUNDS);
    if (stored != null) {
      this.style.setProperty("--rail-w", `${stored}px`);
    }
    this.setCollapsed(localStorage.getItem(RAIL_KEYS.collapsed) === "true", false);
  }

  collapsed(): boolean {
    return this.railCollapsed;
  }

  view(): ReviewRail.View {
    return this.railView;
  }

  /** Collapse the rail to its graph lane (52px: 4px pad + the 36px lane +
   * room to breathe). The rows keep their full 300px layout and the text is
   * clipped away, so the lane, the verdict colors and the selection band all
   * survive — you never lose your place in the stack. */
  setCollapsed(collapsed: boolean, animate: boolean = true): void {
    this.railCollapsed = collapsed;
    // Suppressing the transition for the initial restore has to happen
    // before the width changes, and be lifted a frame later.
    if (!animate) this.toggleAttribute("no-transition", true);
    this.toggleAttribute("collapsed", collapsed);
    this.$collapse.bindIcon(collapsed ? EXPAND_RAIL_ICON : COLLAPSE_RAIL_ICON, {
      squarish: true,
      ariaLabel: collapsed ? "Expand the stack rail" : "Collapse the stack rail",
    });
    this.$collapse.setAttribute("aria-expanded", String(!collapsed));
    const tip = collapsed ? "Expand rail" : "Collapse rail";
    this.$collapse.dataset.tip = tip;
    // Same reason the mode toggle retitles: the button names its NEXT state,
    // so clicking it renames it under a pointer that never moved. Without
    // this the tip still offers to collapse an already-collapsed rail.
    this.retitleTip(this.$collapse, tip);
    localStorage.setItem(RAIL_KEYS.collapsed, String(collapsed));
    if (!animate) {
      requestAnimationFrame(() => this.toggleAttribute("no-transition", false));
    }
    this.onCollapsedChange?.(collapsed);
  }

  /** stack ⇄ inbox. Swaps the rail's whole body: the log (and its
   * flat/nodes toggle and repo tabs — both stack-view furniture; the inbox
   * spans repos) for the attention-ordered inbox, or back.
   *
   * `persist` distinguishes a GESTURE from a VISIT: a deep link carrying
   * `?rail=inbox` must not repoint the reader's next cold load. The owner
   * makes the same distinction for the URL, which is why it is reported
   * rather than decided here. */
  setView(view: ReviewRail.View, persist: boolean = true): void {
    this.railView = view;
    this.setAttribute("view", view);
    for (const $s of this.$viewToggle.querySelectorAll<HTMLElement>(".vseg")) {
      $s.classList.toggle("active", $s.dataset.view === view);
    }
    if (persist) localStorage.setItem(RAIL_VIEW_KEY, view);
    this.onViewChange?.(view, persist);
  }

  /** The stored view, for the owner's cold-start restore. */
  static storedView(): ReviewRail.View {
    return localStorage.getItem(RAIL_VIEW_KEY) === "inbox" ? "inbox" : "stack";
  }

  /** A rail button's tooltip.
   *
   * The rail clips horizontally — it has to, so the rows can be cropped
   * rather than reflowed during the collapse — so a std-tooltip on
   * a rail button gets sliced off at the rail's edge in BOTH states (a wide
   * label in a 300px rail, any label at all in a 52px strip). Fixed
   * positioning escapes the clip; the label rides on `data-tip` so it can
   * change with state. */
  bindTip($btn: HTMLElement): void {
    const show = () => {
      const label = $btn.dataset.tip;
      if (label == null || label === "") return;
      this.$btnTip.textContent = label;
      const r = $btn.getBoundingClientRect();
      this.$btnTip.style.top = `${r.bottom + 6}px`;
      this.$btnTip.style.left = `${r.left}px`;
      this.$btnTip.toggleAttribute("shown", true);
    };
    const hide = () => this.$btnTip.toggleAttribute("shown", false);
    $btn.addEventListener("pointerenter", show);
    $btn.addEventListener("pointerleave", hide);
    // Keyboard parity: std-icon-button is focusable, so a focused control
    // must name itself without a mouse ever being involved.
    $btn.addEventListener("focus", show);
    $btn.addEventListener("blur", hide);
  }

  /** Retarget a tooltip that is already showing.
   *
   * A button whose label changes UNDER THE POINTER (the mode toggle names
   * its next state, so activating it renames it) would otherwise keep the
   * stale label until the pointer leaves and returns. */
  retitleTip($btn: HTMLElement, label: string): void {
    if ($btn.matches(":hover, :focus")) this.$btnTip.textContent = label;
  }

  /** Drive the rail's width from the owner's divider handle.
   *
   * The handle itself stays in the owner's layout, and that is not an
   * oversight: it is a 7px strip straddling the border BETWEEN the rail and
   * the pane, held out of the flex flow by negative margins. Moved in here it
   * would sit inside the scrollport and scroll away with the rows. So the
   * owner owns the grab and the rail owns the width. */
  bindResizer($handle: HTMLElement): void {
    let startWidth = RAIL_WIDTH_DEFAULT;
    let startX = 0;
    GESTURE_MANAGER.addDragGesture($handle, "stack-rail-resize", {
      onPointerDown: (e) => {
        startWidth = this.getBoundingClientRect().width;
        startX = e.pageX;
        this.toggleAttribute("no-transition", true);
        $handle.toggleAttribute("dragging", true);
      },
      onPointerMove: (e) => {
        const w = RailState.dragWidth(startWidth, e.page.x - startX, RAIL_BOUNDS);
        this.style.setProperty("--rail-w", `${w}px`);
      },
      onPointerUp: () => {
        this.toggleAttribute("no-transition", false);
        $handle.toggleAttribute("dragging", false);
        const w = Math.round(this.getBoundingClientRect().width);
        localStorage.setItem(RAIL_KEYS.width, String(w));
      },
      onDoubleClick: () => {
        this.style.removeProperty("--rail-w");
        localStorage.removeItem(RAIL_KEYS.width);
      },
    });
  }

  /** Set the rail's width, letting the 220ms ease run.
   *
   * The LAYOUT animates; its contents do not. That split is the whole design
   * here, and it is what makes a width tween affordable: animating width
   * naively is really a relayout of everything inside, once per frame — the
   * embedded thread reflowing its iframe on the way in, the list reflowing a
   * hundred rows on the way out — which reads as jitter rather than motion.
   * So both sides are pinned to a definite width before the edge starts
   * moving (`--rail-frozen-w` for the list, `--rail-panel-w` for the card),
   * each is laid out exactly once, and the moving edge simply reveals or
   * clips them. */
  private setWidth(width: string): void {
    if (width === "") this.style.removeProperty("--rail-w");
    else this.style.setProperty("--rail-w", width);
  }

  // ---------------------------------------------------------------- panel ---

  /** Whether a panel currently holds the rail. */
  panelOpen(): boolean {
    return this.panelDismissWidth != null;
  }

  /** Give the rail over to a panel — lona.so's sidebar-modal shape.
   *
   * The panel does not float beside the rail or over the pane: it REPLACES
   * the rail's body and widens the rail to fit, so the thing you opened and
   * the place you opened it from are the same column. Closing restores the
   * width you had, which is why it is captured here rather than recomputed:
   * a rail the operator had dragged to 480px must not come back at 300.
   *
   * Re-showing with the same content is not a reset. The owner keeps one
   * element per subject and hands the SAME node back, so an embedded thread
   * keeps its scroll position and its unsent composer draft; rebuilding it
   * would reload the iframe and drop both. */
  showPanel(props: { title: string; $content: HTMLElement; widthPx: number }): void {
    // A panel in a 52px strip has nowhere to draw, and the operator asked for
    // the panel, not for the strip. Expanding first is the only reading of
    // the gesture that leaves something on screen.
    if (this.railCollapsed) this.setCollapsed(false);
    if (this.panelDismissWidth == null) {
      this.panelDismissWidth = this.style.getPropertyValue("--rail-w");
    }
    this.$panelTitle.textContent = props.title;
    if (this.$panelBody.firstChild !== props.$content) {
      this.$panelBody.replaceChildren(props.$content);
    }
    const wasOpen = this.hasAttribute("panel-open");
    // Freeze the list at the width it has RIGHT NOW, before the rail grows.
    // The rail is about to get wider and then narrow again, and every frame
    // of that would otherwise relayout a list of a hundred rows and re-run
    // the tables' virtualization — for a list that is not even on screen
    // while the card is up. Frozen, it is laid out once, before the panel
    // opens, and is still laid out that way when it comes back.
    if (!wasOpen) {
      this.style.setProperty("--rail-frozen-w", `${this.clientWidth}px`);
      this.toggleAttribute("panel-frozen", true);
    }
    // The card is born at its FINAL width, not at the rail's current one, so
    // the thread inside it lays out once and never re-measures. While the
    // rail's edge is still travelling the card is simply clipped by it —
    // which is the reveal, and is why the rail hides its horizontal overflow.
    this.style.setProperty("--rail-panel-w", `${props.widthPx}px`);
    this.setWidth(`${props.widthPx}px`);
    this.toggleAttribute("panel-open", true);
    // The rail keeps its scroll offset when its body is hidden, and the panel
    // is laid out INSIDE that same scrollport — so a rail scrolled 24px down
    // opens a card cropped 24px off the top (observed: the panel's own header
    // was half missing). Nothing is scrollable while the panel is up, so the
    // offset has no job; bank it and zero it.
    if (!wasOpen) {
      this.panelDismissScroll = this.scrollTop;
      this.scrollTop = 0;
    }
    // Only animate an actual ARRIVAL. Re-showing a panel that is already up
    // (a second click on the same mark, or a reopen that caught the exit
    // mid-flight) would otherwise replay the entrance on a card that never
    // left, which reads as a flicker rather than as a transition.
    if (!wasOpen) {
      SimpleKeyframe.builder().fadeIn().slideIn().animate(this.$panel, true, PANEL_ANIM_MS);
    }
  }

  /** Hand the rail back to its body and restore the pre-panel width.
   *
   * The content stays parented here rather than being dropped: the owner
   * decides whether a thread is worth keeping alive, and this component
   * cannot know that a detached iframe costs a draft. */
  closePanel(): void {
    const restore = this.panelDismissWidth;
    if (restore == null) return;
    // Cleared FIRST, so `panelOpen()` reports false for the whole exit and a
    // click during it opens rather than being swallowed as a repeat.
    this.panelDismissWidth = null;

    // The teardown itself: idempotent, and deliberately NOT owned by the
    // animation. Gating it on `onfinish` alone is how a panel gets stuck
    // open — a document timeline that stops advancing (a busy renderer;
    // observed here, the exit animation sat at currentTime 0 indefinitely)
    // never fires it, and the operator is left with a card that will not
    // close. So the animation and a timer both call this, and whichever
    // arrives first wins.
    let settled = false;
    const settle = () => {
      // A reopen during the exit owns the panel now; undoing its width would
      // strand it half-sized.
      if (settled || this.panelDismissWidth != null) return;
      settled = true;
      // Held until the card has gone: the rail narrows and the list comes
      // back together, instead of the list appearing behind a panel that is
      // still on screen.
      this.toggleAttribute("panel-open", false);
      this.setWidth(restore);
      // The freeze OUTLIVES the width tween. Releasing it here would hand the
      // list back its natural width while the rail's edge is still moving,
      // which is exactly the per-frame relayout the freeze exists to prevent
      // — the list would track the edge for 220ms instead of sitting still
      // behind it. It comes off once the rail is back at its own width, where
      // frozen and natural are the same number and the release costs nothing.
      this.unfreezeWhenSettled();
      // A frame later, not now: the list only regains its height once the
      // slot is displayed again, and the browser CLAMPS scrollTop to whatever
      // the scrollport measures at the moment you write it — restoring inline
      // put a reader who was 640px down back at 24 (observed).
      const scroll = this.panelDismissScroll;
      requestAnimationFrame(() => {
        this.scrollTop = scroll;
      });
      this.onPanelClose?.();
    };

    window.setTimeout(settle, PANEL_ANIM_MS + PANEL_ANIM_SLACK_MS);
    SimpleKeyframe.builder()
      .fadeOut()
      .slideOut()
      .animate(this.$panel, true, PANEL_ANIM_MS, () => false, settle);
  }

  /** Hand the contents back their natural widths, but only once the rail's
   * edge has actually stopped moving.
   *
   * A plain timer is not enough, and the reason is measurable: a transition
   * runs on the document timeline, and a timer does not. When the timeline
   * stalls — a hidden tab, a busy renderer — the width sits at `currentTime
   * 0` while the timer fires on schedule, and the freeze is released into a
   * rail that has not narrowed by a pixel. Observed exactly that: the list
   * snapped from its frozen 334 out to 399, which is the one relayout this
   * whole mechanism exists to prevent.
   *
   * So `transitionend` is the real signal and the timer is only a backstop,
   * re-armed while the transition is genuinely still advancing. The retry is
   * capped rather than open-ended: against a permanently stalled timeline the
   * rail is not being painted anyway, and a freeze that never lifts would
   * outlive the panel it belongs to. */
  private unfreezeWhenSettled(): void {
    let timer = 0;
    const release = () => {
      // A panel opened during the tween re-froze the list for its own use.
      if (this.panelDismissWidth != null) return;
      this.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      this.toggleAttribute("panel-frozen", false);
      this.style.removeProperty("--rail-frozen-w");
      this.style.removeProperty("--rail-panel-w");
    };
    // Descendant transitions bubble here and are retargeted to the host, so
    // `target` cannot tell them apart — the composed path can.
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === "width" && e.composedPath()[0] === this) release();
    };
    this.addEventListener("transitionend", onEnd);
    const arm = (retries: number) => {
      timer = window.setTimeout(() => {
        const advancing = this.getAnimations().some(
          (a) => a.playState === "running" && Number(a.currentTime ?? 0) > 0
        );
        if (advancing && retries > 0) arm(retries - 1);
        else release();
      }, RAIL_WIDTH_ANIM_MS + PANEL_ANIM_SLACK_MS);
    };
    arm(RAIL_WIDTH_SETTLE_RETRIES);
  }

  static $styles = [
    Typography.$style,
    css`
      /* The rail: the git tree, its own scrollbar, pinned title. Width is
         the resizer's custom property when the operator has dragged it,
         the classic 300px otherwise. */
      :host {
        /* Scroll-shadow ink. Dark mode needs a heavier one: the same alpha
           over a dark surface barely reads. */
        --rail-shadow: light-dark(rgb(0 0 0 / 14%), rgb(0 0 0 / 42%));
        width: var(--rail-w, 300px);
        flex-shrink: 0;
        border-right: 1px solid var(--divider);
        overflow-y: auto;
        overflow-x: hidden;
        /* The rail and the diff pane are independent reading surfaces: running
           one to its end must not scroll the other, and must not chain out to
           the document (which rubber-bands the rail and the shell sidebar
           along with it). Contain, not none: the rail keeps its own bounce and
           it just stops propagating. */
        overscroll-behavior: contain;
        /* No scrollbar, and no gutter reserved for one.
           
           A classic scrollbar is 15px of layout taken off the right edge, and
           a stable gutter reserves those 15px whether or not a bar is there.
           Either way the rail's inline spacing comes out lopsided — 12px of
           title padding on the left against 27px on the right — and the
           modal card inherits the same skew. The rail already carries the
           cue a scrollbar would give: a scroll-driven shadow at each end,
           which is what they were added for. So the bar is hidden and the
           wheel still scrolls, exactly as the collapsed strip has always
           done, and exactly as lona.so's own sidebar does (hide-scroll-bars
           on its root). */
        scrollbar-width: none;
        display: flex;
        flex-direction: column;
        transition: width 0.22s cubic-bezier(0.2, 0.7, 0.3, 1);
      }
      /* Set for the initial restore so a remembered collapse does not slide
         open on every page load, and while dragging so the edge tracks the
         pointer instead of easing after it. */
      :host([no-transition]) {
        transition: none;
      }
      :host::-webkit-scrollbar {
        width: 0;
        height: 0;
      }
      /* Collapsed: 4px log pad + the 36px graph lane + room to breathe. The
         rows keep their natural 300px layout below and are CLIPPED, never
         reflowed — a rewrap mid-animation reads as a glitch. The 52px strip
         is where hiding the bar started: it would have taken 16 of those
         52px, slicing 4px off the graph lane and leaving the branch node all
         but touching it. */
      :host([collapsed]) {
        width: 52px;
      }
      /* No fixed width on the rail's children: they track the content box,
         so nothing has to be re-tuned when the rail is dragged wider. The
         collapse stays clean because the graph lane is flex-shrink:0 and the
         text is faded out before it can reflow. */
      :host([collapsed]) #rail-name,
      :host([collapsed]) #mode-toggle,
      :host([collapsed]) #tabs,
      :host([collapsed]) #orphans {
        display: none;
      }
      /* Stack the two controls down the strip instead of across it. */
      :host([collapsed]) #rail-head {
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
      }
      :host([collapsed]) #rail-title {
        padding-left: 14px;
      }
      @media (prefers-reduced-motion: reduce) {
        :host {
          transition: none;
        }
      }
      #rail-title {
        position: sticky;
        top: 0;
        /* The inbox tables own sticky column headers at z-index: 2. Keep the
           rail's title in the next layer so those headers scroll UNDER it
           instead of leaking across the stack/inbox controls. */
        z-index: 3;
        background: var(--bg);
        padding: 14px 12px 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #rail-head {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 1.05rem;
        font-weight: 600;
      }
      /* The title takes the slack so both controls sit together against the
         right edge — space-between would strand reload in mid-header. */
      #rail-name {
        flex: 1;
        min-width: 0;
      }
      /* The view switch IS the title: two words, the active one in title
         ink, the idle one tertiary — a different register from the pill
         toggles on purpose (this swaps the rail's whole body; those tune
         one view's rendering). */
      #view-toggle {
        display: inline-flex;
        gap: 10px;
      }
      .vseg {
        cursor: pointer;
        color: var(--text-ter);
        transition: color 0.12s ease;
      }
      .vseg:hover {
        color: var(--text-sec);
      }
      .vseg.active {
        color: var(--text-pri);
        cursor: default;
      }
      /* Inbox view swaps the rail body: the log and its stack-view
         furniture (flat/nodes, repo tabs — the inbox spans repos) give way
         to the inbox list.

         The body arrives through a slot, so these reach it with ::slotted()
         rather than by id. Same rules, same result — but a slotted element
         is out of reach of a plain selector, and the failure is silent. */
      ::slotted(std-review-inbox) {
        display: none;
      }
      :host([view="inbox"]) ::slotted(std-review-inbox) {
        display: block;
      }
      :host([view="inbox"]) ::slotted(std-stack-log) {
        display: none;
      }
      :host([view="inbox"]) #mode-toggle,
      :host([view="inbox"]) #tabs {
        display: none;
      }
      /* Column placement is the inbox's own control, so it rides the slot
         the stack view's flat/nodes toggle occupies: the header holds
         exactly three buttons in either view, and neither view carries the
         other's. Hidden on the collapsed strip with the rest of the
         view-specific furniture — the 52px inbox draws medallions, not
         tables, so there are no columns to place. */
      #columns {
        display: none;
      }
      :host([view="inbox"]:not([collapsed])) #columns {
        display: grid;
      }
      /* Lit while its menu is showing — ContextMenu puts the attribute on
         the element it was anchored to, which is this button. */
      #columns[context-menu-open] {
        background-color: var(--bg-selected);
      }
      /* Fixed, so it escapes the rail's horizontal clip. Placed by
         bindTip(). */
      #btn-tip {
        position: fixed;
        z-index: 20;
        padding: 4px 10px;
        border-radius: 5px;
        background: var(--bg-tooltip);
        color: var(--fg-tooltip);
        font-size: 11.5px;
        line-height: 1.45;
        white-space: nowrap;
        pointer-events: none;
        user-select: none;
        opacity: 0;
        transition: opacity 0.18s ease;
      }
      #btn-tip[shown] {
        opacity: 1;
        transition-delay: 150ms;
      }
      /* std-icon-button has no disabled treatment of its own; reload leans on
         the disabled attribute while a fetch is in flight, so give it one —
         and spin the glyph, the rail's only in-flight feedback. */
      std-icon-button[disabled] {
        opacity: 0.45;
        pointer-events: none;
      }
      #reload[disabled] svg {
        animation: reload-spin 0.8s linear infinite;
      }
      @keyframes reload-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        #reload[disabled] svg {
          animation: none;
        }
      }
      #tabs {
        display: flex;
        gap: 4px;
      }
      .tab {
        font-size: 11px;
        padding: 2px 8px;
        border: 1px solid var(--divider);
        border-radius: 999px;
        cursor: pointer;
        color: var(--text-ter);
      }
      .tab.active {
        color: var(--text-pri);
        background: var(--bg-hover);
        border-color: var(--text-ter);
      }
      /* Scroll shadows: the rail's tree runs long, and the sticky title has an
         opaque background, so without them a scrolled rail reads as if it
         starts at the title. Both edges are scroll-driven — the top one fades
         in over the first 16px, the bottom one out over the last 16px — so a
         short rail that doesn't scroll shows neither (an inactive scroll
         timeline leaves the base opacity: 0 in place). */
      #rail-title::after,
      #rail-fade {
        content: "";
        pointer-events: none;
        height: 14px;
        opacity: 0;
      }
      #rail-title::after {
        position: absolute;
        inset: 100% 0 auto;
        background: linear-gradient(to bottom, var(--rail-shadow), transparent);
      }
      /* Pinned to the bottom of the scrollport; the negative margin keeps it
         out of flow so it never adds rail height (which would itself scroll). */
      #rail-fade {
        position: sticky;
        bottom: 0;
        margin-top: -14px;
        /* It is a flex item in an overflowing column — without this the
           default flex-shrink collapses it to zero height. */
        flex: 0 0 auto;
        background: linear-gradient(to top, var(--rail-shadow), transparent);
      }
      @supports (animation-timeline: scroll()) {
        #rail-title::after {
          animation: rail-shadow-in linear both;
          animation-timeline: scroll(nearest);
          animation-range: 0 16px;
        }
        #rail-fade {
          animation: rail-shadow-out linear both;
          animation-timeline: scroll(nearest);
          animation-range: calc(100% - 16px) 100%;
        }
      }
      @keyframes rail-shadow-in {
        to {
          opacity: 1;
        }
      }
      @keyframes rail-shadow-out {
        from {
          opacity: 1;
        }
      }
      .orphan {
        margin-top: 8px;
        padding: 6px 9px;
        border: 1px solid color-mix(in srgb, var(--fg-red) 45%, var(--divider));
        background: color-mix(in srgb, var(--fg-red) 8%, var(--bg-elevated));
        border-radius: 6px;
      }
      .orphan-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--fg-red);
        overflow-wrap: anywhere;
      }
      .orphan-reason {
        margin-top: 2px;
        font-size: 10px;
        color: var(--text-sec);
        overflow-wrap: anywhere;
      }
      ::slotted(std-stack-log) {
        padding: 0 8px 12px 4px;
      }

      /* ---- the panel: the rail given over to one subject ---------------- */

      /* A MODAL, not a region. It does not fill the rail edge to edge and it
         does not sit in the rail's own surface: it is an inset card floating
         on --bg-elevated, which is the shape lona.so gives its docked panels
         and the reason one reads as "a thing that arrived" rather than "the
         sidebar changed". The inset is asymmetric on purpose — the rail's
         right edge is a real border against the pane, so the card keeps a
         little more clearance there. */
      #panel {
        display: none;
        flex: 1;
        min-height: 0;
        flex-direction: column;
        /* The containing block for the floating surface and the close
           button, both of which are absolutely positioned. */
        position: relative;
        /* std-round[floating] paints at z-index: -1, which without a stacking
           context here means BEHIND this element's ancestors — the surface
           renders at exactly the right size and is never seen (observed: the
           card had correct geometry and no visible fill or shadow at all).
           Isolating scopes that -1 to the panel's own layer. */
        isolation: isolate;
        /* Even inline margins, and none at the bottom: the card is flush to
           the rail's bottom edge and its surface runs past it (see
           PANEL_BLEED_PX), so the rail's own clip crops the card instead of
           the card stopping short of the edge. */
        margin: 4px 4px 0 4px;
      }
      /* Pinned to the width the rail is HEADING for, not to the width it
         currently has. Stretching the card to the rail would make the thread
         inside it re-lay-out on every frame of the tween — an iframe
         re-measuring 220ms in a row — and the operator would watch the
         transcript rewrap itself open. A definite cross size instead: the
         card is laid out once, at its final size, and the rail's travelling
         edge clips it until it fits. The 8px is the inline margin below. */
      :host([panel-open]) #panel {
        display: flex;
        width: calc(var(--rail-panel-w, 100%) - 8px);
      }
      :host([panel-open]) #rail-title,
      :host([panel-open]) #rail-fade {
        display: none;
      }
      /* Hide the SLOT, not the slotted content. A slotted element is styled
         from the outer scope, so a display:none written through ::slotted()
         loses to any inline display the owner happens to have set on it — and
         losing here means the panel opens UNDERNEATH a still-visible list
         (observed). The slot is a shadow-root element the light DOM cannot
         reach, so hiding it takes the assigned nodes out of rendering with
         nothing left to override it. */
      :host([panel-open]) #body {
        display: none;
      }
      /* The frozen list. A slotted element is sized from the outer scope, so
         the freeze rides a custom property the host writes and the slotted
         children read — and it holds while the rail is wide, which is the
         whole point: the list keeps the geometry it had before the panel
         opened, so coming back costs nothing. flex is pinned too, or the
         column would stretch them back out. */
      :host([panel-frozen]) ::slotted(*) {
        width: var(--rail-frozen-w);
        flex: 0 0 auto;
      }
      /* The card owns the whole column while it is up, so the rail must not
         also try to scroll behind it. */
      :host([panel-open]) {
        overflow: hidden;
      }
      /* Room for the close button, which floats over this row rather than
         sitting in it — the header is a label, not a toolbar. */
      #panel-head {
        display: flex;
        align-items: center;
        padding: 14px 52px 10px 16px;
        flex: 0 0 auto;
      }
      #panel-title {
        --margin-top: 0px;
        --margin-bottom: 0px;
        flex: 1;
        min-width: 0;
        color: var(--text-sec);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      /* std-modal-close-button positions itself at top: 16px and takes its
         static horizontal position, which in a column is the LEFT edge. The
         title lives there, so it is pushed to the right edge instead; its own
         16px inline margin keeps it off the corner. */
      #panel-close {
        top: 10px;
        right: 0;
      }
      /* The content's box, clipped to the card's lower corners. The surface
         behind it is a squircle drawn by std-round, but an iframe cannot be
         clipped by a background — it needs a real clip of its own, and a
         plain radius is the only thing that gives one. Slightly tighter than
         the card's own radius so the corner reads as one curve rather than
         two. */
      #panel-body {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        /* No bottom rounding to match: those corners are below the rail's
           edge and never drawn. Rounding them here would clip the content
           against a curve nobody can see. */
        border-radius: 0;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="rail-title">
      <div id="rail-head">
        <span id="rail-name">
          <span id="view-toggle">
            <span class="vseg active" data-view="stack">stack</span>
            <span class="vseg" data-view="inbox">inbox</span>
          </span>
        </span>
        <std-icon-button id="mode-toggle" squarish></std-icon-button>
        <std-icon-button id="columns" squarish data-tip="Choose columns"></std-icon-button>
        <std-icon-button id="reload" squarish data-tip="Reload the stack"></std-icon-button>
        <std-icon-button id="collapse" squarish data-tip="Collapse rail"></std-icon-button>
      </div>
      <div id="tabs"><!-- one .tab per configured repo (the owner binds) --></div>
      <div id="orphans" style="display: none"></div>
    </div>
    <slot id="body"></slot>
    <div id="rail-fade"></div>
    <div id="panel">
      <std-round id="panel-bg"></std-round>
      <div id="panel-head">
        <p id="panel-title" class="small"></p>
      </div>
      <std-modal-close-button id="panel-close"></std-modal-close-button>
      <div id="panel-body"></div>
    </div>
    <div id="btn-tip" role="tooltip"></div>
  `;
}

export namespace ReviewRail {
  /** Which face the rail is showing. */
  export type View = "stack" | "inbox";
}
