// build-switch: AUTOPHYS_HOSTED_BADGE
/**
 * The hackathon pill's copy and link. tento-web's `BuildSwitchPlugin` bundles
 * this module as written only when `AUTOPHYS_HOSTED_BADGE=on` is set in the
 * untracked `html/.env` or the build's environment; otherwise the bundle gets
 * `null` here, so neither the text nor the link is in it (html/.env.example).
 */
const copy: { readonly text: string; readonly href: string } | null = {
  text: "Built for Meta Global Hacks",
  href: "https://dev.meta.ai/events/global-hackathon",
};

export default copy;
