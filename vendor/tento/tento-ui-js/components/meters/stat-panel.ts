import "./stat-line";
import "./usage-meter";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Typography } from "../../ui/typography";
import { Divider } from "../divider";
import { Shimmer } from "../shimmer";
import { StatLine } from "./stat-line";
import { UsageMeter } from "./usage-meter";

// A titled stats panel: a header (title + right-aligned meta) over a
// fixed-rhythm body showing one of three states — a loading pulse, a failure
// line, or a stack of metric rows (usage meters / stat lines) — plus an
// optional footer strip. bind() builds the frame once; setState()/setMeta()
// refill the body/meta IN PLACE so progressive per-panel updates never shift
// sibling panels. The pulse height is tuned to the loaded content via
// `--stat-panel-pulse-height` so the pending → loaded swap doesn't reflow.
@component({ name: "std-stat-panel" })
export class StatPanel extends LonaWebComponent {
  private $title: HTMLElement = this.$("title");
  private $meta: HTMLElement = this.$("meta");
  private $body: HTMLElement = this.$("body");
  private $footerLabel: HTMLElement = this.$("footer-label");
  private $footerTag: HTMLElement = this.$("footer-tag");

  bind(props: StatPanel.Props): void {
    if (this.$title.textContent !== props.title) this.$title.textContent = props.title;
    this.setMeta(props.meta);
    this.toggleAttribute("has-footer", props.footer != null);
    if (props.footer != null) {
      if (this.$footerLabel.textContent !== props.footer.label) {
        this.$footerLabel.textContent = props.footer.label;
      }
      if (this.$footerTag.textContent !== props.footer.tag) {
        this.$footerTag.textContent = props.footer.tag;
      }
    }
  }

  /** Refresh the header's right-aligned meta text in place. */
  setMeta(meta: string): void {
    if (this.$meta.textContent !== meta) this.$meta.textContent = meta;
  }

  /** Swap the body to the given state — nothing outside the body moves. */
  setState(state: StatPanel.State): void {
    if (state.kind === "pending") {
      const $pulse = this.$body.querySelector<HTMLElement>(":scope > .body-pulse") ??
        document.createElement("div");
      $pulse.classList.add("pulse", "body-pulse");
      this.reconcileBody([$pulse]);
      return;
    }
    if (state.kind === "failure") {
      const $failure = this.$body.querySelector<HTMLElement>(":scope > .failure") ??
        document.createElement("span");
      $failure.classList.add("text", "metric", "failure");
      if ($failure.textContent !== state.message) $failure.textContent = state.message;
      this.reconcileBody([$failure]);
      return;
    }
    const desired = state.rows.map((row, index) => {
      const $current = this.$body.children.item(index);
      if (row.kind === "meter" && $current instanceof UsageMeter) {
        $current.bind(row.meter);
        return $current;
      }
      if (row.kind === "line" && $current instanceof StatLine) {
        $current.bind(row.line);
        return $current;
      }
      return StatPanel.$row(row);
    });
    this.reconcileBody(desired);
  }

  private reconcileBody(desired: HTMLElement[]): void {
    for (let index = 0; index < desired.length; index += 1) {
      const $current = this.$body.children.item(index);
      if ($current !== desired[index]) {
        this.$body.insertBefore(desired[index], $current);
      }
    }
    while (this.$body.children.length > desired.length) {
      this.$body.lastElementChild?.remove();
    }
  }

  static $styles = [
    Typography.$style,
    Shimmer.$style,
    Divider.$hr,
    css`
      :host {
        display: block;
      }
      #header {
        align-items: baseline;
        gap: 10px;
        height: 20px;
      }
      #title {
        --font-size: var(--stat-panel-title-size, var(--h5-size));
      }
      .metric {
        --line-height-ratio: 1;
        font-variant-numeric: tabular-nums;
        color: var(--text-ter);
      }
      #meta {
        margin-left: auto;
        --font-size: var(--stat-panel-meta-size, var(--text-11px));
      }
      #meta:empty { display: none; }
      #body {
        padding-block: 8px;
        gap: 14px;
      }
      /* Matches the loaded rows' content height so the pending → loaded swap
         doesn't shift the panels below (the body is content-sized). */
      .body-pulse {
        height: var(--stat-panel-pulse-height, 150px);
        border-radius: 6px;
      }
      .failure {
        --font-size: var(--text-11px);
      }
      #footer-divider,
      #footer {
        display: none;
      }
      :host([has-footer]) #footer-divider {
        display: block;
      }
      :host([has-footer]) #footer {
        display: flex;
        align-items: baseline;
        gap: 8px;
        height: 15px;
        margin-top: var(--stat-panel-footer-margin-top, 2px);
      }
      #footer-label {
        --font-size: var(--stat-panel-footer-size, var(--text-11px));
      }
      #footer-tag {
        margin-left: auto;
        opacity: 0.7;
        --font-size: var(--stat-panel-footer-size, var(--text-11px));
      }
      #footer-tag:empty { display: none; }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-col id="root">
      <std-row id="header">
        <span id="title" class="h5"></span>
        <span id="meta" class="text metric"></span>
      </std-row>
      <hr />
      <std-col id="body"></std-col>
      <hr id="footer-divider" />
      <std-row id="footer">
        <span id="footer-label" class="text metric"></span>
        <span id="footer-tag" class="text metric"></span>
      </std-row>
    </std-col>
  `;
}

export namespace StatPanel {
  /** A left label + right tag strip below the body (e.g. "history · soon"). */
  export interface Footer {
    label: string;
    tag: string;
  }

  export interface Props {
    title: string;
    meta: string;
    footer: Option<Footer>;
  }

  export type Row =
    | { kind: "meter"; meter: UsageMeter.Props }
    | { kind: "line"; line: StatLine.Props };

  export type State =
    | { kind: "pending" }
    | { kind: "failure"; message: string }
    | { kind: "stats"; rows: Row[] };

  export function $row(row: Row): HTMLElement {
    if (row.kind === "meter") {
      const $meter = UsageMeter.make();
      $meter.bind(row.meter);
      return $meter;
    }
    const $line = StatLine.make();
    $line.bind(row.line);
    return $line;
  }
}
