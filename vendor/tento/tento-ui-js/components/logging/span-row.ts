import { LonaWebComponent, html } from "@tento-ui/component";
import { Span } from "@tento-ui/component-builtin";
import { component } from "@tento-ui/component-decorators";
import { css } from "../../component-styles";
import { DomUtils } from "../../dom";

@component({
  name: "std-span-row",
})
export class SpanRow extends LonaWebComponent {
  span: Option<SpanRow.Props>;
  top: Option<number>;

  static LEVELS: Map<string, { short: string; color: string }> = new Map([
    ["TRACE", { short: "t", color: "black" }],
    ["DEBUG", { short: "d", color: "black" }],
    ["INFO", { short: "i", color: "#999cfe" }],
    ["WARN", { short: "w", color: "#fbd55a" }],
    ["ERROR", { short: "e", color: "#fe887c" }],
  ]);

  connectedCallback() {
    this.onresize = () => (this.top = this.offsetTop);
  }

  bind(span: SpanRow.Props) {
    DomUtils.clearChildren(this.$("metadata"));

    this.span = span;
    this.$("level").textContent =
      SpanRow.LEVELS.get(span.meta.level)?.short ?? "?";
    this.$("level-icon").style.background =
      SpanRow.LEVELS.get(span.meta.level)?.color ?? "black";
    const date = new Date(span.timestamp);
    this.$("timestamp").textContent = date.toLocaleDateString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });

    if (span.meta.name === "HTTP request") {
      let status = 0;
      for (const r of span.records) {
        const foundStatus = Number.parseInt(r["http.status_code"] ?? "0");
        if (foundStatus !== 0) {
          status = foundStatus;
          break;
        }
      }
      const $status = Span.make();
      $status.textContent = `${status}`.padStart(3, " ");
      $status.style.marginLeft = "2px";
      $status.style.whiteSpaceCollapse = "preserve";
      // https://developer.mozilla.org/en-US/docs/Web/HTTP/Status
      $status.style.color = ["gray", "blue", "green", "yellow", "red"][
        Math.floor(status / 100)
      ];
      this.$("metadata").appendChild($status);

      const $line = Span.make();
      $line.style.marginLeft = "8px";
      $line.textContent = `${span.initialAttributes["http.client_ip"]} ${
        span.initialAttributes["http.method"]
      } ${span.initialAttributes["http.route"]}`;
      this.$("metadata").appendChild($line);
    } else {
      this.$("metadata").innerHTML = `${span.meta.name}`;
      // for (const [k, v] of Object.entries(this.span.initialAttributes)) {
      //   if (k.startsWith("http.") || k.startsWith("otel.")) continue;
      //   const $attribute = Div.make();
      //   $attribute.textContent = `${k} = ${v}`;
      //   this.$("attributes").appendChild($attribute);
      // }

      // for (const records of this.span.records) {
      //   for (const [k, v] of Object.entries(records)) {
      //     if (k.startsWith("http.") || k.startsWith("otel.")) continue;
      //     const $attribute = Div.make();
      //     $attribute.textContent = `${k} = ${v}`;
      //     this.$("attributes").appendChild($attribute);
      //   }
      // }
    }
  }

  static $styles = [
    css`
      #root {
        padding: var(--padding, 4px);
        margin: var(--margin, 1px 2px);
        border-radius: 4px;
        color: var(--span-row-text, var(--text-sec));
      }

      #root:hover {
        background-color: var(--span-row-hover-bg, rgba(0, 0, 0, 0.06));
      }

      #root p {
        --font-size: var(--text-8px);
      }

      #level-icon {
        width: 14px;
        height: 14px;
        background-color: var(--span-row-level-bg, black);
        color: var(--span-row-level-text, white);
        border-radius: 4px;
        margin-right: 8px;
      }

      #timestamp {
        color: var(--span-row-timestamp, #888);
        margin-right: 4px;
      }

      #content {
        margin-left: var(--content-margin-left);
        align-items: center;
      }

      ::slotted(*) {
        --span-row-hover-bg: transparent;
        --margin: 4px 0px 0px 0px;
        --padding: 4px 0px 0px 16px;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-row id="content">
        <p id="metadata"></p>
        <std-spacer></std-spacer>
        <std-center id=level-icon>
          <p id="level"></p>
        </std-center>
        <p id="timestamp"></p>
      </std-row>
      <slot name="nested"></slot>
    </std-col>
  `;
}

export namespace SpanRow {
  export type Props = {
    id: number;
    timestamp: RFC3339;
    sessionId: string;
    meta: {
      parentId: Option<number>;
      name: string;
      file: Option<string>;
      modulePath: Option<string>;
      target: string;
      line: Option<number>;
      level: string;
    };
    initialAttributes: Object;
    records: Object[];
    elapsedTime: Option<number>;
  };
}
