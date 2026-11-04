import { StickerEffect } from "./sticker-effect";

export namespace StickerMaterialVariant {
  export type Rendering = "static-css" | "animated-css" | "canvas";

  export type Motion = "static" | "animated";

  export type Group = "plain" | "foil" | "holo" | "poly" | "shimmer" | "negative";

  export type Style =
    | "plain"
    | "foil-satin"
    | "foil-etched"
    | "foil-beam"
    | "foil-ripple"
    | "foil-moire"
    | "holo-prism"
    | "holo-cosmos"
    | "holo-oil"
    | "holo-grid"
    | "holo-burst"
    | "holo-scan"
    | "poly-chroma"
    | "poly-pixel"
    | "poly-plasma"
    | "poly-facet"
    | "poly-orbit"
    | "shimmer-sweep"
    | "shimmer-sparkle"
    | "shimmer-glass"
    | "shimmer-rain"
    | "shimmer-veil"
    | "negative-ink"
    | "negative-neon"
    | "negative-flare"
    | "shader-prism";

  export type Id =
    | "plain"
    | "foil-satin"
    | "foil-satin-animated"
    | "foil-etched"
    | "foil-etched-animated"
    | "foil-beam-static"
    | "foil-beam"
    | "foil-ripple"
    | "foil-ripple-animated"
    | "foil-moire"
    | "foil-moire-animated"
    | "holo-prism"
    | "holo-prism-animated"
    | "holo-cosmos"
    | "holo-cosmos-animated"
    | "holo-oil-static"
    | "holo-oil"
    | "holo-grid"
    | "holo-grid-animated"
    | "holo-burst"
    | "holo-burst-animated"
    | "holo-scan"
    | "holo-scan-animated"
    | "poly-chroma"
    | "poly-chroma-animated"
    | "poly-pixel-static"
    | "poly-pixel"
    | "poly-plasma-static"
    | "poly-plasma"
    | "poly-facet"
    | "poly-facet-animated"
    | "poly-orbit"
    | "poly-orbit-animated"
    | "shimmer-sweep-static"
    | "shimmer-sweep"
    | "shimmer-sparkle-static"
    | "shimmer-sparkle"
    | "shimmer-glass"
    | "shimmer-glass-animated"
    | "shimmer-rain"
    | "shimmer-rain-animated"
    | "shimmer-veil"
    | "shimmer-veil-animated"
    | "negative-ink"
    | "negative-ink-animated"
    | "negative-neon"
    | "negative-neon-animated"
    | "negative-flare"
    | "negative-flare-animated"
    | "shader-prism-static"
    | "shader-prism";

  export type Choice = {
    id: Id;
    label: string;
    group: Group;
    effect: StickerEffect.Id;
    style: Style;
    motion: Motion;
    rendering: Rendering;
  };

  export const DEFAULT: Id = "plain";

  export const PLAIN: Choice = {
    id: "plain",
    label: "Plain",
    group: "plain",
    effect: "plain",
    style: "plain",
    motion: "static",
    rendering: "static-css",
  };

