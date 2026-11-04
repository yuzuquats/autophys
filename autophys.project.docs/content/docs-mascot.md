# Muse Code plugin heading mascot

Purpose: a small delight on the landing docs. Hovering the **Muse Code plugin**
heading fades the dancing Muse in as it slides 40px into place just left of the
heading, with the figure's centre line on the heading text's centre line;
leaving fades it back out. Requested by the operator on 2026-11-04.

## Scope

- `html/routes/muse-twerk.svg`: the operator's `muse-twerk.svg` (a 1262x1246
  plush figure animated by 70 horizontal slices with CSS keyframes), with its
  embedded PNG re-encoded as a 256px WebP with alpha (1.46 MB to 96 KB, about
  15 KB gzipped), keyframe matrices rounded to four decimals, and each slice's
  clip widened by 6 units so the seams between slices no longer show. Its own
  `prefers-reduced-motion` rule keeps the figure still.
- `html/routes/muse-peek.ts`: finds the heading in std-documentation's shadow
  root (waiting for it with a MutationObserver), places a decorative `<img>`
  (empty alt, `aria-hidden`, no pointer events) in the docs section, loads the
  SVG when the heading comes within 800px, and toggles it on the heading's
  pointerenter/pointerleave. 120px wide; under reduced motion it only fades.
- `html/routes/docs.ts`: mounts it beside the docs (`museSectionPeek`).

Desktop only by intent: on narrow pages the figure may sit off the left edge
(operator: "dont worry about mobile").

## Validation

- `deno check routes/docs.ts` (html/), and the deploy gate's `deno test html/`.
- Headless Chrome against autophys.lona.so at 1440x700 after each deploy: hidden
  until the heading is hovered, not shown by hovering the section body, centred
  on the heading text to within 0.02px, a 12px gap to the text, 52px (hidden,
  opacity 0) after leaving. Side-by-side render of the original and compressed
  SVG at 64 and 260px.

## Remaining

- The 256px raster is slightly soft at 120px on dense screens (accepted).
