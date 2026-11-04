import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { CalloutParser } from "../../review-dsl/block-parsers";
import { NotesInline } from "./notes-inline";

// Admonition for review notes, authored as
//   ```review-callout risk unwrap on the hot path
//   body lines (backtick code + **bold** supported)
//   ```
// Kinds carry review semantics: note (context), warning (behavior change),
// risk (needs reviewer attention), decision (why not the alternative).

const GLYPHS: Record<CalloutParser.Kind, string> = {
  note: "",
  warning: "△",
  risk: "▲",
  decision: "◆",
};

@component({ name: "std-review-callout" })
export class ReviewCallout extends LonaWebComponent {
  private $head: HTMLElement = this.$("head");
  private $body: HTMLElement = this.$("body");

  bind({ callout }: ReviewCallout.Props): void {
    this.setAttribute("kind", callout.kind);
    const $kind = document.createElement("span");
    $kind.className = "kind";
    $kind.textContent = callout.kind;
    const headChildren: HTMLElement[] = [];
    const glyph = GLYPHS[callout.kind];
    if (glyph !== "") {
      const $glyph = document.createElement("span");
      $glyph.className = "glyph";
      $glyph.textContent = glyph;
      headChildren.push($glyph);
    }
    headChildren.push($kind);
    if (callout.title != null) {
      const $title = document.createElement("span");
      $title.className = "title";
      $title.appendChild(NotesInline.$format(callout.title));
      headChildren.push($title);
    }
    this.$head.replaceChildren(...headChildren);
    this.$body.replaceChildren(
      ...callout.body.map((line) => {
        const $line = document.createElement("div");
        $line.className = line === "" ? "gap" : "line";
        if (line !== "") $line.appendChild(NotesInline.$format(line));
        return $line;
      }),
    );
  }

  static $styles = [
    css`
      :host {
        display: block;
        margin-block: 16px;
        border-left: 3px solid currentColor;
        border-radius: 0;
        padding: 8px 12px;
        color: var(--fg-blue);
        background:
          linear-gradient(color-mix(in srgb, currentColor 6%, transparent),
          color-mix(in srgb, currentColor 6%, transparent));
      }
      :host([kind="warning"]) {
        color: var(--fg-yellow, var(--yellow-deep));
      }
      :host([kind="risk"]) {
        color: var(--fg-red);
      }
      :host([kind="decision"]) {
        color: var(--fg-purple);
      }
      #head {
        display: flex;
        align-items: baseline;
        gap: 7px;
        font-size: 12.5px;
      }
      .glyph {
        font-size: 12px;
      }
      /* The kind IS the callout's headline — it was set smaller than the body
       * it introduces, which read as a caption rather than a label. */
      .kind {
        font-size: 12px;
        font-weight: 700;
      }
      .title {
        color: var(--text-pri);
        font-weight: 600;
      }
      #body {
        margin-top: 4px;
        color: var(--text-pri);
        font-size: 12px;
        line-height: 1.5;
      }
      .gap {
        height: 6px;
      }
      code {
        font-family: var(--mono, ui-monospace, monospace);
        font-size: 11px;
        background: var(--bg-surface, rgba(128, 128, 128, 0.12));
        padding: 1px 4px;
        border-radius: 3px;
      }
    `,
  ];

  static $html = html`
    <div id="head"></div>
    <div id="body"></div>
  `;
}

export namespace ReviewCallout {
  export type Props = { callout: CalloutParser.Callout };
}
