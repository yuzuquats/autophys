/**
 * Type-level half of `component-styles.deno.test.ts`: the
 * `css` tag refuses an interpolation. The tag builds its sheet from the
 * template's literal strings, so a `${}` value that compiled would vanish at
 * runtime (a silent paint bug); its single parameter makes tsc refuse one
 * (TS2554). The `@ts-expect-error` line must not compile; an unused
 * `@ts-expect-error` fails the check, so a tag that loosens (a rest parameter
 * of any type but `never`) is caught. The other lines are the supported forms
 * and must compile.
 */

import { css } from "./component-styles.ts";

const hourPx = 48;

// @ts-expect-error — an interpolated value would be dropped from the sheet
css`a { height: ${hourPx}px; }`;

css`a { height: 48px; }`;
css(`a { height: ${hourPx}px; }`);
