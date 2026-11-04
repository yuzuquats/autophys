import type { Style } from "../../component-styles";
import { LightSheet } from "./calendar-column-cell-light";

/**
 * The calendar chip's rules: it has no shadow root (the shadow chip went with
 * the operator's flip of 2026-10-12).
 *
 * The chip (`std-calendar-column-cell-content`) is the title and time inside
 * every event cell. A shadow root is a scope the style engine visits on every
 * style update, so, like its cell, the chip has none: it keeps
 * its tag and its API, its parts are its own children, and its rules live in
 * one shared sheet each chip installs, once per root, into the root it
 * connects into.
 *
 * - **Parts are classes, not ids:** many chips share one root, where
 *   duplicate ids would break `getElementById`. The class names are the
 *   chip's own, so no shared base rule (`.label`, `.text`...) reaches them.
 * - **The rules:** `LIGHT_CHIP_CSS` states the chip's rules for its host, its
 *   root part and its two labels, with the base rules a scope of its own
 *   would have given its parts (box sizing, the `std-col` flex, the
 *   Typography `p` rules).
 * - **Weights:** host rules sit in `:where()` (a root rule that names the chip
 *   still wins, as over `:host`). Part rules keep class weight, above the
 *   enclosing root's base `p` rule; the restated base rules are at zero
 *   weight, so they only fill in for a root without a base sheet.
 * - **No leakage:** every selector names the chip's tag (the chip has one
 *   mode, so no mark qualifies it); the parts are reached by child
 *   combinators.
 */

const HOST = "std-calendar-column-cell-content";

/** The chip's root part and its two labels. */
export const CHIP_ROOT_CLASS = "chip-root";
export const CHIP_LABEL_CLASS = "chip-label";
export const CHIP_HOURS_LABEL_CLASS = "chip-hours-label";

/** The chip at zero weight, with `rest` (a state) appended. */
function host(rest = ""): string {
  return `:where(${HOST}${rest})`;
}

/** A part of the chip, at class weight: `root` is the root part's own selector suffix, `child` a label's class. */
function part(state: string, root: string, child?: string): string {
  return `${host(state)} > .${CHIP_ROOT_CLASS}${root}${child == null ? "" : ` > .${child}`}`;
}

