import { LonaWebComponent, html } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css } from "@tento-ui/component-styles";

/**
 * Level for span messages - aligns with Rust tracing levels.
 */
export type SpanLevel = "trace" | "debug" | "info" | "warn" | "error";

/**
 * Single-character display for each level.
 */
const LEVEL_CHAR: Record<SpanLevel, string> = {
  trace: "T",
  debug: "D",
  info: "I",
  warn: "W",
  error: "E",
};

/**
 * Discriminated union for span line data.
 */
export type SpanLineData =
  | {
      type: "header";
      level: SpanLevel;
      label: string;
      timestamp: string;
      duration?: string | undefined;
    }
  | { type: "message"; level: SpanLevel; text: string }
  | { type: "attribute"; key: string; value: string };

@component({
  name: "std-span-line",
})
export class SpanLine extends LonaWebComponent {
  private $level: HTMLElement = this.$("level");
  private $content: HTMLElement = this.$("content");

  static makeWith(data: SpanLineData): SpanLine {
    const $line = SpanLine.make();
    $line.bind(data);
    return $line;
  }

  bind(data: SpanLineData): this {
    if (data.type === "header") {
      this.$level.textContent = LEVEL_CHAR[data.level];
      this.$level.className = `level-${data.level}`;

      let content = data.label;
      if (data.timestamp) {
        content += `  ${data.timestamp}`;
      }
      if (data.duration) {
        content += `  ${data.duration}`;
      }
      this.$content.textContent = content;
      this.$content.className = "";
    } else if (data.type === "message") {
      this.$level.textContent = LEVEL_CHAR[data.level];
      this.$level.className = `level-${data.level}`;
      this.$content.textContent = data.text;
      this.$content.className = "";
    } else {
      this.$level.textContent = "";
      this.$level.className = "attr";
      this.$content.textContent = `${data.key}: ${data.value}`;
      this.$content.className = "attr";
    }

    return this;
  }

  static $styles = [
    css`
      :host {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 0;
      }

      p {
        --margin-top: 0px;
        --margin-bottom: 0px;
        --font-size: var(--text-8px);
      }

      #level {
        width: 16px;
        text-align: center;
        padding: 1px 4px;
        border-radius: 3px;
        flex-shrink: 0;
      }

      #level.attr {
        background: none;
      }

      #level.level-trace {
        background: var(--gray-dimmed);
        color: var(--gray);
      }

      #level.level-debug {
        background: var(--purple-dimmed);
        color: var(--purple);
      }

      #level.level-info {
        background: var(--blue-dimmed);
        color: var(--blue);
      }

      #level.level-warn {
        background: var(--yellow-dimmed);
        color: var(--yellow);
      }

      #level.level-error {
        background: var(--red-dimmed);
        color: var(--red);
      }

      #content {
        color: var(--text-pri);
      }

      #content.attr {
        color: var(--text-ter);
        font-family: monospace;
      }
    `,
  ];

  static $html = html`
    <p id="level"></p>
    <p id="content"></p>
  `;
}
