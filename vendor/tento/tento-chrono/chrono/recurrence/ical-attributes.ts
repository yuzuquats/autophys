import type { Option } from "../option.ts";

export class ICalAttributes {
  constructor(
    private readonly inner: Map<string, Option<string>>,
    readonly order: string[],
  ) {}

  get(key: string): Option<string> {
    return this.inner.get(key.toUpperCase());
  }

  static fromRawAttributes(attributeLines: string[]): ICalAttributes {
    const attributeOrder: string[] = [];
    const attributes: Map<string, Option<string>> = new Map();
    for (const rule of attributeLines) {
      const [key, value] = rule.split("=");
      attributes.set(key.toUpperCase(), value);
      attributeOrder.push(key.toUpperCase());
    }
    return new ICalAttributes(attributes, attributeOrder);
  }
}
