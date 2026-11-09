import { AppSwitcher } from "@tento-brand/kit/app-switcher";
import { PACKAGED_APP_SWITCHER } from "@tento-brand/kit/app-switcher.packaged";

/**
 * A packaged app switcher on the header's brand link: a chevron after the
 * wordmark opens a card of related apps, with Autophys current. Everything it
 * shows comes from the switcher `autophys build-web` packaged from the
 * untracked html/app-switcher.json: the apps and their tiles, the label, an
 * optional footer link and the colour tokens. It is packaged only when
 * TENTO_APP_SWITCHER=on is set in the untracked html/.env or the build's
 * environment (html/.env.example). Otherwise, as in any clone of the
 * repository, nothing is packaged and this mounts nothing.
 *
 * The brand link stays the link it was (home on the landing, back to the
 * deck in the app): the switcher only wraps it. The card's margins are
 * measured from the 28px mark. Autophys is light only, so it takes the
 * manifest's light tokens.
 */
export function mountAppSwitcher(brand: HTMLAnchorElement, mark: () => Element | null): AppSwitcher | null {
  const packaged = PACKAGED_APP_SWITCHER;
  if (packaged == null || packaged.apps.length === 0) return null;
  if (brand.parentElement instanceof AppSwitcher) return brand.parentElement;
  const switcher = AppSwitcher.makeWith({
    apps: packaged.apps,
    current: "autophys",
    label: packaged.label,
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
    /* Above Autophys's own panels and drawer; the manifest sets no layer. */
    --brand-app-switcher-layer: 1000;
    font-family: -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
`;
