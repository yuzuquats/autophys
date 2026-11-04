import { Style, css } from "../../component-styles";

// App (calendar.lona.so) design tokens, mirrored from the semantic block of
// lona/so.lona.static/html/static.routes/css/colors.css.
//
// `AppThemeTokens.stage` is added to a feature-card asset's stage component
// styles (FeatureCardHero / AssetPreview), alongside `color-scheme: light`, so a
// live product preview renders in the REAL app palette even when an ancestor
// brand surface has overridden the semantic tokens — most notably the landing
// page, which wraps content in `<std-brand-app>` and applies the "loaf" brand DS
// (cream `--bg`, muted `--blue`, etc.). A declaration directly on the stage beats
// the value the stage inherits from the brand-app, so the asset reverts to the
// app look.
//
// Why this is cheap to mirror:
//   - The base `--sys-*` palette and the `--black*`/`--white*` helpers are NOT
//     overridden by brand variants, so the colour tokens restore by simply
//     re-aliasing to them (no hex duplication).
//   - Derived tokens like `--fg-red` (`color-mix(... var(--red) ...)`) resolve
//     lazily at use time, so re-declaring `--red`/`--text-pri` here is enough —
//     they recompute against these values automatically.
//   - font-family is intentionally NOT reset: `/gtm` applies the loaf font too
//     (BrandTokens.Typography.loaf), so leaving font untouched keeps the landing
//     and `/gtm` assets consistent.
//
// KEEP IN SYNC with colors.css.
export namespace AppThemeTokens {
  const declarations = `
    --red: var(--sys-red);
    --orange: var(--sys-orange);
    --yellow: var(--sys-yellow);
    --yellow-deep: var(--sys-yellow-deep);
    --green: var(--sys-green);
    --blue: var(--sys-blue);
    --purple: var(--sys-purple);
    --purple-fg: var(--sys-purple-fg);
    --gray: var(--sys-gray);
    --teal: var(--sys-teal);

    --red-dimmed: var(--sys-red-dimmed);
    --orange-dimmed: var(--sys-orange-dimmed);
    --yellow-dimmed: var(--sys-yellow-dimmed);
    --green-dimmed: var(--sys-green-dimmed);
    --blue-dimmed: var(--sys-blue-dimmed);
    --purple-dimmed: var(--sys-purple-dimmed);
    --gray-dimmed: var(--sys-gray-dimmed);
    --teal-dimmed: var(--sys-teal-dimmed);

    --bg: light-dark(white, #1e222c);
    --bg-elevated: light-dark(white, #2a3342);
    --bg-elevated-2: light-dark(white, #354158);
    --bg-surface: light-dark(var(--black12), var(--white12));
    --bg-surface-light: light-dark(var(--black9), var(--white6));
    --bg-selected: light-dark(var(--black12), var(--white12));
    --bg-hover: light-dark(var(--black6), var(--white6));
    --bg-hover-opaque: light-dark(var(--black6-opaque), var(--white12-opaque));

    --text-pri: light-dark(#222, white);
    --text-sec: light-dark(#555, #ddd);
    --text-ter: light-dark(#888, #a5a5a5);
    --text-pri-on-solid: light-dark(var(--text-pri), var(--bg));
    --text-pri-inv: light-dark(white, #333);

    --divider: light-dark(#dadce0, #444);

    --fg-icon-pri: light-dark(#444, white);
    --fg-icon-sec: light-dark(#888, #a5a5a5);
    --fg-icon-ter: light-dark(#bbb, #666);
  `;

  /** Restore the neutral app palette inside a brand-token ancestor. */
  export function scope(selector: string): Style.Compat {
    return css(`${selector} {${declarations}}`);
  }

  // Applies the app tokens to the asset stage (#stage). Append to the stage
  // component's $styles after its own #stage rule.
  export const stage: Style.Compat = scope("#stage");
}
