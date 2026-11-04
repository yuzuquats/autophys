import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css } from "../../component-styles";
import { Squircle } from "../squircle/squircle";

/** One status indicator, used wherever state is shown — a rail row, a detail
 * header, a list cell.
 *
 * Shape identifies the thing: the default squircle marks a terminal/session,
 * while callers can request a hexagon for task work.
 *
 * The grammar keeps three independent axes — **shape is object, state is
 * colour, fill is hierarchy**:
 *
 *   solid    the thing itself is in this state (a session, a leaf row)
 *   outline  a container, whose state summarises what it holds
 *
 * Size is set by the caller through two custom properties, so a dense rail
 * and a roomy header share one component without either dictating the
 * other's metrics:
 *
 *   --status-mark-box     the hit/spacing box   (default 20px)
 *   --status-mark-glyph   the drawn squircle    (default 8px)
 *
 * The box exists so the mark can carry its own optical padding rather than
 * making every caller remember a margin. */
@component({ name: "std-status-mark" })
export class StatusMark extends LonaWebComponent {
  private $glyph: HTMLElement = this.$("glyph");
  private $squircle: Option<Squircle> = null;

  static makeWith(props: StatusMark.Props): StatusMark {
    return (StatusMark.make() as StatusMark).bind(props);
  }

  bind(props: StatusMark.Props): this {
    this.setAttribute("role", "img");
    this.setAttribute("aria-label", props.label);
    this.dataset.state = props.state;
    this.dataset.variant = props.variant;
    this.dataset.shape = props.shape ?? "squircle";

    const color = StatusMark.color(props.state);
    if (props.shape === "hexagon") {
      this.$squircle = null;
      const $svg = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      $svg.setAttribute("viewBox", "0 0 16 16");
      $svg.setAttribute("aria-hidden", "true");
      const $hexagon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "polygon",
      );
      $hexagon.setAttribute(
        "points",
        "8,0.75 14.28,4.38 14.28,11.62 8,15.25 1.72,11.62 1.72,4.38",
      );
      $hexagon.setAttribute("stroke-linejoin", "round");
      $hexagon.setAttribute("vector-effect", "non-scaling-stroke");
      if (props.variant === "solid") {
        $hexagon.setAttribute("fill", color);
      } else {
        $hexagon.setAttribute("fill", "none");
        $hexagon.setAttribute("stroke", color);
        $hexagon.setAttribute("stroke-width", String(StatusMark.STROKE));
      }
      $svg.append($hexagon);
      this.$glyph.replaceChildren($svg);
      return this;
    }

    const $squircle = Squircle.make() as Squircle;
    // The squircle paints its own path, so the tone is passed as a value
    // rather than inherited — currentColor would not reach the SVG fill.
    $squircle.bind(
      props.variant === "solid"
        ? {
          radius: StatusMark.RADIUS,
          fill: color,
        }
        : {
          radius: StatusMark.RADIUS,
          fill: "none",
          stroke: color,
          strokeWidth: StatusMark.STROKE,
        },
    );
    this.$squircle = $squircle;
    this.$glyph.replaceChildren($squircle);
    return this;
  }

  onRecycle(): void {
    super.onRecycle();
    this.$squircle = null;
    this.$glyph.replaceChildren();
  }

  /** Corner radius, in CSS px — deliberately larger than any glyph we draw.
   *
   * `SquircleMath.genSvg` clamps the radius to half the shorter side, so this
   * resolves to "as round as the shape goes" at every size. A literal px
   * radius could not: 2.6px was a third of the 8px rail glyph but a fifth of
   * the 12px content glyph, so the same mark read rounder in the rail than in
   * the header — one shape drawn two ways. Roundness is now scale-invariant,
   * and the shared continuous curve keeps it a squircle rather than a dot. */
  private static readonly RADIUS = 64;
  private static readonly STROKE = 1.35;

  static $styles = [
    css`
      :host {
        display: grid;
        place-items: center;
        flex: none;
        box-sizing: border-box;
        width: var(--status-mark-box, 20px);
        height: var(--status-mark-box, 20px);
      }
      #glyph {
        display: block;
        width: var(--status-mark-glyph, 8px);
        height: var(--status-mark-glyph, 8px);
      }
      #glyph std-squircle {
        display: block;
        width: 100%;
        height: 100%;
      }
      #glyph svg {
        display: block;
        width: 100%;
        height: 100%;
        overflow: visible;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <div id="glyph"></div>
  `;
}

export namespace StatusMark {
  export type State = "progress" | "done" | "error";
  export type Variant = "solid" | "outline";
  export type Shape = "squircle" | "hexagon";

  export interface Props {
    state: State;
    variant: Variant;
    /** Defaults to the rounded session/leaf mark. */
    shape?: Shape;
    /** Accessible name for the visual state marker. */
    label: string;
  }

  export function color(state: State): string {
    switch (state) {
      case "progress":
        return "var(--yellow, #fbd75b)";
      case "done":
        return "var(--green, #51b748)";
      case "error":
        return "var(--red, #fe887c)";
    }
  }
}
