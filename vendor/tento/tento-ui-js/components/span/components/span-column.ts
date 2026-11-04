import { html, LonaWebComponent } from "@tento-ui/component";
import { component } from "@tento-ui/component-decorators";
import { css, Style } from "@tento-ui/component-styles";

function _$breakpoints(
  target: string,
  breakpoints: number[],
  maxPctOfParent: number,
): string {
  const mult = 1 / maxPctOfParent;
  breakpoints.sort((a, b) => a - b);
  const lines: string[] = [];
  lines.push("\n");
  lines.push(target);
  lines.push("{");
  lines.push(`  flex: 0 0 ${breakpoints[0]}px`);
  lines.push("}");
  for (const [idx, breakpoint] of breakpoints.entries()) {
    if (idx === 0) continue;
    const nbreakpoint =
      idx + 1 < breakpoints.length ? breakpoints[idx + 1] : null;
    const next = nbreakpoint
      ? ` and (max-width: ${nbreakpoint * mult - 0.001}px)`
      : "";

    lines.push(`@container (min-width: ${breakpoint * mult}px)${next} {`);
    lines.push(target);
    lines.push("  {");
    lines.push(`    flex-basis: ${breakpoint}px`);
    lines.push("  }");
    lines.push("}");
  }
  return lines.join("\n");
}

// One shared sheet per distinct breakpoint layout: a fresh css() per bind
// defeated addStyle's identity dedupe, so every rebind re-adopted a new
// stylesheet into a connected root — a whole-shadow-tree style recalc per
// column per pass. Lane fractions repeat heavily, so the map stays small.
const BREAKPOINT_SHEETS = new Map<string, Style.Compat>();

@component({
  name: "std-span-column",
})
export class SpanColumn extends LonaWebComponent {
  bind(breakpoints: number[]) {
    const text = _$breakpoints(":host([is-sharing])", breakpoints, 0.5);
    let sheet = BREAKPOINT_SHEETS.get(text);
    if (!sheet) {
      sheet = css(text);
      BREAKPOINT_SHEETS.set(text, sheet);
    }
    this.addStyle("sharing-breakpoints", sheet);
  }

  onRecycle(): void {
    this.removeAllStyles();
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        position: relative;
        height: 100%;
        width: 100%;
      }

      :host(:not([sharing])) {
        margin-right: 4px;
      }
    `,
  ];
  static $html: Option<HTMLTemplateElement> = html`<slot></slot>`;
}

export namespace SpanColumn {
  export const $breakpoints = _$breakpoints;
  export const $inThePast = css`
    :host {
      position: relative;
      display: block;
      height: calc(100% - 4px);
      border-radius: 6px;

      --ε: 1e-6;
      --started: clamp(0, calc((var(--current-time-mse) - var(--start)) / var(--ε)), 1);
      --ended:   clamp(0, calc((var(--current-time-mse) - var(--end)) / var(--ε)), 1);

      --in-the-past:    calc(var(--started) * var(--ended));
      --in-the-present: clamp(0, calc(var(--started) - var(--in-the-past)), 1);

      --revealed-opacity: calc(1 - var(--in-the-past) * .5); /* 0.5 only when past   */
      opacity: var(--revealed-opacity);
      transition: opacity 0.15s ease;
    }

    :host([show-on-hover]:hover) {
      opacity: var(--revealed-opacity);
    }
  `;
}
