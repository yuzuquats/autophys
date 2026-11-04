import { Lazy } from "@tento-core/lazy";

type MediaChromeImport = {};

// Held in a binding, not written inline: Deno's graph builder follows a
// dynamic import only when it can read the specifier statically, and this one
// is browser-only. Inline, every `deno test`/`deno check` over anything that
// reaches this module downloads the bundle from a floating jsdelivr tag.
const MEDIA_CHROME_URL = "https://cdn.jsdelivr.net/npm/media-chrome@4/+esm";

export const MEDIA_CHROME_IMPORT: Lazy<MediaChromeImport> = new Lazy(
  () => import(MEDIA_CHROME_URL)
);
