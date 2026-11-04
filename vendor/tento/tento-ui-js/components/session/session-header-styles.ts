import { css } from "../../component-styles";

/**
 * Styles for `std-session-header`, split by the part they dress so a reader
 * can find the rule that governs a thing without scanning one long block.
 *
 * Two of these encode decisions rather than taste, and are commented where
 * they sit: nothing here is monospace, and the number is set as a handle
 * rather than as prose.
 */
export namespace SessionHeaderStyles {
  /** The mark is `std-status-mark`; this only sets its metrics. The content
   * view draws a 12px glyph against the rail's 8px — same shape and palette,
   * scaled to the surface. The box stays 20px so the extra weight comes from
   * the glyph rather than from the cell growing. */
  export const $mark = css`
    std-status-mark {
      /* Aligned to the title, not to the cell. Centred, the mark drifted down
        to the title/description seam once the number moved above the title —
        it marks the thing the title names, so it tracks that line.
        The arithmetic is exact because the type scale trims cap-height and
        baseline whitespace: every line contributes exactly its own font-size
        to the column, so the title's centre is a sum of known terms.
          7px    the number tag's line
        + 3px    the title's own --margin-top below it
        + 11px/2 half the title line
        - 20px/2 half this box, to centre it there instead of top-align */
      align-self: start;
      margin-top: calc(7px + 3px + 11px / 2 - 20px / 2);
      --status-mark-box: 20px;
      --status-mark-glyph: 12px;
    }
  `;

  /** Number, title and description, stacked. Each line clamps rather than
   * wraps: the cell is a fixed three-line shape, and a wrapping title would
   * reflow the list every time a session was renamed. */
  export const $content = css`
    .content {
      min-width: 0;
      flex: 1;
      /* No shared gap: the three lines do not want the same separation. The
        tag belongs to the title and sits tight under it; the description is
        a separate fact and takes more air. Each declares its own --margin-top
        below, which also keeps every term of the mark's offset visible in one
        place. The type scale trims cap-height and baseline whitespace, so
        those values are the literal optical gaps. */
      gap: 0;
      /* Stays stretch (std-col's default) on purpose: the title must fill the
        cell for its ellipsis to have anywhere to happen. align-items: start
        would shrink every line to content width and the title would overflow
        instead of truncating — the tag opts out of that individually. */
      text-align: start;
    }
    /* The cell's whole type ladder, declared together because the mark's
      alignment is computed from it: 7px tag, 11px title, 8px description.
      Each is a step of the theme scale, and each line contributes exactly its
      own size to the column because cap-height and baseline are trimmed. */
    .title {
      /* Tight to the tag above it — the tag is this title's address, not a
        line of its own standing. */
      --margin-top: 3px;
      --margin-bottom: 0px;
      --font-size: var(--text-11px, 11px);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-pri, #fff);
    }
    /* A handle, not prose: digits align and it never breaks mid-token.
      Monospace is deliberately not reintroduced — a face is not a datatype.
      Set below the scale's smallest step rather than at it: this line is an
      address, and it should be the quietest thing in the cell — it stays one
      step under the description for that reason, so shrinking the other two
      lines pulled this one down with them. (--small-size resolves to 9px in
      theme-base, so Typography.small alone would leave it larger than the
      description.) align-self: start keeps it its own width in a stretch
      column. */
    .number {
      --margin-top: 0px;
      --margin-bottom: 0px;
      --font-size: var(--text-7px, 7px);
      align-self: start;
      flex: none;
      color: var(--text-ter, #8b93a7);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    /* Typography.caption builds a real <caption> element, and the UA sheet
      gives that text-align: center. A rule on the element beats text-align
      inherited from .content, so it has to be set here explicitly —
      ListCellLayout.$caption does the same thing for the same reason. */
    .description {
      /* More than the tag's 3px, because this is a different fact rather than
        the title's address — but small enough that the three lines still come
        to 34px inside a 56px row. */
      --margin-top: 5px;
      --font-size: var(--text-8px, 8px);
      --margin-bottom: 0px;
      display: block;
      text-align: start;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-ter, #8b93a7);
    }
  `;

  /** The overflow affordance. The padding is declared rather than implied by
   * the gap between a square box and a square glyph — `three-dots` is not
   * square, so that arithmetic never held. */
  export const $accessory = css`
    .more {
      display: grid;
      place-items: center;
      /* Same rule as the mark, same arithmetic — it sits on the title's line,
        with half of this 30px button subtracted instead of half of 20. */
      align-self: start;
      margin-top: calc(7px + 3px + 11px / 2 - 30px / 2);
      box-sizing: border-box;
      width: 30px;
      height: 30px;
      /* The inset lives on the glyph's own box below, so the button is
        exactly the 30x30 hit area and the hover fill matches it. */
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--text-ter, #8b93a7);
      cursor: pointer;
    }
    .more:hover:not(:disabled) {
      color: var(--text-pri, #fff);
      background: var(--bg-hover, rgba(127, 127, 127, 0.12));
    }
    .more:disabled {
      opacity: 0.55;
      cursor: default;
    }
    /* The glyph sits in its own 30x30 box, inset 6px on every side, so the
      drawing area is a square 18x18 the 13:3 dots letterbox inside.
      Both dimensions are explicit on purpose: three-dots.svg carries a
      viewBox but no width/height, so it has a ratio and no intrinsic size —
      an auto height on that can resolve against the replaced-element default
      instead of the ratio, which blows the glyph past the button. */
    .more svg {
      display: block;
      box-sizing: border-box;
      width: 30px;
      height: 30px;
      padding: 6px;
    }
  `;

  export const $host = css`
    :host {
      display: block;
    }
    /* The cell's own frame. The wide size ships 8px top and bottom, which
      reads tall here because this header carries three trimmed lines rather
      than a list row's one — the type scale has already removed the
      whitespace that padding was compensating for. Horizontal padding is
      left as it was. (No backticks in this file: it is a css template, and
      a backtick in a comment terminates it.) */
    std-list-cell-layout {
      --list-cell-padding: 2px 8px;
    }
  `;

  /** In the order the component composes them. */
  export const all = [$host, $mark, $content, $accessory];
}
