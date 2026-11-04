import "../round";
import "./exception-trace";

import { LonaWebComponent, html } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { ExceptionTrace } from "./exception-trace";

// The generic error block: a red bar stating what went wrong, and a code well
// under it holding the technical detail.
//
// This is what a surface reaches for when something failed and there is nowhere
// else for the news to go — a review note where a figure would have been, a
// panel whose data would not load, a page that caught something at the top
// level. It owns the "this is an error" presentation (the `--sys-red` fill the
// design system already uses for `Toast.error`, and the inverted text that goes
// on it) and delegates everything technical to `<std-exception-trace>`.
//
// TWO SURFACES, NOT ONE FIELD. The first cut put message and trace together on
// one red rectangle, and it read badly for a reason that is worth keeping: a
// stack is code, and code wants a quiet neutral ground and syntax colour, which
// is exactly what a saturated red cannot give it. Splitting them means the bar
// carries the sentence a human reads and the well carries the text a developer
// copies — and the well, being neutral, is where `--fg-syntax-*` can finally be
// used (it sets the `--exc-*` properties the trace resolves against).
//
// The split from `<std-exception-trace>` matters for a different reason: the two
// are needed in different places. A `Toast.error` is ALREADY a red field with
// its own title, so it takes the trace alone — putting a whole `<std-exception>`
// inside one would nest a red block in a red toast. Anywhere without that
// framing takes this, including `Toast.exception`, whose cell drops its own
// red field and title so this component is the whole toast.
@component({ name: "std-exception" })
export class Exception extends LonaWebComponent {
  private $message: HTMLElement = this.$("message");
  private $well: HTMLElement = this.$("well");

  static makeWith(p: Exception.Props): Exception {
    const $c = Exception.make();
    $c.bind(p);
    return $c;
  }

  /** The common case: something was thrown and nobody had a nicer story. */
  static fromError(e: Error, more?: Exception.Trace): Exception {
    return Exception.makeWith({
      message: e.message !== "" ? `${e.name}: ${e.message}` : e.name,
      trace: { stack: e.stack, ...more },
    });
  }

  bind(p: Exception.Props): this {
    this.$message.textContent = p.message;
    const trace = p.trace ?? {};
    // An absent trace and an empty one are the same thing to a reader, so the
    // well is dropped for both rather than leaving an empty panel under the bar.
    const empty = ExceptionTrace.isEmpty(trace);
    this.$well.replaceChildren(...(empty ? [] : [ExceptionTrace.makeWith(trace)]));
    this.$well.toggleAttribute("hidden", empty);
    return this;
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
      }

      /* std-round is the panel, the corner AND the clip: bar and well are handed
         to it as plain children and it forwards them to std-squircle, which owns
         the shape. The direction is set on the panel rather than on a wrapper of
         ours because there is no wrapper — the panel relays it down.
         The lift is a small sharp shadow on the panel rather than a ring on the
         well: a hairline drew a second edge inside a shape that already has one,
         and the two corners never quite agreed.
         NB: no backticks or dollar-braces in these comments; this is a tagged
         template and both are parsed rather than treated as text. */
      #root {
        width: 100%;
        flex-direction: column;
      }

      #field {
        /* The same fill Toast.error uses, so an error looks like an error
           wherever it appears rather than each surface inventing a red. */
        background: var(--sys-red);
        color: var(--text-pri-inv);
        /* The end inset is a hook for a host that lays a control over the
           bar — std-toast's exception variant puts its close button there. */
        padding: 8px var(--exception-field-padding-end, 12px) 8px 12px;
        /* Monospace, like the well under it: these messages are file paths and
           identifiers far more often than they are sentences, and a
           proportional face was hyphenating them mid-token.
           NB: no backticks or dollar-braces in these comments; this is a tagged
           template and both are parsed rather than treated as text. */
        font: 500 11px/1.55 var(--mono, "SF Mono", "Fira Code", Menlo, Consolas, monospace);
        overflow-wrap: anywhere;
      }

      /* A host with bounded room caps the statement at a number of lines;
         the default, none, shows all of it. */
      #message {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: var(--exception-message-lines, none);
        overflow: hidden;
      }

      #well {
        background: var(--bg-elevated);
        color: var(--text-sec);
        padding: 9px 12px;
        /* A host with bounded room (a toast) caps the well and lets it scroll
           rather than clipping the stack, or the bar above it. */
        max-height: var(--exception-well-max-height, none);
        overflow: auto;

        /* The whole reason the well exists. std-exception-trace has no surface
           and so cannot assume a palette; this one does, and it is neutral, so
           here the real syntax tokens are safe to hand down. */
        --exc-keyword: var(--text-ter);
        --exc-severity: var(--fg-red);
        --exc-callee: var(--fg-syntax-function);
        --exc-path: var(--fg-syntax-variable);
        --exc-position: var(--fg-syntax-number);
        --exc-string: var(--fg-syntax-string);
      }

      #well[hidden] {
        display: none;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-round id="root" clip radius="10" bg="transparent"
      shadow="0 1px 2px rgba(0, 0, 0, 0.28)">
      <div id="field"><span id="message"></span></div>
      <div id="well" hidden></div>
    </std-round>
  `;
}

export namespace Exception {
  export type Trace = ExceptionTrace.Props;

  export type Props = {
    /** One line naming what went wrong. Always shown — an error block with no
     *  statement of the error is just a red rectangle. */
    message: string;
    /** Where it happened and what it said, when that is known. */
    trace?: Option<Trace>;
  };
}
