import { NativeUi } from "@tento-brand/src/native-ui";

/** Native constituents used by landing blocks and their direct specimens.
 * Layout stays in the owning block; complete isolated styles live here. */
export namespace LandingUi {
  export const actionBase = `
    display:inline-flex;align-items:center;justify-content:center;min-height:36px;
    background:var(--bg);border:1px solid var(--divider);border-radius:6px;
    padding:0 14px;text-decoration:none;--font-size:var(--text-10px);
    --line-height-ratio:1;transition:border-color 0.3s ease,box-shadow 0.3s ease;
  `;
  export const actionHover = "border-color:var(--text-ter);box-shadow:var(--box-shadow-light);";
  export const actionFocus = "outline:2px solid var(--blue);outline-offset:2px;";
  export const primaryAction = "color:var(--bg);background:var(--text-pri);border-color:var(--text-pri);";
  const states = { ":hover": actionHover, ":focus-visible": actionFocus };
  const links = NativeUi.link("landing-action", {
    "hero-primary": { declarations: actionBase + "font-weight:500;" + primaryAction, className: "cta", states },
    "hero-secondary": { declarations: actionBase + "font-weight:500;color:var(--text-sec);", className: "cta", states },
    "cta-primary": { declarations: actionBase + "font-weight:550;" + primaryAction, className: "link-button primary", states },
    "cta-secondary": { declarations: actionBase + "font-weight:550;color:var(--text-pri);", className: "link-button", states },
  });
  export type ActionProps = {
    readonly label: string;
    readonly href: string;
    readonly variant: "primary" | "secondary";
    readonly treatment: "hero" | "cta";
  };
  const action = NativeUi.define<HTMLAnchorElement, ActionProps>({
    component: props => props.treatment === "hero" ? "link" : "button",
    create: () => document.createElement("a"),
    bind: (element, props) => {
      links.bind(element, { variant: `${props.treatment}-${props.variant}`, text: props.label, href: props.href });
      element.toggleAttribute("primary", props.treatment === "hero" && props.variant === "primary");
      return element;
    },
    storyStyles: links.storyStyles,
  });
  const nativeTypography = NativeUi.text("landing-type", {
    "hero-kicker": { tag: "p", className: "kicker", declarations: "--margin-top:0px;--margin-bottom:0px;text-transform:uppercase;" },
    "hero-title": { tag: "h1", className: "headline", declarations: "--margin-top:0px;--margin-bottom:0px;font-family:var(--landing-copy-font-family,inherit);" },
    "hero-subtitle": { tag: "p", className: "subtitle", declarations: "--margin-top:0px;--margin-bottom:0px;font-family:var(--landing-copy-font-family,inherit);color:var(--text-sec);" },
    "section-heading": { tag: "h2", declarations: "--margin-top:0px;--margin-bottom:0px;--font-size:var(--text-22px);--line-height-ratio:1.06;color:var(--text-pri);font-family:var(--landing-copy-font-family,inherit);" },
    "section-subtext": { tag: "p", declarations: "--margin-top:0px;--margin-bottom:0px;--font-size:var(--text-14px);--line-height-ratio:1.52;color:var(--text-sec);font-family:var(--landing-copy-font-family,inherit);" },
    "cta-heading": { tag: "h2", declarations: "--margin-top:0px;--margin-bottom:0px;--font-size:var(--text-24px);--line-height-ratio:1.06;color:var(--text-pri);font-family:var(--landing-copy-font-family,inherit);", conditions: [{ when: "@media (max-width:768px)", declarations: "--margin-top:0px;--margin-bottom:0px;--font-size:var(--text-22px);" }] },
    "cta-subtext": { tag: "p", declarations: "--margin-top:0px;--margin-bottom:0px;--font-size:var(--text-14px);--line-height-ratio:1.52;color:var(--text-sec);font-family:var(--landing-copy-font-family,inherit);" },
    "card-title": { tag: "h3", className: "card-title", declarations: "--margin-top:0px;--margin-bottom:0px;font-weight:600;--font-size:var(--text-16px);--line-height-ratio:1.15;color:var(--text-pri);font-family:var(--landing-card-copy-font-family,inherit);" },
    "card-subtitle": { tag: "p", className: "card-subtitle", declarations: "--margin-top:0px;--margin-bottom:0px;--font-size:var(--text-11px);color:color-mix(in srgb,var(--text-pri) 65%,transparent 35%);font-family:var(--landing-card-copy-font-family,inherit);" },
    "bento-heading": { tag: "h2", className: "section-title", declarations: "--margin-top:0px;--margin-bottom:0px;font-family:var(--landing-copy-font-family,inherit);" },
  });
  const typography = NativeUi.define<HTMLElement, Parameters<typeof nativeTypography.bind>[1]>({
    component: "typography",
    create: props => nativeTypography.make(props),
    bind: (element, props) => {
      nativeTypography.bind(element, props);
      // Slotted copy also matches document typography. Bind the public token
      // on the actual text so ordinary light-DOM rules cannot mask it.
      if (props.variant === "card-title" || props.variant === "card-subtitle") {
        element.style.fontFamily = "var(--landing-card-copy-font-family, inherit)";
      } else if (props.variant !== "hero-kicker") {
        element.style.fontFamily = "var(--landing-copy-font-family, inherit)";
      } else if (element.style.fontFamily.includes("--landing-")) {
        element.style.removeProperty("font-family");
      }
      return element;
    },
    storyStyles: nativeTypography.storyStyles,
  });
  export const components = { typography, link: action, button: action };
}
