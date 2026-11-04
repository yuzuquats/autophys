import { LonaWebComponent, html } from "../component";
import { component } from "../component-decorators";
import { css } from "../component-styles";

/** A diagnostic — an error OR a warning — rendered the way a reader already
 * knows how to read one:
 * a rule down the edge, the message in prose, and the machine's own output
 * in a frame underneath.
 *
 * This is deliberately NOT part of the turn vocabulary. A failed agent turn
 * is one caller; a failed spool job, a rejected deploy, and a panicking
 * node are others, and they should not each invent a red box. The
 * component knows nothing about turns, records, or agents — it takes a
 * message and a body, and it never interprets either of them. It does
 * COLOUR the body, which is a different act: see `highlightDiagnostic`
 * below for why lexical shapes are matchable without knowing the
 * language, and why an unrecognised trace still renders verbatim.
 *
 * ## The typeface rule
 *
 * The two slots are two REGISTERS, and the rule that separates them is not
 * "errors are monospace":
 *
 *   **Monospace is for text whose column alignment carries meaning.**
 *   Everything else is prose, and prose is set in the app's ramp.
 *
 * `message` is a sentence — `PermissionDenied: tool call blocked by policy`
 * reads as language, wraps like language, and is the one line a glance
 * lands on. Setting it in mono made it look like a fragment of a log, cost
 * it the ramp's size and weight, and left the panel with no prose in it at
 * all. Every dev-tool overlay worth copying does the same thing: React's
 * and Vite's overlays, and Chrome DevTools' console, all set the message in
 * the UI face and reserve mono for the frames below it.
 *
 * `detail` is a transcript. A rustc diagnostic aligns its `^^^^` caret
 * under the offending column; a stack trace aligns its ` at ` frames; a
 * diff aligns its gutters. That alignment is the content. So the body is
 * monospace AND it must not be reflowed — the previous revision set
 * `white-space: pre-wrap` with `overflow-wrap: anywhere`, which broke the
 * caret line of the compiler error in this component's OWN storybook. It
 * scrolls sideways instead, which is what a terminal does and what every
 * code frame in the overlays above does.
 *
 * The body also gets a frame — a sunken surface with a hairline — rather
 * than sitting bare on the panel tint. Unframed, a trace reads as more
 * message rather than as quoted machine output, which is exactly the
 * distinction the two registers exist to draw.
 *
 * ## The chrome
 *
 * There is no severity chip. An ERROR badge over a message that already
 * says `ValidationError:` is the label telling you what the sentence just
 * told you, and it cost a whole row of height to do it. Severity survives
 * as the rule's colour, which is the one thing a glance actually uses.
 *
 * There is ONE rule, down the left edge, and no box. A full border made
 * the right edge read as the heaviest thing in the panel — heavier than
 * the accent, because the 3px left rule resolves to the palette's `--red`
 * while the 1px sides were 45% alpha over it, so the thin border was
 * darker than the thick one. Dropping the box removes the inversion and
 * the weight at once, and it is what an inline error looks like in the
 * surfaces this borrows from. */
@component({ name: "std-diagnostic" })
export class Diagnostic extends LonaWebComponent {
  private $message: HTMLElement = this.$("message");
  private $detail: HTMLElement = this.$("detail");

  static makeWith(props: Diagnostic.Props): Diagnostic {
    return (Diagnostic.make() as Diagnostic).bind(props);
  }

  bind(props: Diagnostic.Props): this {
    this.setAttribute("severity", props.severity ?? "error");
    this.$message.textContent = props.title;
    const detail = props.detail ?? "";
    this.$detail.replaceChildren(...highlightDiagnostic(detail));
    this.$detail.style.display = detail === "" ? "none" : "";
    return this;
  }