  export const CSS: readonly Choice[] = [
    PLAIN,
    cssChoice(
      "foil-satin",
      "Foil satin static",
      "foil",
      "foil",
      "foil-satin",
      "static",
    ),
    cssChoice(
      "foil-satin-animated",
      "Foil satin animated",
      "foil",
      "foil",
      "foil-satin",
      "animated",
    ),
    cssChoice(
      "foil-etched",
      "Foil etched static",
      "foil",
      "foil",
      "foil-etched",
      "static",
    ),
    cssChoice(
      "foil-etched-animated",
      "Foil etched animated",
      "foil",
      "foil",
      "foil-etched",
      "animated",
    ),
    cssChoice(
      "foil-beam-static",
      "Foil beam static",
      "foil",
      "foil",
      "foil-beam",
      "static",
    ),
    cssChoice(
      "foil-beam",
      "Foil beam animated",
      "foil",
      "foil",
      "foil-beam",
      "animated",
    ),
    cssChoice(
      "foil-ripple",
      "Foil ripple static",
      "foil",
      "foil",
      "foil-ripple",
      "static",
    ),
    cssChoice(
      "foil-ripple-animated",
      "Foil ripple animated",
      "foil",
      "foil",
      "foil-ripple",
      "animated",
    ),
    cssChoice(
      "foil-moire",
      "Foil moire static",
      "foil",
      "foil",
      "foil-moire",
      "static",
    ),
    cssChoice(
      "foil-moire-animated",
      "Foil moire animated",
      "foil",
      "foil",
      "foil-moire",
      "animated",
    ),
    cssChoice(
      "holo-prism",
      "Holo prism static",
      "holo",
      "holo",
      "holo-prism",
      "static",
    ),
    cssChoice(
      "holo-prism-animated",
      "Holo prism animated",
      "holo",
      "holo",
      "holo-prism",
      "animated",
    ),
    cssChoice(
      "holo-cosmos",
      "Holo cosmos static",
      "holo",
      "holo",
      "holo-cosmos",
      "static",
    ),
    cssChoice(
      "holo-cosmos-animated",
      "Holo cosmos animated",
      "holo",
      "holo",
      "holo-cosmos",
      "animated",
    ),
    cssChoice(
      "holo-oil-static",
      "Holo oil static",
      "holo",
      "holo",
      "holo-oil",
      "static",
    ),
    cssChoice(
      "holo-oil",
      "Holo oil animated",
      "holo",
      "holo",
      "holo-oil",
      "animated",
    ),
    cssChoice(
      "holo-grid",
      "Holo grid static",
      "holo",
      "holo",
      "holo-grid",
      "static",
    ),
    cssChoice(
      "holo-grid-animated",
      "Holo grid animated",
      "holo",
      "holo",
      "holo-grid",
      "animated",
    ),
    cssChoice(
      "holo-burst",
      "Holo burst static",
      "holo",
      "holo",
      "holo-burst",
      "static",
    ),
    cssChoice(
      "holo-burst-animated",
      "Holo burst animated",
      "holo",
      "holo",
      "holo-burst",
      "animated",
    ),
    cssChoice(
      "holo-scan",
      "Holo scan static",
      "holo",
      "holo",
      "holo-scan",
      "static",
    ),
    cssChoice(
      "holo-scan-animated",
      "Holo scan animated",
      "holo",
      "holo",
      "holo-scan",
      "animated",
    ),
    cssChoice(
      "poly-chroma",
      "Polychrome static",
      "poly",
      "poly",
      "poly-chroma",
      "static",
    ),
    cssChoice(
      "poly-chroma-animated",
      "Polychrome animated",
      "poly",
      "poly",
      "poly-chroma",
      "animated",
    ),
    cssChoice(
      "poly-pixel-static",
      "Poly pixel static",
      "poly",
      "poly",
      "poly-pixel",
      "static",
    ),
    cssChoice(
      "poly-pixel",
      "Poly pixel animated",
      "poly",
      "poly",
      "poly-pixel",
      "animated",
    ),
    cssChoice(
      "poly-plasma-static",
      "Poly plasma static",
      "poly",
      "poly",
      "poly-plasma",
      "static",
    ),
    cssChoice(
      "poly-plasma",
      "Poly plasma animated",
      "poly",
      "poly",
      "poly-plasma",
      "animated",
    ),
    cssChoice(
      "poly-facet",
      "Poly facet static",
      "poly",
      "poly",
      "poly-facet",
      "static",
    ),
    cssChoice(
      "poly-facet-animated",
      "Poly facet animated",
      "poly",
      "poly",
      "poly-facet",
      "animated",
    ),
    cssChoice(
      "poly-orbit",
      "Poly orbit static",
      "poly",
      "poly",
      "poly-orbit",
      "static",
    ),
    cssChoice(
      "poly-orbit-animated",
      "Poly orbit animated",
      "poly",
      "poly",
      "poly-orbit",
      "animated",
    ),
    cssChoice(
      "shimmer-sweep-static",
      "Shimmer sweep static",
      "shimmer",
      "shimmer",
      "shimmer-sweep",
      "static",
    ),
    cssChoice(
      "shimmer-sweep",
      "Shimmer sweep animated",
      "shimmer",
      "shimmer",
      "shimmer-sweep",
      "animated",
    ),
    cssChoice(
      "shimmer-sparkle-static",
      "Shimmer sparkle static",
      "shimmer",
      "shimmer",
      "shimmer-sparkle",
      "static",
    ),
    cssChoice(
      "shimmer-sparkle",
      "Shimmer sparkle animated",
      "shimmer",
      "shimmer",
      "shimmer-sparkle",
      "animated",
    ),
    cssChoice(
      "shimmer-glass",
      "Shimmer glass static",
      "shimmer",
      "shimmer",
      "shimmer-glass",
      "static",
    ),
    cssChoice(
      "shimmer-glass-animated",
      "Shimmer glass animated",
      "shimmer",
      "shimmer",
      "shimmer-glass",
      "animated",
    ),
    cssChoice(
      "shimmer-rain",
      "Shimmer rain static",
      "shimmer",
      "shimmer",
      "shimmer-rain",
      "static",
    ),
    cssChoice(
      "shimmer-rain-animated",
      "Shimmer rain animated",
      "shimmer",
      "shimmer",
      "shimmer-rain",
      "animated",
    ),
    cssChoice(
      "shimmer-veil",
      "Shimmer veil static",
      "shimmer",
      "shimmer",
      "shimmer-veil",
      "static",
    ),
    cssChoice(
      "shimmer-veil-animated",
      "Shimmer veil animated",
      "shimmer",
      "shimmer",
      "shimmer-veil",
      "animated",
    ),
    cssChoice(
      "negative-ink",
      "Negative ink static",
      "negative",
      "poly",
      "negative-ink",
      "static",
    ),
    cssChoice(
      "negative-ink-animated",
      "Negative ink animated",
      "negative",
      "poly",
      "negative-ink",
      "animated",
    ),
    cssChoice(
      "negative-neon",
      "Negative neon static",
      "negative",
      "poly",
      "negative-neon",
      "static",
    ),
    cssChoice(
      "negative-neon-animated",
      "Negative neon animated",
      "negative",
      "poly",
      "negative-neon",
      "animated",
    ),
    cssChoice(
      "negative-flare",
      "Negative flare static",
      "negative",
      "poly",
      "negative-flare",
      "static",
    ),
    cssChoice(
      "negative-flare-animated",
      "Negative flare animated",
      "negative",
      "poly",
      "negative-flare",
      "animated",
    ),
  ];

