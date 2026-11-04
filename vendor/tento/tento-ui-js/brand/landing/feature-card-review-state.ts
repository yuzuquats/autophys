import { LiveData } from "@tento-core/livedata";

// Shared render-state for the `/gtm` review surface, driven by the visible
// review toolbar (see lona/so.lona .../gtm/gtm-bento-page.ts). FeatureCardHero
// and FeatureCardHeroImagePlaceholder subscribe to these and react. This
// replaces the old implicit `i` (layout overlay) and `-` (content/placeholder)
// document keydown hotkeys with a single explicit source of truth.
//
// `Mode` lives here (not on the placeholder) so the dependency stays one-way:
// the components import this module; this module imports nothing from them.
export namespace FeatureCardReviewState {
  export type Mode = "content" | "placeholder";

  // Per-hero layout/safe-area debug overlay + the `hero-layout` resize traces.
  export const showInsets = new LiveData<boolean>(false);

  // Whether assets render their real content or the labeled placeholder stand-in.
  export const mode = new LiveData<Mode>("content");
}
