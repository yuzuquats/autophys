// The canonical, operator-curated wash palette. Consumers reference washes by a
// stable `id` (e.g. "meadow-2") via `CuratedWashes.byId`, never by a numeric index.
// This is the production set; `GradientSplat.SHAPE_SPECS` remains the lona-atoms
// generator's seed bank.
//
// The Spec data + id list live in the import-free `./curated-wash-data` (so standalone
// Deno tools can import the ids). `CuratedWashes` adds the rendered palettes + lookups,
// which need `GradientSplat` + the ambient `Option` type.

import { GradientSplat } from "./gradient-splat";
import { CuratedWash, CURATED_WASH_IDS, CURATED_WASH_SPECS } from "./curated-wash-data";

// Re-export so app consumers import everything wash-related from one module.
export type { CuratedWash };
export { CURATED_WASH_IDS, CURATED_WASH_SPECS };

export namespace CuratedWashes {
  // A curated wash with its rendered Palette (backgroundForSize / softBackground) +
  // identity. Built by feeding each Spec through the shared GradientSplat renderer.
  export type Palette = GradientSplat.Palette & {
    id: string;
    family: CuratedWash.Family;
    colors: readonly string[];
  };

  function toShapeSpec(s: CuratedWash.Spec): GradientSplat.ShapeSpec {
    return {
      label: s.name,
      seed: s.seed,
      colors: s.colors,
      footprint: s.footprint,
      spread: s.spread,
      softness: s.softness,
      grain: s.grain,
    };
  }

  // Every curated wash, rendered, in spec order.
  export const ALL: readonly Palette[] = CURATED_WASH_SPECS.map((s) => ({
    ...GradientSplat.paletteForSpec(toShapeSpec(s)),
    id: s.id,
    family: s.family,
    colors: s.colors,
  }));

  const BY_ID: ReadonlyMap<string, Palette> = new Map(ALL.map((w) => [w.id, w]));

  /** The curated wash for `id`, or null if unknown. */
  export function byId(id: string): Option<Palette> {
    return BY_ID.get(id) ?? null;
  }

  /** The curated wash for `id`, or `fallback` if unknown (deterministic; never blanks). */
  export function byIdOr(id: string, fallback: Palette): Palette {
    return BY_ID.get(id) ?? fallback;
  }

  /** Curated ids belonging to a family, in palette order. */
  export function idsByFamily(family: CuratedWash.Family): readonly string[] {
    return ALL.filter((w) => w.family === family).map((w) => w.id);
  }

  /**
   * A subtle section tint coordinated with a curated wash: `var(--bg)` mixed with the
   * wash's first solid color at `pct`% — mirrors the shape of the old hardcoded
   * `color-mix(in srgb, var(--bg) (100-pct)%, <hex> pct%)` so it drops into the same slot.
   */
  export function sectionTint(id: string, pct: number): string {
    const wash = byIdOr(id, ALL[0]);
    const solid = wash.colors.length > 0
      ? GradientSplat.solidColorOf(wash.colors[0])
      : "var(--bg)";
    return `color-mix(in srgb, var(--bg) ${100 - pct}%, ${solid} ${pct}%)`;
  }
}
