# App switcher

The header's app switcher (the chevron after the Autophys mark) lists the
Lona family of apps. Its data model is chosen when the web app is packaged,
not in code:

- `../app-switcher.json` lists the apps in grid order: `id`, `name`, an
  `http(s)` `href` and an `icon` (an SVG here in `icons/`). `label` is the
  chevron's accessible name.
- `../app-switcher.env` sets `TENTO_APP_SWITCHER=on` or `off`. The build's
  environment overrides it. With `off`, no link or icon is bundled and the
  header has no switcher.

tento-web's bundler (`vendor/tento/tento-web-js/build-plugins/app-switcher.deno.ts`)
reads both files during `autophys build-web` and replaces
`@tento-brand/kit/app-switcher.packaged` with the result.
`routes/app-switcher.ts` mounts the switcher on the header's brand link.

`icons/*.svg` are the Lona family's switcher tiles, copied byte for byte from
tento's `tento-brand-lona-js/family/assets.generated.ts` (`GENERATED_TILES`,
manifest sha256 `95860d94b0a0afca…`). After the family's artwork changes,
copy them again from that table rather than editing them here.
