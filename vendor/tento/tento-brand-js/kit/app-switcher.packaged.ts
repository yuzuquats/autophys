import type { AppSwitcher } from "./app-switcher";

/**
 * The app switcher a site was packaged with. On disk this is `undefined`:
 * the site configures no switcher, and a design may use its own default.
 * tento-web's bundler (`AppSwitcherPlugin`, tento-web-js/build-plugins)
 * replaces this module when the site has an `app-switcher.json` beside its
 * routes: with `null` when its `app-switcher.env` (or the process
 * environment) sets `TENTO_APP_SWITCHER=off`, so no link or icon is bundled,
 * and with the manifest's label and apps, icons inlined, when it is `on`.
 */
export type PackagedAppSwitcher = {
  /** The chevron's accessible name, or `null` for the host's own. */
  readonly label: string | null;
  readonly apps: readonly AppSwitcher.App[];
};

export const PACKAGED_APP_SWITCHER: PackagedAppSwitcher | null | undefined = undefined;
