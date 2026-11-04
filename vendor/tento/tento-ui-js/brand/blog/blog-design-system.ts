export type NavChild = {
  label: string;
  // Target path of this link — the single nav destination. Navigation runs through
  // NavConfig.onNavigate(href); the SAME href derives the current-page highlight
  // (matched against the live URL), so selection stays declarative.
  href?: Option<string>;
  description?: Option<string>;
  // Optional leading feature-icon tile (a `std-*-icon`), rendered before the
  // label in mega-menu rows. Derived per-target in the landing nav layer.
  $icon?: Option<HTMLElement>;
};

export type NavItem = {
  label: string;
  // Target path of this top-level item; see NavChild.href.
  href?: Option<string>;
  children?: Option<NavChild[]>;
  details?: Option<NavDetailsConfig>;
};

export type NavDetailsColumn = {
  title: string;
  items: NavChild[];
  bold?: boolean;
};

export type NavDetailsConfig = {
  header: Option<string>;
  columns: [NavDetailsColumn, NavDetailsColumn, NavDetailsColumn];
  footer: Option<NavChild>;
  image?: Option<{ src: string; alt?: Option<string> }>;
};

export type NavConfig = {
  items: NavItem[];
  cta: Option<NavItem>;
  // The single navigation strategy: clicking any item / child / cta that has an
  // `href` calls this. The landing layer wires it to its targetMode-aware
  // navigate() (SPA for marketing routes, full-page / subdomain otherwise).
  onNavigate: (href: string) => void;
};

// BlogDesignSystem interface removed — replaced by Brand.DesignSystem + Brand.BlogPage
