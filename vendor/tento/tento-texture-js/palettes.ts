/** Art presets only. Host pages own their typography, actions and UI tokens. */
export const texturePalettes = {
  cobalt: {
    label: "Cobalt",
    base: "#11151d",
    bands: ["#17243e", "#345bc1", "#182c61", "#254285"],
    art: ["#819ed2", "#48669d", "#2d4163"],
    layers: ["#56cfe1", "#ff806b", "#d9ed76"],
  },
  copper: {
    label: "Copper",
    base: "#f2e4d4",
    bands: ["#e6c9af", "#dba47a", "#e6c2ab", "#edcfb0"],
    art: ["#b06a47", "#cba087", "#ddc0a7"],
    layers: ["#145b89", "#b33620", "#4e5e16"],
  },
  sage: {
    label: "Sage",
    base: "#e0e7d9",
    bands: ["#c6d4bc", "#94b396", "#bfd4bd", "#c7d4ae"],
    art: ["#658b68", "#8fa78a", "#b1c2a6"],
    layers: ["#155c86", "#ae382d", "#664395"],
  },
  plum: {
    label: "Plum",
    base: "#211526",
    bands: ["#45203f", "#79345e", "#4b2a59", "#60354f"],
    art: ["#ca8cb6", "#8d567e", "#54334f"],
    layers: ["#63dfcb", "#ff8cb3", "#f2ce67"],
  },
  ice: {
    label: "Ice",
    base: "#e5edf2",
    bands: ["#cbdde7", "#9dbfd1", "#bad3df", "#d9e4ed"],
    art: ["#769bb4", "#9bb6c8", "#b9cdd9"],
    layers: ["#126582", "#b13d28", "#655098"],
  },
} as const;
export type TexturePaletteName = keyof typeof texturePalettes;
export type TexturePalette = typeof texturePalettes[TexturePaletteName];
export function fieldColors(
  id: TexturePaletteName,
): readonly [string, string, string] {
  return texturePalettes[id].layers;
}
