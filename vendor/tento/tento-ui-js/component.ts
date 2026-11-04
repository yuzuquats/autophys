import { css, Style } from "./component-styles";
import { Flexbox } from "./components/flexbox";
import { DomUtils } from "./dom";
import { $, $_maybe, $qs, $qs_maybe, $qsa } from "./dom-selectors";
import { $$ } from "./fastdom";
import { GESTURE_MANAGER, GestureManager } from "./gesture-manager";
import { Tracing } from "@tento-core/tracing";
import { Typography } from "./ui/typography";

const MAX_POOL_SIZE = 64;

export const html = (s: TemplateStringsArray | string): HTMLTemplateElement => {
  const $template = document.createElement("template");
  $template.innerHTML = s.toString();
  return $template;
};

// https://stackoverflow.com/questions/34098023/typescript-self-referencing-return-type-for-static-methods-in-inheriting-classe
export interface LonaWebComponentClass<T extends LonaWebComponent = any> {
  componentName: string;
  new (): T;

  $styles: Style.Compat[];
  $icons: Option<string[]>;
  $iconsTemplate: Option<HTMLTemplateElement>;
  $html: Option<HTMLTemplateElement>;

  pool: Option<T[]>;
  lightDom: () => boolean;
  make: <Subclass extends typeof LonaWebComponent>() => InstanceType<Subclass>;
  recycle: (instance: T) => void;
  _recycle: (instance: T) => void;

  // todo: lifecycles?
  // onRecycle: (instance: T) => void;
}

const baseStyle = [Style.borderBoxStyle, Flexbox.style, Typography.style].join(
  " ",
);
const $baseStyle: Style.Compat = css(baseStyle);

export class LonaWebComponent extends HTMLElement {
  static componentName: string = "div";

  static $styles: Style.Compat[] = [];
  static $html: Option<HTMLTemplateElement>;
  static $icons: Option<string[]>;
  static $iconsTemplate: Option<HTMLTemplateElement>;
  static pool: Option<any[]>; // NOTE: the pool can't be initialized here otherwise everyone will share the same pool!!
  private pipStyleSheets: Option<HTMLStyleElement[]>;

  onSizeChangeTarget: Option<HTMLElement>;
  private __ro: Option<ResizeObserver>;
  initRo(): ResizeObserver {
    this.__ro ??= new ResizeObserver(([e]) =>
      this.onSizeChange?.({
        width: e.contentRect.width,
        height: e.contentRect.height,
      }),
    );
    if (this.isConnected) this.__ro.observe(this.onSizeChangeTarget ?? this);
    return this.__ro;
  }
  onSizeChange: Option<(s: Size) => void>;

  connectedCallback() {
    this.onSizeChange && this.initRo();
  }

  disconnectedCallback() {
    this.__ro?.disconnect();
  }

  constructor() {
    super();
    // @ts-ignore
    // biome-ignore lint/suspicious/noShadowRestrictedNames: <explanation>
    const constructor: LonaWebComponentClass = this.constructor;
    // @ts-ignore
    constructor.inflate(constructor, this);
  }

  static make<Subclass extends typeof LonaWebComponent>(
    this: Subclass,
  ): InstanceType<Subclass> {
    // Pop only from a pool this class OWNS. `static pool` is declared once, on
    // LonaWebComponent, and `_recycle` creates the own property on whichever
    // concrete class recycled — so a subclass that has never recycled resolves
    // `this.pool` up the prototype chain and drains its PARENT's pool.
    // `Section extends LandingSection` is exactly that shape, and both are
    // registered, so this used to hand back a `std-landing-section` cast to a
    // `Section`. Owning the pool also means nothing is popped and discarded.
    // biome-ignore lint/complexity/noThisInStatic: the called subclass owns its pool
    const reused = Object.hasOwn(this, "pool") ? this.pool?.pop() : undefined;
    if (reused != null) {
      return reused as InstanceType<Subclass>;
    }
    // `@component` refuses a duplicate name and is the only writer of
    // `componentName`, so this tag resolves to exactly this class. That is why
    // nothing is verified here — the bijection is established once, at
    // registration, instead of re-derived on every call.
    // biome-ignore lint/complexity/noThisInStatic: the called subclass owns its registered tag
    return document.createElement(this.componentName) as InstanceType<Subclass>;
  }

