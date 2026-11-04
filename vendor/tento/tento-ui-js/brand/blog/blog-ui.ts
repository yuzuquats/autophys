import { NativeUi } from "@tento-brand/src/native-ui";

/** Native blog parts; list/pagelet layout remains with its semantic owner. */
export namespace BlogUi {
  const typography = NativeUi.text("blog-type", {
    "hero-title": { tag: "h1", className: "hero-title", declarations: "color:var(--text-pri);" },
    "hero-subtitle": { tag: "p", className: "hero-subtitle", declarations: "color:var(--text-sec);" },
    "article-title": { tag: "h1", className: "blog-post-title", declarations: "font-weight:560;" },
    "article-date": { tag: "p", className: "small blog-post-date", declarations: "" },
    "list-date": { tag: "p", className: "simple-date", declarations: "color:var(--text-ter);--font-size:var(--text-9px);" },
    "list-title": { tag: "p", className: "simple-title", declarations: "--font-size:var(--text-12px);color:var(--text-pri);line-height:1.4;--margin-top:0px;--margin-bottom:0px;" },
  });
  const input = NativeUi.input("blog-input", {
    search: {
      declarations: "font:revert;min-height:revert;color:FieldText;width:100%;padding:12px 0;--font-size:var(--blog-search-input-size,var(--text-15px));border:none;border-bottom:1px solid var(--divider);border-radius:0;outline:none;transition:border-color 0.2s ease;background:transparent;",
      states: { ":focus": "border-bottom-color:var(--text-pri);", "::placeholder": "color:var(--text-ter);" },
    },
  });
  const backLink = NativeUi.link("blog-link", {
    // The article pagelet owns the following title gap. The reusable link only
    // owns its inline arrow/text treatment.
    back: { className: "back-link", declarations: "display:flex;align-items:center;gap:12px;cursor:pointer;font:inherit;line-height:inherit;min-height:0;margin-top:0;margin-bottom:0;width:fit-content;text-decoration:none;color:inherit;" },
  });
  const link = NativeUi.define<HTMLAnchorElement, NativeUi.LinkProps<"back">>({
    component: "link",
    create: () => document.createElement("a"),
    bind: (element, props) => {
      backLink.bind(element, props);
      element.style.textDecoration = "none";
      element.style.color = "inherit";
      // The former native div inherited body metrics; neutralize anchor trim.
      element.style.font = "inherit";
      element.style.lineHeight = "inherit";
      element.style.minHeight = "0";
      element.style.marginTop = "0px";
      element.replaceChildren(
        Object.assign(document.createElement("span"), { textContent: "\u2190" }),
        Object.assign(document.createElement("span"), { textContent: props.text }),
      );
      return element;
    },
    // The pagelet owns the hanging indent; a direct specimen has no date rail.
    storyStyles: [...backLink.storyStyles, ".core-blog-link-back { margin-left:0; }"],
  });
  export type ButtonProps = { readonly variant: "filter" | "see-more"; readonly text: string; readonly pressed?: boolean };
  export const buttonStyle = {
    filter: "padding:0;--font-size:var(--blog-filter-pill-size,var(--text-13px));font-weight:400;text-transform:capitalize;background:transparent;border:none;cursor:pointer;transition:color 0.2s ease;color:var(--text-ter);",
    seeMore: "padding:10px 24px;font-weight:500;color:var(--text-sec);background:transparent;border:1px solid var(--divider);border-radius:6px;cursor:pointer;transition:all 0.2s ease;",
  };
  const buttons = NativeUi.text("blog-button", {
    filter: { tag: "button", className: "filter-pill", context: "font:revert;min-height:revert;", declarations: buttonStyle.filter,
      states: { ":hover": "color:var(--text-pri);", "[aria-pressed=true]": "color:var(--text-pri);font-weight:500;" } },
    "see-more": { tag: "button", className: "see-more-button", context: "font:revert;min-height:revert;", declarations: buttonStyle.seeMore,
      states: { ":hover": "color:var(--text-pri);border-color:var(--text-pri);" } },
  }, "button");
  const button = NativeUi.define<HTMLButtonElement, ButtonProps>({
    component: "button",
    create: () => document.createElement("button"),
    bind: (element, props) => {
      buttons.bind(element, props); element.type = "button";
      element.classList.toggle("active", props.variant === "filter" && !!props.pressed);
      if (props.variant === "filter") element.setAttribute("aria-pressed", String(!!props.pressed));
      else element.removeAttribute("aria-pressed");
      return element;
    },
    storyStyles: buttons.storyStyles,
  });
  export const components = { typography, input, link, button };
}
