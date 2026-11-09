import type { ComponentCatalogueEntry } from "./component-catalogue";
import { CoreUi } from "./core-ui";
import type { NodeKind } from "./page-model";

/** Closed comparison vocabulary. Design-specific recipes belong in one-offs;
 * variants of a shared component belong in its story, never in new slots. */
export namespace ComponentSlots {
  export const BRAND_IDS = [
    "hero", "social-proof", "feature-grid", "media", "integrations",
    "comparison", "pricing", "faq", "prose", "post-list", "post-body", "cta",
  ] as const satisfies readonly NodeKind[];
  export type BrandId = typeof BRAND_IDS[number];
  export type Group = "core" | "branding" | "one-off";

  /** Native story IDs may differ from their primitive identity (core.card).
   * A core-looking prefix alone does not create a new shared slot. */
  export function coreId(entry: ComponentCatalogueEntry): CoreUi.Id | null {
    const id = entry.coreId ?? entry.id.replace(/^core\./, "");
    return CoreUi.IDS.find(known => known === id) ?? null;
  }

  /** Only a complete semantic section can explicitly occupy a Brand slot. */
  export function brandId(entry: ComponentCatalogueEntry): BrandId | null {
    return BRAND_IDS.find(id => id === (entry.brandId ?? entry.id)) ?? null;
  }

  /** Older packages can carry broad layer hints. Membership still comes from
   * the closed vocabulary; model bindings never imply component identity. */
  export function groupOf(entry: ComponentCatalogueEntry): Group {
    if (entry.layer === "one-off") return "one-off";
    if (entry.layer === "branding") return brandId(entry) ? "branding" : "one-off";
    if (coreId(entry)) return "core";
    if (entry.layer === "core") return "one-off";
    return brandId(entry) ? "branding" : "one-off";
  }
}