  static recycle<T extends LonaWebComponent>(
    this: LonaWebComponentClass<T>,
    instance: T,
  ) {
    // Timeline marks only when a recording asks for them (see
    // `DomUtils.timingMarksEnabled`): the entries are cleared as soon as they
    // are made, so they serve nothing else.
    if (DomUtils.timingMarksEnabled()) {
      performance.mark("[lona-web-component] recycle start");
      instance.parentElement?.removeChild(instance);
      performance.mark("[lona-web-component] recycle end");
      performance.measure(
        "[lona-web-component] recycle",
        "[lona-web-component] recycle start",
        "[lona-web-component] recycle end",
      );
      performance.clearMarks("[lona-web-component] recycle start");
      performance.clearMarks("[lona-web-component] recycle end");
      performance.clearMeasures("[lona-web-component] recycle");
    } else {
      instance.parentElement?.removeChild(instance);
    }
    // 1) Wait until the current layout pass is over
    // setTimeout(() => {
    //   if (typeof requestIdleCallback !=  "undefined") {
    //     requestIdleCallback(() => this._recycle(instance));
    //   } else {
    //     this._recycle(instance);
    //   }
    // });
    // biome-ignore lint/complexity/noThisInStatic: <explanation>
    $$.mutate(() => this._recycle(instance));
  }

  static _recycle<T extends LonaWebComponent>(instance: T) {
    if (instance.tagName === "STD-POPOVER") {
      Tracing.dev("RECYCLING POPOVER", instance);
    }
    instance.onRecycle();
    instance.style.cssText = "";
    const $children = [...instance.children];
    instance.innerHTML = "";
    instance.slot = "";
    while (instance.attributes.length > 0) {
      instance.removeAttribute(instance.attributes[0].name);
    }
    // biome-ignore lint/complexity/noThisInStatic: <explanation>
    if (!this.pool) {
      // biome-ignore lint/complexity/noThisInStatic: <explanation>
      this.pool = [instance];
      // biome-ignore lint/complexity/noThisInStatic: <explanation>
    } else if (this.pool.length < MAX_POOL_SIZE) {
      // biome-ignore lint/complexity/noThisInStatic: <explanation>
      this.pool.push(instance);
    }
    if ($children.length > 0) {
      $$.defer(() => {
        for (const $child of $children) {
          if ($child instanceof LonaWebComponent) {
            $child.recycle();
          }
        }
      });
    }
  }

  onRecycle() {}

  /**
   * Whether the next instance is built without a shadow root. The default is
   * a shadow root per instance. A class that answers `true` builds its own
   * children and styles them from the root it connects into (every shadow
   * root is a scope the style engine visits on each style
   * update). Asked once per construction: an instance keeps the mode it was
   * built in, so a pooled instance is reused in that mode.
   */
  static lightDom(): boolean {
    return false;
  }

  recycle() {
    // @ts-ignore
    // biome-ignore lint/suspicious/noShadowRestrictedNames: <explanation>
    const constructor: LonaWebComponentClass = this.constructor;
    constructor.recycle(this);
  }

  adoptedCallback() {
    const w = this.ownerDocument.defaultView;
    if (!w) return;
    if (!w["is-pip"]) return;
    if (!Style.canAdoptStylesheet()) return;
    // A light-DOM instance has no scope of its own to carry the sheets.
    if (this.shadowRoot == null) return;
    if (this.pipStyleSheets == null) {
      // @ts-ignore
      // biome-ignore lint/suspicious/noShadowRestrictedNames: <explanation>
      const constructor: LonaWebComponentClass = this.constructor;
      this.pipStyleSheets = [$baseStyle, ...constructor.$styles].map(
        Style.makeWith,
      );
    }

    for (const $sheet of this.pipStyleSheets) {
      this.shadowRoot!.appendChild($sheet);
    }
  }

