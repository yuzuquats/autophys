import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { SeqParser } from "../../review-dsl/seq-parser";
import { Typography } from "../../ui/typography";
import { ReviewSvg } from "./review-svg";

const SELF_W = 30;

/** Message text is routinely a route or path — one long token with no space
 * in it. Left alone, wrapping either overflows the diagram or (with
 * overflow-wrap: anywhere) breaks mid-segment, which is what makes
 * `/data/yuzuquats/commit-review/api/stack/mono` read so badly. Marking the
 * segment boundaries with <wbr> gives the line breaker somewhere sensible to
 * break, and adds no characters, so the text still copies verbatim. */
function breakable(text: string): DocumentFragment {
  const $frag = document.createDocumentFragment();
  // Keep the separator with the chunk it follows, then offer a break after it.
  const chunks = text.split(/(?<=[/\-_.:@?&=])/);
  chunks.forEach((chunk, i) => {
    $frag.appendChild(document.createTextNode(chunk));
    if (i < chunks.length - 1) $frag.appendChild(document.createElement("wbr"));
  });
  return $frag;
}

@component({ name: "std-review-seq" })
export class ReviewSeq extends LonaWebComponent {
  private $root: HTMLElement = this.$("root");

  bind({ seq }: ReviewSeq.Props): void {
    this.$root.replaceChildren(ReviewSeq.Diagram.makeWith(seq));
  }

  static $styles = [
    css`
      :host {
        display: block;
        /* Take the column's width instead of hugging the diagram: under a
         * shrink-to-fit parent (the storybook card's centered flex slot) an
         * auto width reports a container as wide as the content, so the
         * layout never learns it has to adapt and the card scrolls instead. */
        width: 100%;
        box-sizing: border-box;
        margin-block: 16px;
        overflow-x: auto;
      }
    `,
  ];

  static $html = html`<div id="root"></div>`;
}

export namespace ReviewSeq {
  export type Props = { seq: SeqParser.Doc };

  @component({ name: "std-review-seq-diagram" })
  export class Diagram extends LonaWebComponent {
    private $root: HTMLElement = this.$("root");
    private observer: Option<ResizeObserver> = null;

    static makeWith(seq: SeqParser.Doc): Diagram {
      return Diagram.make().bind(seq);
    }

