import type { AppSwitcher } from "./app-switcher";

/**
 * The app switcher a site was packaged with. On disk this is `undefined`:
 * the site configures no switcher, and a design may use its own default.
 * tento-web's bundler (`AppSwitcherPlugin`, tento-web-js/build-plugins)
 * replaces this module when the site has an `app-switcher.json` beside its
 * routes: with the manifest's label, apps (icons inlined), footer and
 * tokens, when the packager's untracked `.env` (or the process environment)
 * sets `TENTO_APP_SWITCHER=on`, and otherwise with `null`, so no link, icon
 * or token is bundled.
 */
export type PackagedAppSwitcher = {
  /** The chevron's accessible name, or `null` for the host's own. */
  readonly label: string | null;
  readonly apps: readonly AppSwitcher.App[];
  /** The footer link (`AppSwitcher.Props.footer`), or `null` for the host's own. */
  readonly footer: AppSwitcher.Footer | null;
  /** The design's tokens per variant (`AppSwitcher.Props.tokens`), or `null` for the host's own. */
  readonly tokens: PackagedAppSwitcher.Tokens | null;
};

export namespace PackagedAppSwitcher {
  /** Tokens for a light and a dark variant; a host picks the one on screen. */
  export type Tokens = {
    readonly light?: AppSwitcher.Tokens;
    readonly dark?: AppSwitcher.Tokens;
  };
}

export const PACKAGED_APP_SWITCHER: PackagedAppSwitcher | null | undefined = undefined;
