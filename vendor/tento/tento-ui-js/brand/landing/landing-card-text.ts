import { css } from "../../component-styles";

/**
 * Shared "feature-card" text treatment for landing surfaces — the dense
 * title/subtitle typography used by both the feature grid
 * (`std-landing-feature-grid`) and the sticker bento (`std-landing-bento`).
 *
 * Include it in a component's `static $styles` and give each card the
 * `.feature-card` class (the cards are `std-brand-card`, so this overrides the
 * card's base `::slotted(.card-title)` styling from the consuming shadow tree).
 * Layout-specific rules — e.g. the grid's two-line clamping — stay in the
 * consuming component, not here.
 */
export const FEATURE_CARD_TEXT = css`
  .feature-card .card-title {
    --font-size: var(--text-14px);
    --line-height-ratio: 1.2;
    --margin-top: 0px;
    --margin-bottom: 16px;
  }

  .feature-card .card-subtitle {
    --font-size: var(--text-11px);
    --line-height-ratio: 1.4;
    --margin-top: 0px;
    --margin-bottom: 0px;
    color: var(--text-sec);
  }
`;
