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
 * measured from the 28px mark, as in the Lona family header, and its colours
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
  switcher.append(brand, studioLink());
  return switcher;
}

/**
 * The link at the foot of the switcher's card, as every Lona app shows it
 * (operator, 2026-11-09). The values are tento-brand-lona-js
 * family/products.ts `LONA_STUDIO_LINK`, copied here because that module
 * imports every family asset. Studio is not a Lona product: no tile and no
 * "Lona Studio" wording, only its description and address.
 */
const STUDIO_LINK = { href: "https://studio.lona.so/", label: "Product design and engineering", address: "studio.lona.so" };

function studioLink(): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "ap-studio-link";
  link.slot = "footer";
  link.href = STUDIO_LINK.href;
  link.target = "_blank";
  link.rel = "noopener";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = STUDIO_LINK.label;
  const address = document.createElement("span");
  address.className = "address";
  const arrow = document.createElement("span");
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = " \u2197";
  address.append(STUDIO_LINK.address, arrow);
  link.append(label, address);
  return link;
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
  /* The studio link in the card's footer, styled as the family header's light
     variant (family-header.ts #studio): a row in the hover tint with the
     cells' radius, which the kit insets 12px from the card's sides and bottom.
     The address wraps under the description only on a card too narrow for
     one line. */
  .ap-app-switcher > .ap-studio-link {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 2px 12px;
    margin: 0;
    padding: 10px 12px;
    border-radius: var(--brand-app-switcher-cell-radius, 10px);
    background: var(--brand-app-switcher-hover);
    color: var(--brand-app-switcher-text);
    font-size: 12.5px;
    font-weight: 500;
    line-height: 16px;
    letter-spacing: normal;
    text-decoration: none;
    outline: none;
  }
  .ap-app-switcher > .ap-studio-link:hover { background: var(--brand-app-switcher-current); }
  .ap-app-switcher > .ap-studio-link:focus-visible {
    background: var(--brand-app-switcher-current);
    box-shadow: inset 0 0 0 2px currentColor;
  }
  .ap-app-switcher > .ap-studio-link .address {
    font-size: 11.5px;
    font-weight: 400;
    color: #6a6e66;
    white-space: nowrap;
  }
`;