/** The chip's rules (the one sheet every root shares). */
export const LIGHT_CHIP_CSS = `
  /* The base rules a root without a base sheet would lack (box sizing, Typography p), at zero weight. */
  ${host()} * {
    box-sizing: border-box;
    user-select: none;
  }

  :where(${HOST} > .${CHIP_ROOT_CLASS} > p) {
    --font-height: calc(1 - var(--cap-height) - var(--baseline));
    --rfont-size: calc(var(--font-size) / var(--font-height));
    --line-height-offset: calc((var(--line-height-ratio, 1.00) - 1) * var(--rfont-size) / 2);
    --rmargin-top:
      calc(
        -1 * var(--cap-height) * var(--rfont-size)
        - var(--line-height-offset)
        + var(--margin-top, 0px));
    --rmargin-bottom:
      calc(
        -1 * var(--baseline) * var(--rfont-size)
        - var(--line-height-offset)
        + var(--margin-bottom, 0px));

    font-weight: 400;
    font-size: var(--rfont-size);
    line-height: calc(var(--rfont-size) * var(--line-height-ratio, 1.00));
    margin: 0;
    padding: 0;
    margin-top: var(--rmargin-top);
    margin-bottom: var(--rmargin-bottom);
    min-height: var(--font-size);
    --font-size: var(--p-size);
    --line-height-ratio: 1.2;
  }

  ${host()} .max-lines {
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
    -webkit-line-clamp: 2;
  }
  ${host()} .max-lines-1 {
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
    -webkit-line-clamp: 1;
  }
  ${host()} .max-lines-2 {
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
    -webkit-line-clamp: 2;
  }
  ${host()} .max-lines-3 {
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
    -webkit-line-clamp: 3;
  }

  ${host()} {
    height: 100%;
    display: block;
    position: relative;
  }

  /* Only loading placeholders use the height container queries below. */
  ${host("[loading]")} {
    container-type: size;
  }

  /* The root part: the std-col flex of the chip's scope, and the chip's #root rule. */
  ${part("", "")} {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding-block: 8px;
    padding-inline-start: 6px;
    padding-inline-end: 0px;
    --line-height-ratio: 1;
  }

  ${part("", "", CHIP_LABEL_CLASS)} {
    --font-size: var(--text-8px);
    flex-shrink: 0;
  }

  ${part("", "", CHIP_HOURS_LABEL_CLASS)} {
    --margin-top: 4px;
    --font-size: var(--text-6px);
    white-space: nowrap;
    color: var(--text-sec-on-solid);
  }

  ${part("[loading]", "", CHIP_LABEL_CLASS)},
  ${part("[loading]", "", CHIP_HOURS_LABEL_CLASS)} {
    opacity: 0;
  }

  /* Default: single line for 30 mins and less */
  ${host("[loading]")}::before {
    content: "";
    position: absolute;
    top: 50%;
    left: 8px;
    right: 8px;
    height: 10px;
    background: var(--bg-surface-light);
    border-radius: 3px;
    transform: translateY(-50%);
  }

  ${host("[loading]")}::after {
    content: "";
    position: absolute;
    top: 50%;
    left: 8px;
    right: 32px;
    height: 8px;
    background: var(--bg-surface-light);
    border-radius: 3px;
    transform: translateY(calc(-50% + 6px));
    display: none;
  }

  /* Single thin line for very small cells (<=15 mins) */
  @container (max-height: 12px) {
    ${host("[loading]")}::before {
      height: 6px;
      border-radius: 2px;
    }
  }

  /* Two lines for cells > 30 mins (>24px height) */
  @container (min-height: 25px) {
    ${host("[loading]")}::before {
      transform: translateY(calc(-50% - 6px));
    }

    ${host("[loading]")}::after {
      display: block;
    }
  }

  ${part("", '[duration="<=15m"]')} {
    padding: 0px;
    padding-inline-start: 6px;
    height: 100%;
    flex-direction: row;
    align-items: center;
  }

  ${part("", '[duration="<=15m"]', CHIP_LABEL_CLASS)} {
    --margin-top: 0.5px;
    --font-size: var(--text-6px);
  }

  ${part("", '[duration="<=30m"]')} {
    padding: 4px;
    padding-inline-start: 6px;
    padding-inline-end: 0px;
    flex-direction: row;
    height: 100%;
    align-items: center;
  }

  ${part("", '[duration="<=30m"]', CHIP_HOURS_LABEL_CLASS)} {
    --margin-top: 0px;
    margin-left: 4px;
    --font-size: var(--text-8px);
  }
`;

const LIGHT_CHIP_SHEET = new LightSheet(LIGHT_CHIP_CSS);

/** The one light-chip sheet every root shares (built on first use). */
export function lightChipStyles(): Style.Compat {
  return LIGHT_CHIP_SHEET.sheet();
}

/** Put the shared light-chip sheet into the light chip's `root`, first in its list, unless it is there already. */
export function adoptLightChipStyles(root: Node): void {
  LIGHT_CHIP_SHEET.adoptInto(root);
}

/** A light chip's parts: built with the chip, attached to it on connect (a constructor may not add children). */
export type LightChipParts = {
  readonly root: HTMLElement;
  readonly label: HTMLElement;
  readonly hoursLabel: HTMLElement;
};

export namespace LightChipParts {
  /** `div.chip-root > p.chip-label.max-lines-3 + p.chip-hours-label`, detached. */
  export function make(): LightChipParts {
    const root = document.createElement("div");
    root.classList.add(CHIP_ROOT_CLASS);
    const label = document.createElement("p");
    label.classList.add(CHIP_LABEL_CLASS, "max-lines-3");
    const hoursLabel = document.createElement("p");
    hoursLabel.classList.add(CHIP_HOURS_LABEL_CLASS);
    root.append(label, hoursLabel);
    return { root, label, hoursLabel };
  }
}
