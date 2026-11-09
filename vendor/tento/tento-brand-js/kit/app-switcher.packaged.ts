import type { AppSwitcher } from "./app-switcher";

/**
 * The app switcher a site was packaged with. On disk this is `undefined`:
 * the site configures no switcher, and a design may use its own default.
 * tento-web's bundler (`AppSwitcherPlugin`, tento-web-js/build-plugins)
 * replaces this module when the site has an `app-switcher.json` beside its
 * routes: with the manifest's label and apps, icons inlined, when the
 * packager's untracked `.env` (or the process environment) sets
 * `TENTO_APP_SWITCHER=on`, and otherwise with `null`, so no link or icon is
 * bundled.
 */
export type PackagedAppSwitcher = {
  /** The chevron's accessible name, or `null` for the host's own. */
  readonly label: string | null;
  readonly apps: readonly AppSwitcher.App[];
};

export const PACKAGED_APP_SWITCHER: PackagedAppSwitcher | null | undefined = undefined;
