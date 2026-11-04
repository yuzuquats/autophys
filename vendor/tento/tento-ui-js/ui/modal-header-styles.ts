import { css } from "@tento-ui/component-styles";

// A modal's title block: an h1 and, under it, a caption p. Sized on the
// typography aliases so the scale lives in one place.
//
// The sizes are CSS custom properties with the aliases as their defaults, so a
// caller that needs the block quieter -- a header band with 100px to live in,
// say -- sets a knob on its host and gets the same block one step down the
// ramp, rather than restating the rules with a different literal. Nothing that
// does not set a knob moves.
//
//   --modal-header-title-size      default var(--h6-size)
//   --modal-header-title-gap       default 8px      (space under the title)
//   --modal-header-caption-size    default var(--small-size)
//   --modal-header-caption-color   default var(--text-sec)
export namespace LonaModalHeader {
  export const $style = css`
    .lona-modal-header {
      color: var(--text-pri);
      padding: 20px 20px;
      align-items: start;
    }

    .lona-modal-header h1 {
      --font-size: var(--modal-header-title-size, var(--h6-size));
      --margin-bottom: var(--modal-header-title-gap, 8px);
    }

    .lona-modal-header p {
      --font-size: var(--modal-header-caption-size, var(--small-size));
      color: var(--modal-header-caption-color, var(--text-sec));
    }
  `;
}