    bind(seq: SeqParser.Doc): this {
      this.observer?.disconnect();
      this.observer = null;

      const $seq = document.createElement("div");
      $seq.className = "seq";
      const $actors = document.createElement("div");
      $actors.className = "actors";
      const actorEls = new Map<string, HTMLElement>();
      for (const actor of seq.actors) {
        const $actor = document.createElement("div");
        $actor.className = "actor";
        $actor.appendChild(Typography.p(actor.label, "small"));
        $actors.appendChild($actor);
        actorEls.set(actor.id, $actor);
      }

      const $rows = document.createElement("div");
      $rows.className = "rows";
      type RowRef = {
        item: SeqParser.Item;
        $row: HTMLElement;
        $content: HTMLElement;
      };
      const rows: RowRef[] = [];
      for (const item of seq.items) {
        const $row = document.createElement("div");
        $row.className = "row";
        let $content: HTMLElement;
        if (item.kind === "msg") {
          $content = Typography.p("", "small");
          $content.classList.add("msg-label");
          $content.replaceChildren(breakable(item.text));
        } else {
          $content = document.createElement("div");
          $content.className = "note-box";
          $content.appendChild(Typography.p(item.text, "small"));
        }
        $row.appendChild($content);
        $rows.appendChild($row);
        rows.push({ item, $row, $content });
      }

      const $wires = document.createElementNS(ReviewSvg.NS, "svg");
      $wires.classList.add("wires");
      $wires.appendChild(ReviewSvg.$arrowDefs("rsq-arrow"));
      $seq.append($actors, $rows, $wires);
      this.$root.replaceChildren($seq);

      // Four phases — read every box, write the DOM, read the message labels'
      // widths in ONE batch, write their placements. Reading geometry after a
      // write forces the engine to lay out the whole document before it can
      // answer, and the row loop used to do exactly that per message (write
      // `maxWidth`/`left`, then read `offsetWidth`). Batched, a diagram of any
      // size costs two flushes. Same fix as `graph-grid`'s `draw`.
      const draw = (): void => {
        while ($wires.childNodes.length > 1) $wires.lastChild!.remove();
        const origin = $seq.getBoundingClientRect();
        if (origin.width === 0) return;
        // ── read: actor centres (once each, not once per reference), the
        // lifeline span, and every row's box ──
        const centers = new Map<string, number>();
        for (const [id, $actor] of actorEls) {
          const rect = $actor.getBoundingClientRect();
          centers.set(id, rect.x - origin.x + rect.width / 2);
        }
        const centerOf = (id: string): number => centers.get(id) ?? 0;
        const top = $actors.getBoundingClientRect().bottom - origin.y;
        const bottom = $rows.getBoundingClientRect().bottom - origin.y;
        const rowRects = rows.map(({ $row }) => $row.getBoundingClientRect());
        // ── write: lifelines, self-loops, message lines, note boxes ──
        for (const actor of seq.actors) {
          const x = centerOf(actor.id);
          $wires.appendChild(
            ReviewSvg.$line({ x, y: top }, { x, y: bottom }, "lifeline"),
          );
        }
        // Message labels that need centring on their span: the span is known
        // now, the label's own width is not, so they are collected and placed
        // after the batched measure below.
        const centring: { $content: HTMLElement; left: number; width: number }[] = [];
        rows.forEach(({ item, $content }, i) => {
          const rowRect = rowRects[i];
          if (rowRect == null) return;
          const rowTop = rowRect.y - origin.y;
          if (item.kind === "note") {
            const xs = item.actors.map(centerOf);
            const left = Math.min(...xs) - 34;
            const right = Math.max(...xs) + 34;
            $content.style.marginLeft = `${Math.max(0, left)}px`;
            $content.style.width = `${right - left}px`;
            return;
          }
          const x1 = centerOf(item.from);
          const x2 = centerOf(item.to);
          const cls = item.dashed ? "msg-line dashed" : "msg-line";
          if (item.from === item.to) {
            $content.style.marginLeft = `${x1 + SELF_W + 8}px`;
            const y1 = rowTop + rowRect.height - 14;
            const y2 = rowTop + rowRect.height - 4;
            const $loop = ReviewSvg.$path(
              ReviewSvg.polyPath([
                { x: x1, y: y1 },
                { x: x1 + SELF_W, y: y1 },
                { x: x1 + SELF_W, y: y2 },
                { x: x1, y: y2 },
              ]),
              cls,
            );
            $loop.setAttribute("marker-end", "url(#rsq-arrow)");
            $wires.appendChild($loop);
            return;
          }
          // Wrap only when the text runs out of DIAGRAM, not when it runs out
          // of arrow. The label is the only thing on its row, so letting it
          // spill past the span costs nothing, and it stops short messages
          // from breaking with obvious empty space beside them. It stays
          // centred on the span while it fits, then slides to stay inside.
          $content.style.maxWidth = `${origin.width}px`;
          $content.style.left = "0px";
          centring.push({
            $content,
            left: Math.min(x1, x2),
            width: Math.abs(x2 - x1),
          });
          const y = rowTop + rowRect.height - 5;
          const $line = ReviewSvg.$line({ x: x1, y }, { x: x2, y }, cls);
          $line.setAttribute("marker-end", "url(#rsq-arrow)");
          $wires.appendChild($line);
        });
        // ── read: the labels' widths, one flush for all of them ──
        const widths = centring.map(({ $content }) => $content.offsetWidth);
        // ── write: nothing reads geometry after this point ──
        centring.forEach(({ $content, left, width }, i) => {
          const w = widths[i];
          if (w == null) return;
          const centred = left + (width - w) / 2;
          $content.style.marginLeft = `${
            Math.max(0, Math.min(centred, origin.width - w))
          }px`;
        });
      };

      this.observer = new ResizeObserver(() => requestAnimationFrame(draw));
      this.observer.observe($seq);
      requestAnimationFrame(draw);
      return this;
    }

