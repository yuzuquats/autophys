import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { ErrorSummary } from "./error-summary";
import { ExceptionHighlight } from "./exception-highlight";

// The technical half of a failure: where it happened, the stack, and any raw
// supporting text. Deliberately has NO surface of its own — no background, no
// border, no padding — because it is always shown inside something that has
// already established "this is an error":
//
//   * `<std-exception>`, which supplies the red bar and the code well, or
//   * a `Toast.error`, which is already red and carries its own title.
//
// Giving it a surface is the thing to resist: nested error chrome (a red block
// inside a red toast) is how this ends up looking wrong. It inherits its colour
// from the host instead, so the same markup reads correctly on a red field and
// on a plain one.
//
// That inheritance is also why the highlighting is written the way it is. A
// component with no surface does not know what it is sitting on, so it cannot
// reach for `--fg-syntax-*`: green-on-red is not a colour scheme. Every token
// class therefore resolves `var(--exc-<token>, <mix of currentColor>)` — the
// default is the host's own colour at a different weight, which is legible on
// anything, and a host that DOES own a neutral surface (see `#well` in
// `std-exception`) overrides the four properties with real hues.
@component({ name: "std-exception-trace" })
export class ExceptionTrace extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  static makeWith(p: ExceptionTrace.Props): ExceptionTrace {
    const $c = ExceptionTrace.make();
    $c.bind(p);
    return $c;
  }

  /** Whether there is anything at all to show — lets a caller skip the element
   *  instead of appending one that renders nothing. */
  static isEmpty(p: ExceptionTrace.Props): boolean {
    // A header-only stack (a failed dynamic import's) renders no frames.
    return !p.filename && !ErrorSummary.frames(p.stack) && !p.detail;
  }

  bind(p: ExceptionTrace.Props): this {
    const $blocks: HTMLElement[] = [];
    if (p.filename) {
      // The same tokenizer as everything else, so the location line and the
      // frames that repeat it are coloured identically rather than one being
      // plain text that happens to say the same thing.
      $blocks.push(
        ExceptionTrace.$block("loc", `${p.filename}${p.lineno ? `:${p.lineno}` : ""}`),
      );
    }
    if (p.stack) {
      // Only the frames: V8's header lines repeat the message, which the
      // surface above is already showing (Firefox and Safari have no header —
      // see `ErrorSummary.frames`). The frames keep their file paths —
      // stripping them left `at render (:4821:12)`, which is neither copyable
      // nor readable; highlighting is what makes the repetition bearable.
      const frames = ErrorSummary.frames(p.stack);
      if (frames) $blocks.push(ExceptionTrace.$block("stack", frames));
    }
    // Raw text that is NOT a stack — a compiler diagnostic, a remediation hint.
    // Kept separate because `stack` drops its first line and this must not drop
    // anything, and because calling bun's stderr a stack would be a lie.
    if (p.detail) $blocks.push(ExceptionTrace.$block("detail", p.detail));
    this.$root.replaceChildren(...$blocks);
    return this;
  }

  /** One `<pre>` of highlighted lines. Rendered into the SHADOW root, not the
   *  light DOM: a shadow stylesheet can reach `::slotted(pre)` but nothing
   *  inside it, so light-DOM rendering would leave every token span unstyled —
   *  which is the whole feature. */
  private static $block(kind: string, text: string): HTMLElement {
    const $pre = document.createElement("pre");
    $pre.className = `block ${kind}`;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) $pre.appendChild(document.createTextNode("\n"));
      for (const tok of ExceptionHighlight.tokenize(line)) {
        if (tok.kind === "text") {
          $pre.appendChild(document.createTextNode(tok.text));
          continue;
        }
        const $s = document.createElement("span");
        $s.className = `t-${tok.kind}`;
        $s.textContent = tok.text;
        $pre.appendChild($s);
      }
    });
    return $pre;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        /* Inherited, never set: see the note above on nested error chrome. */
        color: inherit;
        /* The design system's spacing convention, which every Typography
           element already honours. A host positions its children by setting
           these — std-toast's #description sets --margin-top: 8px — so an
           element that ignores them sits flush against the title above it.
           That is exactly what a Toast.error looked like once the description
           stopped being a Typography.p and became this component. */
        margin-top: var(--margin-top, 0px);
        margin-bottom: var(--margin-bottom, 0px);
      }

      #root {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .block {
        margin: 0;
        /* A diagnostic's newlines are the whole point, and a stack frame's path
           must wrap rather than widen the column it is sitting in. */
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        tab-size: 2;
        font: 11px/1.6 var(--mono, "SF Mono", "Fira Code", Menlo, Consolas, monospace);
      }

      /* The location line names the same file the frames do; it earns its place
         by being the one line that is not indented, so give it the weight and
         let the frames stay quiet. */
      .loc {
        font-weight: 500;
      }

      .detail {
        margin-top: 2px;
      }

      /* Every token falls back to a mix of the HOST's colour — see the note at
         the top of this file for why the defaults cannot be --fg-syntax-*.
         NB: no backticks or dollar-braces in these comments; this is a tagged
         template and both are parsed rather than treated as text. */
      .t-keyword {
        color: var(--exc-keyword, color-mix(in srgb, currentColor 52%, transparent));
      }

      .t-severity {
        color: var(--exc-severity, currentColor);
        font-weight: 600;
      }

      .t-callee {
        color: var(--exc-callee, currentColor);
      }

      .t-path {
        color: var(--exc-path, color-mix(in srgb, currentColor 88%, transparent));
      }

      .t-position {
        color: var(--exc-position, color-mix(in srgb, currentColor 62%, transparent));
      }

      .t-string {
        color: var(--exc-string, currentColor);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root"></div>
  `;
}

export namespace ExceptionTrace {
  export type Props = {
    filename?: Option<string>;
    lineno?: Option<number>;
    /** A real stack. Its header (V8's `Name: message`) is dropped — it repeats
     *  the message. */
    stack?: Option<string>;
    /** Raw supporting text that is not a stack. Rendered verbatim; newlines
     *  kept, nothing dropped. */
    detail?: Option<string>;
  };
}
