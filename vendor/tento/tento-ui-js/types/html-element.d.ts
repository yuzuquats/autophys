interface CSSCustomProperties {
  [key: `--${string}`]: Option<string>;
}

interface CSSStyleWithVariables
  extends Partial<CSSStyleDeclaration>,
    CSSCustomProperties {}

interface HTMLElement {
  assignStyles<T extends HTMLElement>(
    this: T,
    styles: CSSStyleWithVariables,
  ): T;
}