  private static inflate<T extends LonaWebComponent>(
    clazz: LonaWebComponentClass<T>,
    instance: T,
  ) {
    if (clazz.lightDom()) return;
    const shadowRoot = instance.attachShadow({ mode: "open" });

    for (const style of [$baseStyle, ...clazz.$styles]) {
      instance.adoptStyle(style);
    }

    if (clazz.$icons) {
      if (clazz.$iconsTemplate == null) {
        const icons = html(DomUtils.importSvgs(clazz.$icons));
        clazz.$iconsTemplate = icons;
        shadowRoot.appendChild(icons.content.cloneNode(true));
      } else {
        shadowRoot.appendChild(clazz.$iconsTemplate.content.cloneNode(true));
      }
    }

    clazz.$html && shadowRoot.appendChild(clazz.$html.content.cloneNode(true));
  }

  private adoptStyle(style: Style.Compat) {
    if (style instanceof CSSStyleSheet) {
      this.shadowRoot!.adoptedStyleSheets.push(style);
    } else {
      this.shadowRoot!.appendChild(style.cloneNode(true));
    }
  }

  private customStyles: Option<Map<string, Style.Compat>>;
  private removeStyles: Option<Map<string, () => void>>;

  addStyle(id: string, style: Style.Compat) {
    if (!this.customStyles) {
      this.customStyles = new Map();
    }
    const prev = this.customStyles.get(id);
    if (prev === style) return;
    this.customStyles.set(id, style);

    if (!this.removeStyles) {
      this.removeStyles = new Map();
    }
    this.removeStyles.get(id)?.();

    if (style instanceof CSSStyleSheet) {
      this.shadowRoot!.adoptedStyleSheets.push(style);
      this.removeStyles.set(id, () => {
        this.shadowRoot!.adoptedStyleSheets =
          this.shadowRoot!.adoptedStyleSheets.filter((s) => s !== style);
      });
    } else {
      const node = style.cloneNode(true);
      this.shadowRoot!.appendChild(node);
      this.removeStyles.set(id, () => {
        node.parentElement?.removeChild(node);
      });
    }
  }

  removeStyle(id: string) {
    this.removeStyles?.get(id)?.();
    this.removeStyles?.delete(id);
    this.customStyles?.delete(id);
  }

  listStyles(): string[] {
    if (!this.removeStyles) return [];
    return [...this.removeStyles.keys()];
  }

  removeAllStyles() {
    if (!this.removeStyles) return;
    for (const fn of this.removeStyles.values()) {
      fn();
    }
    this.removeStyles.clear();
  }

  $<T extends HTMLElement = HTMLElement>(s: string): T {
    return $<T>(s, this.shadowRoot!);
  }
  $_maybe<T extends HTMLElement = HTMLElement>(s: string): Option<T> {
    return $_maybe<T>(s, this.shadowRoot!);
  }
  $qs<T extends HTMLElement = HTMLElement>(s: string): T {
    return $qs<T>(s, this.shadowRoot!);
  }
  $qs_maybe<T extends HTMLElement = HTMLElement>(s: string): Option<T> {
    return $qs_maybe<T>(s, this.shadowRoot!);
  }
  $qsa<T extends HTMLElement = HTMLElement>(s: string): NodeListOf<T> {
    return $qsa<T>(s, this.shadowRoot!);
  }
  hydrate<T extends HTMLElement | SVGElement = HTMLElement>(id: string): T {
    const $e = this.$(id);
    customElements.upgrade($e);
    return $e as T;
  }

  addPointerEvent<T extends LonaWebComponent>(
    config: GestureManager.PointerEvents,
  ): T {
    GESTURE_MANAGER.addPointerEvent(this, config);
    return this as unknown as T;
  }

  assignAttributes<T extends LonaWebComponent>(attributes: {
    [k: string]: string;
  }): T {
    return DomUtils.assignAttributes(this, attributes) as unknown as T;
  }

  clearChildren(recycle: boolean = true) {
    DomUtils.clearChildren(this, recycle);
  }
}

export namespace LonaWebComponent {
  export function asFactory<C extends LonaWebComponentClass>(
    t: C,
  ): Factory<InstanceType<C>> {
    return t.make.bind(t) as Factory<InstanceType<C>>;
  }
}
