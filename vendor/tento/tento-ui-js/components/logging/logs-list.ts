import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";
import { ScrollShadows } from "@tento-ui/ui/scroll-shadows";
import { SpanLine, SpanLineData, SpanLevel } from "./span-line";

// Re-export types from span-line for external use
export type { SpanLineData, SpanLevel } from "./span-line";

/**
 * Standard span data structure for rendering - aligns with Rust tracing spans.
 * Raw log data should be converted to this format via RenderConfig.
 */
export interface SpanData {
  /** Span name/label */
  label: string;
  /** Formatted timestamp string for display */
  timestamp: string;
  /** Duration text (e.g., "123ms") - optional */
  duration?: string;
  /** Log level for the span */
  level: SpanLevel;
  /** Flat list of lines within the span */
  lines: SpanLineData[];
}

/**
 * Configuration for rendering raw log data.
 */
export interface RenderConfig<T> {
  /** Convert raw log entry to standardized span format */
  toSpanData(raw: T): SpanData;
  /** Empty state message */
  emptyMessage?: string;
}

@component({
  name: "std-logs-list",
})
export class LogsList<T = SpanData> extends LonaWebComponent {
  private $scrollContainer: HTMLElement = this.$("scroll-container");
  private $container: HTMLElement = this.$("container");
  private $empty: HTMLElement = this.$("empty");
  private resizeObserver: Option<ResizeObserver> = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.$scrollContainer.addEventListener("scroll", this.updateScrollShadows);

    this.resizeObserver = new ResizeObserver(() => {
      this.updateScrollShadows();
    });
    this.resizeObserver.observe(this.$scrollContainer);

    this.updateScrollShadows();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.$scrollContainer.removeEventListener("scroll", this.updateScrollShadows);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private updateScrollShadows = (): void => {
    ScrollShadows.updateScrollShadows(this, this.$scrollContainer);
  };

  bind(props: LogsList.Props<T>): this {
    this.$container.replaceChildren();

    const renderConfig = props.renderConfig;
    const emptyMessage = renderConfig?.emptyMessage ?? "No logs available";
    this.$empty.textContent = emptyMessage;

    if (props.logs.length === 0) {
      this.$empty.style.display = "flex";
      this.updateScrollShadows();
      return this;
    }

    this.$empty.style.display = "none";

    for (const raw of props.logs) {
      const spanData = renderConfig
        ? renderConfig.toSpanData(raw)
        : (raw as SpanData);
      const $span = LogSpan.makeWith(spanData);
      this.$container.appendChild($span);
    }

    this.updateScrollShadows();
    return this;
  }

  static $styles = [
    ScrollShadows.$styles,
    css`
      :host {
        display: block;
        height: 100%;
        position: relative;
      }

      #scroll-container {
        height: 100%;
        overflow-y: auto;
      }

      #container {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      #empty {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-ter);
      }
    `,
  ];

  static $html = html`
    <div class="scroll-shadow-top"></div>
    <div class="scroll-shadow-bottom"></div>
    <div id="scroll-container">
      <div id="container"></div>
      <div id="empty">No logs available</div>
    </div>
  `;
}

export namespace LogsList {
  export type Props<T = SpanData> = {
    logs: T[];
    /** Config to convert raw logs to span format. If omitted, logs are treated as SpanData. */
    renderConfig?: RenderConfig<T>;
  };
}

@component({
  name: "std-log-span",
})
export class LogSpan extends LonaWebComponent {
  private $lines: HTMLElement = this.$("lines");

  static makeWith(span: SpanData): LogSpan {
    const $s = LogSpan.make();
    $s.bind(span);
    return $s;
  }

  bind(span: SpanData): this {
    this.$lines.replaceChildren();

    // Header line
    const $header = SpanLine.makeWith({
      type: "header",
      level: span.level,
      label: span.label,
      timestamp: span.timestamp,
      duration: span.duration,
    });
    this.$lines.appendChild($header);

    // Content lines
    for (const lineData of span.lines) {
      const $line = SpanLine.makeWith(lineData);
      this.$lines.appendChild($line);
    }

    return this;
  }

  static $styles = [
    css`
      :host {
        display: block;
        padding: 8px 12px;
        background: var(--bg-surface-light);
        border-radius: 6px;
        border: 1px solid var(--divider);
      }

      #lines {
        display: flex;
        flex-direction: column;
      }
    `,
  ];

  static $html = html`
    <div id="lines"></div>
  `;
}
