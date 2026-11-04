// Shared public contract for the `std-*-icon` family. This is a CONVENTION, not a
// base class — every icon stays a standalone LonaWebComponent but follows the same
// surface:
//
//   --icon-size      tile dimension (falls back to the legacy --icon-button-dimension)
//   --icon-color     the icon's signature accent color
//   variant="grayscale" | "filled"   pure-CSS state (hover is automatic)
//   makeWith({ variant, size })       typed factory built on applyIconProps
//
// Grayscale-first icons (chat, link, tilde, search, pomodoro, calendar) idle muted
// and colorize on hover; `variant="filled"` floods the tile with --icon-color.
// Filled-first icons (sheets, tasks, theme-picker) render colored by default and
// expose `variant="grayscale"` for the muted look.

export type IconVariant = "grayscale" | "filled";

export type IconProps = Optional<{
  variant: IconVariant;
  size: number;
}>;

// Reflects icon props onto an icon element: the `variant` attribute (which drives
// the pure-CSS grayscale/filled styling) and the `--icon-size` dimension. Both are
// optional — an absent field leaves the element at its intrinsic default.
export function applyIconProps($el: HTMLElement, props: IconProps): void {
  if (props.variant != null) {
    $el.setAttribute("variant", props.variant);
  }
  if (props.size != null) {
    $el.style.setProperty("--icon-size", `${props.size}px`);
  }
}
