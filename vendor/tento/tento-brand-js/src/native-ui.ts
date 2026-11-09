import { setSafeHref } from "./safe-url";
import type { ComponentExample, ComponentStyle } from "./component-catalogue";

/** Factories bind existing native elements; styles remain in their original scope.
 * storyStyles declares the complete isolated appearance without another element. */
export namespace NativeUi {
  export interface Factory<E extends HTMLElement, P> extends ComponentFactory<E, P> {
    readonly storyStyles: readonly ComponentStyle[];
  }
  export type TextProps<V extends string> = {
    readonly variant: V;
    readonly text: string;
  };
  export type LinkProps<V extends string> = TextProps<V> & {
    readonly href: string;
    readonly ariaLabel?: string;
    readonly target?: string;
    readonly rel?: string;
  };
  export type InputProps<V extends string> = {
    readonly variant: V;
    readonly label: string;
    readonly value: string;
    readonly placeholder?: string;
    readonly disabled?: boolean;
    readonly onInput?: (value: string, event: Event) => void;
  };
  export type Profile = {
    readonly tag?: keyof HTMLElementTagNameMap;
    readonly declarations: string;
    /** Existing production classes, if any. No placement class is removed. */
    readonly className?: string;
    /** Inherited production metrics needed by a direct isolated subject. */
    readonly context?: string;
    readonly states?: Readonly<Record<string, string>>;
    readonly conditions?: readonly { readonly when: string; readonly declarations: string }[];
  };

  export function define<E extends HTMLElement, P>(definition: {
    /** Semantic identity for inspectors; never changes the element's box tree. */
    readonly component?: string | ((props: P) => string);
    readonly create: (props: P) => E;
    readonly bind: (element: E, props: P) => E;
    readonly storyStyles?: readonly ComponentStyle[];
  }): Factory<E, P> {
    const bind = (element: E, props: P): E => {
      const result = definition.bind(element, props);
      const identity = typeof definition.component === "function" ? definition.component(props) : definition.component;
      if (identity) result.dataset.brandComponent = identity;
      return result;
    };
    return {
      make: props => bind(definition.create(props), props),
      bind,
      get storyStyles() { return definition.storyStyles ?? []; },
    };
  }

  function profiles<V extends string>(prefix: string, values: Readonly<Record<V, Profile>>) {
    const marker = (variant: V) => "core-" + prefix + "-" + variant;
    // Variant classes belong to this factory even for authored production markup.
    const ownedClasses = [...new Set(Object.entries(values).flatMap(([key, raw]) =>
      [marker(key as V), ...((raw as Profile).className?.split(/\s+/).filter(Boolean) ?? [])]))];
    const style = Object.entries(values).map(([key, raw]) => {
      const profile = raw as Profile, selector = "." + marker(key as V);
      return selector + " { " + (profile.context ?? "") + profile.declarations + " }\n" +
        Object.entries(profile.states ?? {}).map(([state, declarations]) =>
          selector + state + " { " + declarations + " }").join("\n") + "\n" +
        (profile.conditions ?? []).map(condition =>
          condition.when + " { " + selector + " { " + condition.declarations + " } }").join("\n");
    }).join("\n");
    return {
      storyStyles: [style],
      apply(element: HTMLElement, variant: V): void {
        const profile = values[variant];
        if (!profile) throw new Error(prefix + ": unsupported variant " + variant);
        element.classList.remove(...ownedClasses);
        const classes = [marker(variant), ...(profile.className?.split(/\s+/).filter(Boolean) ?? [])];
        element.classList.add(...classes);
      },
      tag(variant: V): keyof HTMLElementTagNameMap { return values[variant].tag ?? "p"; },
    };
  }

  export function text<V extends string>(prefix: string, values: Readonly<Record<V, Profile>>, component = "typography"): Factory<HTMLElement, TextProps<V>> {
    const held = profiles(prefix, values);
    return define({
      component,
      create: props => document.createElement(held.tag(props.variant)),
      bind: (element: HTMLElement, props: TextProps<V>) => {
        held.apply(element, props.variant);
        element.textContent = props.text;
        return element;
      },
      storyStyles: held.storyStyles,
    });
  }

  export function link<V extends string>(prefix: string, values: Readonly<Record<V, Profile>>, component: string | ((props: LinkProps<V>) => string) = "link"): Factory<HTMLAnchorElement, LinkProps<V>> {
    const held = profiles(prefix, values);
    return define({
      component,
      create: () => document.createElement("a"),
      bind: (element: HTMLAnchorElement, props: LinkProps<V>) => {
        held.apply(element, props.variant);
        element.textContent = props.text;
        setSafeHref(element, props.href);
        optionalAttribute(element, "aria-label", props.ariaLabel);
        optionalAttribute(element, "target", props.target);
        optionalAttribute(element, "rel", props.rel ?? (props.target === "_blank" ? "noopener noreferrer" : undefined));
        return element;
      },
      storyStyles: held.storyStyles,
    });
  }

  export function input<V extends string>(prefix: string, values: Readonly<Record<V, Profile>>): Factory<HTMLInputElement, InputProps<V>> {
    const held = profiles(prefix, values);
    return define({
      component: "input",
      create: () => { const input = document.createElement("input"); input.type = "text"; return input; },
      bind: (element: HTMLInputElement, props: InputProps<V>) => {
        held.apply(element, props.variant);
        element.setAttribute("aria-label", props.label);
        element.value = props.value;
        element.placeholder = props.placeholder ?? "";
        element.disabled = props.disabled ?? false;
        element.oninput = props.onInput ? event => props.onInput!(element.value, event) : null;
        return element;
      },
      storyStyles: held.storyStyles,
    });
  }

  export function example<E extends HTMLElement, P>(factory: Factory<E, P>, props: P, title?: string): ComponentExample {
    return { title, styles: factory.storyStyles, render: () => factory.make(props) };
  }

  function optionalAttribute(element: HTMLElement, name: string, value: string | undefined): void {
    if (value === undefined) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
}
