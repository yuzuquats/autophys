import { css } from "../../component-styles";

export const chrome = css`
  .brand-nav-link {
    color: var(--text-sec);
    text-decoration: none;
  }
  .brand-nav-link:hover {
    color: var(--text-pri);
    text-decoration: underline;
  }
  /* Persistent "you are here" state, derived from the current URL (not hover).
     Brighter than a resting link so the active section is always legible; hover
     still layers its underline on top. */
  .brand-nav-link.nav-current {
    color: var(--text-pri);
  }
  .brand-nav-title {
    color: var(--text-pri);
  }
  .brand-footer-line {
    --font-size: var(--text-12px);
    color: var(--text-sec);
  }
  .brand-footer-link {
    color: var(--blue);
  }
  /* The brand-nav-details-* dropdown styling lives in the std-brand-nav-details
     shadow ($styles in brand-nav-details.ts), not here: the mega-menu popover is
     portaled to document.body, outside this brand shadow scope, so chrome rules
     never reach it — shadow-scoped styles travel with the portaled element. */
`;
