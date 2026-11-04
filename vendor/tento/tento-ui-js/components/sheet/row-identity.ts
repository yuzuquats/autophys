declare const __rowIdentityBrand: unique symbol;

/** Branded string type for row identifiers in the sheet layout layer. */
export type RowIdentity = string & { readonly [__rowIdentityBrand]: true };

/** Cast a string to RowIdentity. Use at domain boundaries (e.g., `rowIdentity(rowId.toString())`). */
export function rowIdentity(s: string): RowIdentity {
  return s as RowIdentity;
}
