/**
 * The use-case wall: cards in tento-ui's std-grid-layout (masonry, shortest
 * column first), clipped to the body height with the bottom faded out, so a
 * long list reads as "and more". The app supplies every string and icon.
 */
import type { DeckUses } from "./deck-data.ts";
import { h } from "./dom.ts";

const SVG = "http://www.w3.org/2000/svg";

function icon(markup: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  // Trusted app content: stroked 24 px line-icon markup (paths, rects, circles).
  svg.innerHTML = markup;
  return svg;
}

function card(use: DeckUses["uses"][number]): HTMLElement {
  const head = h("div", "ck-use-head");
  if (use.icon) head.append(icon(use.icon));
  head.append(h("span", "ck-use-name", null, use.name));
  const el = h(
    "div",
    "ck-use" + (use.emphasis ? " ck-emphasis" : ""),
    null,
    head,
  );
  if (use.live) {
    el.append(
      h("i", "ck-use-live", { "aria-label": "runs today", role: "img" }),
    );
  }
  el.append(
    h("span", "ck-use-pair", null, use.pair),
    h("span", "ck-use-choice", null, use.choice),
  );
  if (use.note) el.append(h("span", "ck-use-note", null, use.note));
  return el;
}

export function renderUses(body: DeckUses): HTMLElement {
  const cards = body.uses.map(card);
  const well = h("div", "ck-uses-well");
  for (const c of cards) c.setAttribute("role", "listitem");
  // tento-ui components extend HTMLElement, so the grid loads only in a browser,
  // when the slide renders; the deck's Deno tests never import it.
  void import("@tento-ui/components/grid/grid-layout").then(
    ({ GridLayout }) => {
      const grid = GridLayout.make();
      grid.style.cssText = "display:block;width:100%";
      grid.setAttribute("role", "list");
      grid.append(...cards);
      well.replaceChildren(grid);
      grid.bind({ blockSpacingPx: 6, inlineSpacingPx: 6, minWidthPx: 160 });
      // The grid measures its width with getBoundingClientRect, which includes the
      // deck's 0.95 page scale on slides that are not current. Lay it out again
      // whenever the deck settles, so the current slide always fills its column.
      const deck = well.closest(".ck-deck");
      if (deck) {
        new MutationObserver(() => {
          if (!deck.hasAttribute("data-moving")) grid.layoutGrid();
        }).observe(deck, {
          attributes: true,
          attributeFilter: ["data-moving"],
        });
      }
    },
  );
  const out = h("div", "ck-uses", null, well);
  if (body.legend) {
    out.append(
      h(
        "p",
        "ck-uses-legend",
        null,
        h("span", "", null, h("i", "ck-use-live"), body.legend.live),
        h("span", "", null, body.legend.other),
      ),
    );
  }
  return out;
}
