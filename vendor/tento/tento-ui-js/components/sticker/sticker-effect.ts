export namespace StickerEffect {
  export type Id = "plain" | "foil" | "holo" | "poly" | "shimmer";

  export type Choice = {
    id: Id;
    label: string;
  };

  export const DEFAULT: Id = "plain";

  export const ALL: readonly Choice[] = [
    { id: "plain", label: "Plain" },
    { id: "foil", label: "Foil" },
    { id: "holo", label: "Holo" },
    { id: "poly", label: "Poly" },
    { id: "shimmer", label: "Shimmer" },
  ];

  export function fromWire(value: Option<string>): Id {
    return isId(value) ? value : DEFAULT;
  }

  export function label(id: Id): string {
    return ALL.find((option) => option.id === id)?.label ?? id;
  }

  function isId(value: Option<string>): value is Id {
    return value === "plain" ||
      value === "foil" ||
      value === "holo" ||
      value === "poly" ||
      value === "shimmer";
  }
}
