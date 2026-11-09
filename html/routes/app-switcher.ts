import { AppSwitcher } from "@tento-brand/kit/app-switcher";
import { PACKAGED_APP_SWITCHER } from "@tento-brand/kit/app-switcher.packaged";

/**
 * The Lona family app switcher on the header's brand link: a chevron after
 * the wordmark opens a card of the family's apps, with Autophys current.
 * Everything it shows is the switcher `autophys build-web` packaged from
 * html/app-switcher.json: the apps and their tiles, the label, the studio
 * footer link and the light colour tokens. That manifest is a gitignored
 * copy of tento's generated Lona preset
 * (tento-brand-lona-js/family/lona-switcher.json), packaged only when
 * TENTO_APP_SWITCHER=on is set in the untracked html/.env or the build's
 * environment (html/.env.example). Otherwise, as in any clone of the
 * repository, nothing is packaged and this mounts nothing.
 *
 * The brand link stays the link it was (home on the landing, back to the
 * deck in the app): the switcher only wraps it. The card's margins are
 * measured from the 28px mark, as in the Lona family header. Autophys is
 * light only, so it takes the preset's light tokens.
 */
export function mountAppSwitcher(brand: HTMLAnchorElement, mark: () => Element | null): AppSwitcher | null {
  const packaged = PACKAGED_APP_SWITCHER;
  if (packaged == null || packaged.apps.length === 0) return null;
  if (brand.parentElement instanceof AppSwitcher) return brand.parentElement;
  const switcher = AppSwitcher.makeWith({
    apps: packaged.apps,
    current: "autophys",
    label: packaged.label ?? "Switch Lona app",
    anchor: () => (mark() ?? brand).getBoundingClientRect(),
    footer: packaged.footer,
    tokens: packaged.tokens?.light,
  });
  switcher.classList.add("ap-app-switcher");
  brand.replaceWith(switcher);
  switcher.append(brand);
  return switcher;
}

/**
 * Autophys's own layout around the switcher; its colours, radii and footer
 * come from the packaged tokens and the kit.
 */
export const appSwitcherStyles = `
  .ap-app-switcher {
    /* It replaces .ck-brand as the flex item, so it keeps .ck-brand's no-shrink. */
    flex-shrink: 0;
    /* Above Autophys's own panels and drawer; the preset sets no layer. */
    --brand-app-switcher-layer: 1000;
    font-family: -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  /* The kit's footer link inherits the header's -0.35px tracking; the family
     header's studio link is set without it. */
  .ap-app-switcher::part(footer-link) { letter-spacing: normal; }
`;
