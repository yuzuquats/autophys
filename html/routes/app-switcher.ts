import { AppSwitcher } from "@tento-brand/kit/app-switcher";
import { PACKAGED_APP_SWITCHER } from "@tento-brand/kit/app-switcher.packaged";

/**
 * The Lona family app switcher on the header's brand link: a chevron after
 * the wordmark opens a card of the family's apps, with Autophys current.
 * The apps are the ones `autophys build-web` packaged from
 * html/app-switcher.json, which it does only when TENTO_APP_SWITCHER=on is
 * set in the untracked html/.env or the build's environment. Otherwise,
 * as in any clone of the repository, nothing is packaged and this mounts
 * nothing (html/app-switcher/README.md).
 *
 * The brand link stays the link it was (home on the landing, back to the
 * deck in the app): the switcher only wraps it. The card's margins are
 * measured from the 32px mark, as in the Lona family header, and its colours
 * are that header's light variant (Autophys is light only).
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
  });
  switcher.classList.add("ap-app-switcher");
  brand.replaceWith(switcher);
  switcher.append(brand);
  return switcher;
}

/** The Lona family header's light switcher colours (tento-brand-lona-js family-header.ts). */
export const appSwitcherStyles = `
  .ap-app-switcher {
    /* It replaces .ck-brand as the flex item, so it keeps .ck-brand's no-shrink. */
    flex-shrink: 0;
    --brand-app-switcher-margin: 12px;
    --brand-app-switcher-sheet: #fff;
    --brand-app-switcher-border: #e4e6df;
    --brand-app-switcher-current: #f1f2ec;
    --brand-app-switcher-hover: #f6f7f2;
    --brand-app-switcher-text: #292d26;
    --brand-app-switcher-chevron: #292d26;
    --brand-app-switcher-dot: #5f9b62;
    --brand-app-switcher-radius: 16px;
    --brand-app-switcher-cell-radius: 10px;
    --brand-app-switcher-shadow: 0 18px 40px -10px #20261d40, 0 2px 8px #20261d14;
    --brand-app-switcher-layer: 1000;
    font-family: -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
`;