  static $styles = [
    css`
      /* A full-bleed panel: without an explicit width the host hugs its
         content in any shrink-to-fit parent. */
      :host {
        display: block;
        width: 100%;
      }
      #root {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 9px 12px;
        border-left: 3px solid;
        border-radius: 0 5px 5px 0;
      }
      :host([severity="error"]) #root {
        border-color: var(--red, #e5484d);
        background: var(--red-bg, rgba(229, 72, 77, 0.08));
      }
      :host([severity="warning"]) #root {
        border-color: var(--yellow, #d4a72c);
        background: var(--yellow-bg, rgba(212, 167, 44, 0.1));
      }

      /* ---- register 1: the message, prose ------------------------- */
      /* Flex children default to min-width:auto, which lets a long line
         push past the panel instead of wrapping inside it. */
      /* One step UP the ramp from the body, not down. The message is the
         line a glance lands on and the only prose in the panel; at the
         same size as the trace beneath it, it read as the trace's first
         line.

         Set through --font-size rather than font-size. The app's type rule
         reads --font-size, divides it by the face's cap-height to get the
         real size, and trims the block's margins to match; a literal
         font-size wins the size and leaves the trim computed from a
         different number, so the line sits off its own leading. The knob
         is the variable.

         The token carries a literal fallback for the same reason the
         colours below do: this component also mounts in a storybook and in
         a sandboxed review card, where the app's theme sheets may not be
         loaded and an unresolved token would collapse the message to the
         browser default.

         Revised on review twice, and the ramp is why the first attempt
         did not land. This was --h6-size at weight 600; --h6-size is
         --text-12px, but the ramp divides by (1 - cap-height - baseline)
         to get the real size, so 12px resolves to ~16.6px and against an
         11.5px trace it read as a page heading. --h7-size only moved that
         to ~15.3px, which is why "title too big still". It is now --p-size
         — the body ramp, ~13.9px rendered — at weight 500. That is still
         above the trace beneath it, which is the only thing the step was
         ever for; the message is one line of an inline panel, not a
         heading over a document. */
      #message {
        margin: 0;
        min-width: 0;
        --font-size: var(--p-size, 10px);
        --margin-top: 0px;
        --margin-bottom: 0px;
        font-weight: 500;
        letter-spacing: -0.005em;
        overflow-wrap: break-word;
      }
      :host([severity="error"]) #message {
        color: var(--red-text, #b3282c);
      }
      :host([severity="warning"]) #message {
        color: var(--yellow-text, #8a6d1f);
      }

      /* ---- register 2: the body, verbatim ------------------------- */
      /* Framed, and NOT reflowed: the columns are the content. */
      #detail {
        margin: 0;
        min-width: 0;
        padding: 8px 10px;
        border: 1px solid var(--divider, rgba(127, 127, 127, 0.22));
        border-radius: 5px;
        background: var(--surface-sunken, rgba(127, 127, 127, 0.07));
        color: var(--text-sec, #59616e);
        --font-size: var(--turn-fine-size, var(--text-8px));
        --line-height-ratio: 1.55;
        font-variant-numeric: tabular-nums;
        white-space: pre;
        overflow-x: auto;
      }

      /* ---- the four things a trace is made of --------------------- */
      /* Deliberately four, and deliberately dim. A language highlighter
         colours a dozen token classes because a reader is looking for
         structure; a trace reader is looking for exactly one thing —
         WHERE — and everything that competes with the locations makes
         them harder to find. So: the location bright, the diagnostic
         code and the quoted name a step down, the caret the severity's
         own colour, and every other character left alone. */
      /* --text-pri, not --text. There is no --text token in this app — the
         name was a guess, and an undefined custom property does not fall
         back to the theme, it falls to the literal here: #1f2430, a
         near-black, on a panel that is near-black. The location is the one
         thing this whole highlighter exists to make findable and it was
         the one thing invisible. Measured: rgb(31, 36, 48) on the dark
         theme. */
      #detail .loc {
        color: var(--text-pri);
        font-weight: 600;
      }
      /* --fg-*, NOT the raw palette colour. The theme's --purple and
         --blue are SYSTEM hues picked to read on a dark surface (#dbacff,
         #999cff); on the light panel this component draws on, a diagnostic
         code in raw --purple is pale lavender on near-white and cannot be
         read at 11.5px. The --fg-* twins exist for exactly this: each is
         its hue mixed 72/28 with --text-pri, so it stays recognisably that
         colour and stays legible on either surface. */
      /* The fallback is the --fg-* RECIPE, not a picked hue, because
         --fg-purple does not exist in every theme. Measured on the dark
         theme this renders in: --fg-blue, --fg-red and --fg-green resolve
         and --fg-purple, --fg-yellow and --fg-teal do not — so this was
         falling all the way through to #6f42c1, a dark purple on a dark
         panel, which is the same unreadability the note above describes
         with the roles reversed. Mixing 72/28 toward --text-pri is what
         the --fg-* twins are, so computing it here lands in the same place
         the token would have. */
      #detail .code {
        color: var(
          --fg-purple,
          color-mix(in srgb, var(--purple, #8250df) 72%, var(--text-pri, #1f2328) 28%)
        );
      }
      #detail .name {
        color: var(--fg-blue, #0550ae);
      }
      :host([severity="error"]) #detail .caret {
        color: var(--red, #e5484d);
      }
      :host([severity="warning"]) #detail .caret {
        color: var(--yellow, #d4a72c);
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="root">
      <p id="message"></p>
      <pre class="code-block" id="detail"></pre>
    </div>
  `;
}

/** Colour a trace WITHOUT interpreting it.
 *
 * The distinction is the whole design. A syntax highlighter needs to know
 * what language it is looking at, and a stack trace is not written in one
 * — a rustc diagnostic, a Node stack, a Python traceback and a bare
 * stderr tail share no grammar. What they DO share is four lexical
 * shapes, and those are matchable without deciding what any of it means:
 *
 *   loc    a path with a line, `foo/bar.rs:412` or `:412:37`
 *   code   a diagnostic id, `error[E0432]` / `E0432` / `TS2345`
 *   name   a backticked or single-quoted name the tool is pointing at
 *   caret  the `^^^^` / `~~~~` run under the offending column
 *
 * Everything else stays as it was written. That matters more than what is
 * coloured: the component still never decides what the body MEANS, an
 * unrecognised trace renders exactly as it arrived, and — because the
 * regexes only ever split a run of text and never rewrite one — every
 * character of the input survives to the DOM in its original order. The
 * output is text nodes and spans, never HTML parsed from the input, so a
 * body containing markup is inert.
 *
 * The pattern list is ordered: earlier entries win a contested run. `loc`
 * precedes `code` so `main.rs:9:5` does not lose its tail. */
const DIAGNOSTIC_PATTERNS: [string, RegExp][] = [
  // Two location forms: the compiler's `path.ext:line[:col]`, and the
  // `[line N]` this app's own lisp and tsh diagnostics use.
  ["loc", /\b[\w./\\-]+\.\w{1,5}:\d+(?::\d+)?\b|\[line \d+(?::\d+)?\]/g],
  // `error[E0308]`, a bare `E0308`, and the plain `error:` / `warning:` /
  // `note:` keyword every non-Rust producer here writes instead.
  [
    "code",
    /\b(?:error|warning|note)\[[A-Z]+\d+\]|\b[A-Z]{1,4}\d{3,5}\b|\b(?:error|warning|note)(?=:)/g,
  ],
  // Quoted names, in all three quotes. DOUBLE quotes were missing and are
  // the ones this app actually emits — see the note above.
  ["name", /`[^`\n]+`|'[^'\n]+'|"[^"\n]+"/g],
  ["caret", /[\^~]{2,}/g],
];

function highlightDiagnostic(text: string): Node[] {
  if (text === "") return [];

  // One pass per class over the runs still uncoloured. A run that has
  // already been claimed is never re-scanned, which is what makes the
  // list's order a precedence and keeps the whole thing linear.
  let runs: Node[] = [document.createTextNode(text)];
  for (const [className, pattern] of DIAGNOSTIC_PATTERNS) {
    runs = runs.flatMap((node) =>
      node.nodeType === Node.TEXT_NODE
        ? splitRun(node.textContent ?? "", pattern, className)
        : [node],
    );
  }
  return runs;
}

function splitRun(text: string, pattern: RegExp, className: string): Node[] {
  const out: Node[] = [];
  let cursor = 0;
  // Fresh regex per run: a /g literal carries lastIndex across calls, and
  // sharing one across runs silently skips matches in later ones.
  const scan = new RegExp(pattern.source, pattern.flags);
  for (let m = scan.exec(text); m != null; m = scan.exec(text)) {
    if (m.index > cursor) {
      out.push(document.createTextNode(text.slice(cursor, m.index)));
    }
    const $span = document.createElement("span");
    $span.className = className;
    $span.textContent = m[0];
    out.push($span);
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    out.push(document.createTextNode(text.slice(cursor)));
  }
  return out;
}

export namespace Diagnostic {
  export type Severity = "error" | "warning";

  export type Props = {
    /** The one-line message: what was thrown, as a sentence. Prose. */
    title: string;
    /** Verbatim machine output — a trace, a stderr tail, a diagnostic.
     * Monospace, never reflowed: its columns carry meaning. */
    detail?: string;
    severity?: Severity;
  };
}
