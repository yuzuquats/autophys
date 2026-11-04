import "@tento-ui/components/logging/scroll-bar";
import "@tento-ui/components/logging/span-row";
import "@tento-scroll/vertical/scroll-vertical";

import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { ScrollBar } from "@tento-ui/components/logging/scroll-bar";
import { SpanRow } from "@tento-ui/components/logging/span-row";
import { ScrollVertical } from "@tento-scroll/vertical/scroll-vertical";
import { GESTURE_MANAGER } from "@tento-ui/gesture-manager";
import { Scrollbars } from "@tento-ui/components/scrollbars";

@component({ name: "std-log-viewer" })
export class LogViewer extends LonaWebComponent {
  private $scroll: ScrollVertical<SpanRow> = this.hydrate("scroll");
  private $scrollBar: ScrollBar = this.hydrate("scroll-bar");
  private spans: SpanRow.Props[] = [];

  constructor() {
    super();
    GESTURE_MANAGER.addPointerEvent(this.$("scroll-to-bottom-btn"), {
      onClick: () => {
        if (this.spans.length === 0) return;
        this.$scroll.scrollEngine.bindIndex(this.spans.length - 1, {
          kind: "reveal",
          at: {
            position: "end",
            scrollBehavior: "smooth",
            useNativeScrollTo: false,
          },
          viewportChangeSource: "bind",
        });
      },
    });
  }

  bind(spans: SpanRow.Props[]) {
    this.spans = spans;

    this.$scroll.initialize({
      onCreate: () => SpanRow.make(),
      onBind: ($row, index) => {
        const span = this.spans[index];
        $row.bind(span);
        $row.setAttribute("span-id", String(span.id));
        $row.setAttribute("session-id", span.sessionId);
        if (span.meta.parentId != null && span.meta.parentId !== span.id) {
          $row.style.setProperty("--content-margin-left", "14px");
        } else {
          $row.style.setProperty("--content-margin-left", "0px");
        }
      },
      onScroll: () => {
        const info = this.$scroll.getScrollInfo();
        if (!info) return;
        const atBottom =
          info.scrollHeight - info.top <= this.$scroll.offsetHeight + 2;
        this.$("scroll-to-bottom-btn").toggleAttribute("disabled", atBottom);

        // Sync scroll-bar cursor based on visible bottom row
        const cellHeight = 28;
        const bottomIndex = Math.min(
          Math.floor((info.top + this.$scroll.offsetHeight) / cellHeight),
          this.spans.length - 1,
        );
        if (bottomIndex >= 0 && bottomIndex < this.spans.length) {
          this.$scrollBar.setCursorOffset(this.spans[bottomIndex]);
        }
      },
    });

    this.$scroll.bind({
      cellHeightPx: 28,
      maxIndex: spans.length - 1,
      initialIndex: spans.length - 1,
    });

    this.$scrollBar.bind(spans);
    this.$scrollBar.onScrollToSpan = (s) => {
      const span = s as SpanRow.Props;
      const index = this.spans.indexOf(span);
      if (index !== -1) {
        // This passed NO options at all, which the old bag resolved to a move
        // at `position: "start"` / `"auto"` with the map and content left
        // alone — a `reveal`.
        this.$scroll.scrollEngine.bindIndex(index, {
          kind: "reveal",
          at: {
            position: "start",
            scrollBehavior: "auto",
            useNativeScrollTo: false,
          },
          viewportChangeSource: "bind",
        });
      }
    };
  }

  static $styles = [
    Scrollbars.$hideScrollbars,
    css`
      :host {
        display: flex;
        flex-direction: row;
        height: 100%;
        width: 100%;
        background: #282828;
        border-radius: 8px;
        color: #eee;
        --span-row-text: #ccc;
        --span-row-timestamp: #999;
        --span-row-hover-bg: rgba(255, 255, 255, 0.08);
      }

      #scroll {
        flex-grow: 1;
        height: 100%;
        padding: 4px;
        display: block;
      }

      #sidebar {
        margin-left: 4px;
      }

      #scroll-bar {
        flex-grow: 1;
        margin-bottom: 4px;
      }

      #scroll-to-bottom-btn {
        width: 32px;
        height: 32px;
        background: #282828;
        border-radius: 8px;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }

      #scroll-to-bottom-btn:not([disabled]):hover {
        background: #a6a6a6;
      }

      #scroll-to-bottom-btn svg {
        width: 20px;
        height: 20px;
        color: #eee;
      }

      #scroll-to-bottom-btn[disabled] {
        cursor: default;
      }

      #scroll-to-bottom-btn[disabled] svg {
        color: #aaa;
        cursor: default;
      }
    `,
  ];

  static $html = html`
    <std-scroll-vertical id="scroll"></std-scroll-vertical>
    <std-col id="sidebar" style="margin-left:4px;">
      <std-scroll-bar id="scroll-bar"></std-scroll-bar>
      <button id="scroll-to-bottom-btn">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="currentColor"
          viewBox="0 0 16 16"
        >
          <path
            fill-rule="evenodd"
            d="M1 3.5a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 0 1h-13a.5.5 0 0 1-.5-.5M8 6a.5.5 0 0 1 .5.5v5.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 0 1 .708-.708L7.5 12.293V6.5A.5.5 0 0 1 8 6"
          />
        </svg>
      </button>
    </std-col>
  `;
}