  export const CANVAS: readonly Choice[] = [
    canvasChoice(
      "shader-prism-static",
      "Shader prism static",
      "shader-prism",
      "static",
    ),
    canvasChoice(
      "shader-prism",
      "Shader prism animated",
      "shader-prism",
      "animated",
    ),
  ];

  export const ALL: readonly Choice[] = [...CSS, ...CANVAS];

  export function fromWire(value: Option<string>): Id {
    return isId(value) ? value : DEFAULT;
  }

  export function defaultForEffect(effect: StickerEffect.Id): Id {
    if (effect === "foil") return "foil-satin";
    if (effect === "holo") return "holo-prism";
    if (effect === "poly") return "poly-chroma";
    if (effect === "shimmer") return "shimmer-sweep";
    return DEFAULT;
  }

  export function choice(id: Id): Choice {
    return ALL.find((option) => option.id === id) ?? PLAIN;
  }

  export function label(id: Id): string {
    return choice(id).label;
  }

  export function effect(id: Id): StickerEffect.Id {
    return choice(id).effect;
  }

  export function style(id: Id): Style {
    return choice(id).style;
  }

  export function motion(id: Id): Motion {
    return choice(id).motion;
  }

  export function rendering(id: Id): Rendering {
    return choice(id).rendering;
  }

  export function isId(value: Option<string>): value is Id {
    return ALL.some((option) => option.id === value);
  }

  function cssChoice(
    id: Id,
    label: string,
    group: Group,
    effect: StickerEffect.Id,
    style: Style,
    motion: Motion,
  ): Choice {
    return {
      id,
      label,
      group,
      effect,
      style,
      motion,
      rendering: motion === "animated" ? "animated-css" : "static-css",
    };
  }

  function canvasChoice(
    id: Id,
    label: string,
    style: Style,
    motion: Motion,
  ): Choice {
    return {
      id,
      label,
      group: "holo",
      effect: "holo",
      style,
      motion,
      rendering: "canvas",
    };
  }
}
