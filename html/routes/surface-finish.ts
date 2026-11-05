/** Keep the floating surface's depth through its rise. Flatten it only once
 * its actual transform animation finishes, including interrupted returns. */
export function installSurfaceFinish(landing: HTMLElement): void {
  let revision = 0;
  const sync = () => {
    const own = ++revision;
    if (landing.hasAttribute("data-lowered")) {
      landing.removeAttribute("data-ap-returning");
      return;
    }
    landing.setAttribute("data-ap-returning", "");
    const moves = landing.getAnimations().filter(animation =>
      animation.effect instanceof KeyframeEffect &&
      animation.effect.target === landing &&
      animation.effect.getKeyframes().some(frame => frame.transform !== undefined));
    void Promise.all(moves.map(animation => animation.finished)).then(() => {
      if (own === revision && !landing.hasAttribute("data-lowered")) {
        landing.removeAttribute("data-ap-returning");
      }
    }).catch(() => {}); // Reversal cancels the old move; its new state owns depth.
  };
  new MutationObserver(sync).observe(landing, { attributes: true, attributeFilter: ["data-lowered"] });
}

export const surfaceFinishStyles = `
.ck-landing {
  box-shadow: 0 0 1.5px rgb(0 0 0 / 0%), 0 -8px 32px rgb(0 0 0 / 0%);
  transition: border-radius 650ms ease-out, box-shadow 650ms ease-out;
}
.ck-landing[data-lowered], .ck-landing[data-ap-returning] {
  border-radius: 32px 32px 0 0;
  box-shadow: 0 0 1.5px rgb(0 0 0 / 38%), 0 -8px 32px rgb(0 0 0 / 8%);
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .ck-landing { transition: none; }
}
`;