    disconnectedCallback(): void {
      this.observer?.disconnect();
      this.observer = null;
      super.disconnectedCallback();
    }

    static $styles = [
      Typography.$style,
      css`
        :host {
          display: block;
          width: max-content;
          max-width: 100%;
          margin-inline: auto;
        }
        .seq {
          position: relative;
          width: max-content;
          max-width: 100%;
        }
        .actors {
          display: flex;
          gap: 56px;
          align-items: stretch;
          position: relative;
          z-index: 1;
        }
        .actor {
          padding: 6px 12px;
          background: var(--bg-elevated);
          border: 1px solid var(--divider-pri, var(--divider));
          border-radius: 6px;
          text-align: center;
          display: grid;
          place-items: center;
          min-width: 0;
        }
        .actor p {
          --font-size: var(--text-8px);
          color: var(--text-pri);
          max-width: 18ch;
          overflow-wrap: anywhere;
        }
        .rows {
          position: relative;
          padding-block: 12px 16px;
          z-index: 1;
        }
        .row {
          position: relative;
          min-height: 28px;
          padding-bottom: 16px;
        }
        .row + .row {
          margin-top: 10px;
        }
        .row .msg-label {
          --font-size: var(--text-7px);
          color: var(--text-sec);
          width: max-content;
          max-width: 100%;
          position: relative;
          top: 2px;
          line-height: 1.45;
          /* Clear of the arrowheads it sits between and the lifelines it
           * crosses. */
          padding-inline: 6px;
          white-space: normal;
          /* break-word, not anywhere: take the <wbr> segment boundaries first
           * and only split a token mid-way when one segment still will not
           * fit. */
          overflow-wrap: break-word;
          /* Text protection over the lifelines. Still no filled box — a
           * stroke in the surface colour, painted BEHIND the glyphs, knocks a
           * clean hole in the dashed line instead of letting it read through
           * the gaps between strokes; the ring of hard shadows closes the
           * corners the stroke leaves open.
           *
           * The knock-out is only invisible while it is painted in the colour
           * that is ACTUALLY behind the diagram, so that colour is a token the
           * placer sets — --bg is merely the common case (a note on the page
           * surface). Anywhere else, the storybook card's wash included, the
           * placer names its own surface and the halo follows it. */
          paint-order: stroke fill;
          -webkit-text-stroke: 3px var(--seq-surface, var(--bg));
          --halo: var(--seq-surface, var(--bg));
          text-shadow:
            0 2px 0 var(--halo), 0 -2px 0 var(--halo),
            2px 0 0 var(--halo), -2px 0 0 var(--halo),
            1px 1px 0 var(--halo), -1px 1px 0 var(--halo),
            1px -1px 0 var(--halo), -1px -1px 0 var(--halo),
            0 0 3px var(--halo);
        }
        .row .note-box {
          border: 1px solid color-mix(in srgb, var(--fg-yellow) 45%, var(--divider));
          background: color-mix(in srgb, var(--fg-yellow) 10%, var(--bg-elevated));
          border-radius: 5px;
          padding: 4px 10px;
          text-align: center;
          overflow-wrap: anywhere;
        }
        .row .note-box p {
          --font-size: var(--text-7px);
          color: var(--text-sec);
        }
        .wires {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
          overflow: visible;
          z-index: 0;
        }
        .lifeline {
          stroke: var(--divider-pri, var(--divider));
          stroke-width: 1;
          stroke-dasharray: 3 3;
        }
        .msg-line {
          fill: none;
          stroke: var(--fg-icon-ter, var(--text-ter));
          stroke-width: 1.2;
        }
        .msg-line.dashed {
          stroke-dasharray: 4 3;
        }
        .arrow {
          fill: var(--fg-icon-ter, var(--text-ter));
          stroke: none;
        }
      `,
    ];

    static $html = html`<div id="root"></div>`;
  }
}
