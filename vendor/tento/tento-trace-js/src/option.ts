/**
 * `Option<T>` is normally an ambient global from tento-core-js/types or
 * tento-ui-js/types. This package is deliberately dependency-free, so it
 * declares its own rather than requiring every consuming tsconfig to supply
 * one - and where a consumer loads lib.dom without those types, the DOM's own
 * `Option` constructor shadows the type and every use fails with TS2749.
 */
export type Option<T> = T | null | undefined;
