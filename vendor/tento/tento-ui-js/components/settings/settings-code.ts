import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";

// A structured setting value shown as code: JSON pretty-printed with two-space
// indents, fully expanded, syntax-tinted, on a quiet tint of its own. It is
// the value of a stacked row (`Settings.json`), so it spans the row under the
// label; a long line scrolls inside the block rather than widening the page.
// It renders itself — no editor or highlighter is loaded — so it works in an
// offline document, and user strings are text nodes, never markup.
@component({ name: "std-settings-code" })
export class SettingsCode extends LonaWebComponent {
  static makeWith(value: unknown): SettingsCode {
    return SettingsCode.make().bind(value);
  }

  bind(value: unknown): this {
    const text = JSON.stringify(value, null, 2) ?? String(value);
    const $code = this.$("code");
    $code.replaceChildren();
    let last = 0;
    for (const match of text.matchAll(TOKEN)) {
      const at = match.index ?? 0;
      if (at > last) $code.append(text.slice(last, at));
      const $token = document.createElement("span");
      $token.className = match[2] ? "key" : match[1] ? "string" : match[3] ? "literal" : "number";
      $token.textContent = match[1] ?? match[0];
      $code.append($token);
      if (match[2]) $code.append(match[2]);
      last = at + match[0].length;
    }
    $code.append(text.slice(last));
    return this;
  }

  /** The formatted text, as it reads. */
  get text(): string {
    return this.$("code").textContent ?? "";
  }

  static $styles = [
    css`
      :host {
        display: block;
        min-width: 0;
        width: 100%;
      }

      pre {
        margin: 0;
        padding: var(--settings-code-padding, 6px 8px);
        box-sizing: border-box;
        width: 100%;
        overflow-x: auto;
        border-radius: var(--settings-code-radius, 8px);
        background: var(--settings-code-bg, light-dark(rgb(0 0 0 / 0.045), rgb(255 255 255 / 0.06)));
        color: var(--text-pri);
        font: 12px/1.55 "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
        white-space: pre;
        tab-size: 2;
      }

      code {
        font: inherit;
      }

      .key {
        color: var(--fg-syntax-keyword, #a626a4);
      }

      .string {
        color: var(--fg-syntax-string, #50a14f);
      }

      .number,
      .literal {
        color: var(--fg-syntax-number, #986801);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`<pre id="root"><code id="code"></code></pre>`;
}

// A string (and whether a colon follows it, making it a key), a literal, or a number.
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
