import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { CalendarMonth } from "./calendar-month";

@component({ name: "std-calendar-month-span" })
export class CalendarMonthSpan extends LonaWebComponent {
  private $title: HTMLElement = this.$("title");
  private $leftHandle: HTMLElement = this.$("left-handle");
  private $rightHandle: HTMLElement = this.$("right-handle");

  bind(
    props: CalendarMonthSpan.Props,
    callbacks?: CalendarMonth.SpanRenderCallbacks,
  ): this {
    const { title, color, segment, showResizeHandles } = props;

    this.$title.textContent = title;
    delete this.dataset.pending;
    this.style.backgroundColor = "";
    this.style.setProperty("--calendar-month-span-color", color);

    // Border radius based on segment position
    const roundLeft = segment.isFirstSegment && !segment.isClippedStart;
    const roundRight = segment.isLastSegment && !segment.isClippedEnd;
    if (roundLeft && roundRight) {
      this.style.borderRadius = "4px";
    } else if (roundLeft) {
      this.style.borderRadius = "4px 0 0 4px";
    } else if (roundRight) {
      this.style.borderRadius = "0 4px 4px 0";
    } else {
      this.style.borderRadius = "0";
    }

    // Show/hide resize handles based on segment position and showResizeHandles flag
    const showLeftHandle = showResizeHandles && segment.isFirstSegment;
    const showRightHandle = showResizeHandles && segment.isLastSegment;

    this.$leftHandle.style.display = showLeftHandle ? "block" : "none";
    this.$rightHandle.style.display = showRightHandle ? "block" : "none";

    this.setCallbacks(callbacks);

    return this;
  }

  /**
   * Re-wire the resize-handle pointerdown handlers. Must be called on
   * every render (including atomic DOM reuse paths) so the closure
   * captures the current `span` object — not the one from when the DOM
   * was first created. Otherwise the handle emits `span.range.end`
   * from a stale span, and the subsequent ResizeSpan gesture's
   * `originalRange` capture is wrong after the first resize.
   */
  setCallbacks(callbacks?: CalendarMonth.SpanRenderCallbacks): void {
    if (!callbacks?.onHandlePointerDown) {
      this.$leftHandle.onpointerdown = null;
      this.$rightHandle.onpointerdown = null;
      return;
    }
    const cb = callbacks.onHandlePointerDown;
    this.$leftHandle.onpointerdown = (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      cb("start");
    };
    this.$rightHandle.onpointerdown = (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();
      cb("end");
    };
  }

  static makeWith(
    props: CalendarMonthSpan.Props,
    callbacks?: CalendarMonth.SpanRenderCallbacks,
  ): CalendarMonthSpan {
    return CalendarMonthSpan.make().bind(props, callbacks);
  }

  static $styles = [
    css`
      :host {
        display: block;
        position: relative;
        height: var(--lane-height, 20px);
        overflow: visible;
        cursor: pointer;
        user-select: none;
        transition: box-shadow 0.15s ease;
      }

      :host([active]),
      :host([data-pending="true"]) {
        box-shadow: rgba(0, 0, 0, 0.6) 0px 1px 3px 0.5px;
        z-index: 1;
      }

      #surface {
        display: flex;
        align-items: center;
        height: 100%;
        padding: 0 6px;
        background: var(--calendar-month-span-color);
        border-radius: inherit;
        overflow: hidden;
      }

      #title {
        color: var(--text-color, var(--text-sec-on-solid));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
      }

      .resize-handle {
        display: none;
        position: absolute;
        top: 0;
        bottom: 0;
        width: 8px;
        cursor: ew-resize;
        z-index: 1;
      }

      .resize-handle.left {
        left: 0;
      }

      .resize-handle.right {
        right: 0;
      }
    `,
  ];

  static $html = html`
    <div id="left-handle" class="resize-handle left"></div>
    <div id="surface">
      <p id="title" class="small"></p>
    </div>
    <div id="right-handle" class="resize-handle right"></div>
  `;
}

export namespace CalendarMonthSpan {
  export type Props = {
    title: string;
    color: string;
    segment: CalendarMonth.SpanSegmentInfo;
    /** Show resize handles on segment edges (left on first, right on last) */
    showResizeHandles?: boolean;
  };
}
