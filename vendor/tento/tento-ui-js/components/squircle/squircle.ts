import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { $$ } from "../../fastdom";
import { MathUtils } from "@tento-core/math";
import { SquircleMath } from "./squircle-math";

@component({
  name: "std-squircle",
})
export class Squircle extends LonaWebComponent {
  static get observedAttributes() {
    return ["no-transition", "content-sized"];
  }

  private $svg: SVGSVGElement = this.hydrate("svg");
  private $path: SVGPathElement = this.hydrate("path");
  private $clipped: Option<HTMLElement>;
  private $comb: Option<SVGGElement>;
  private $points: Option<SVGGElement>;

  private props: Option<Squircle.ResolvedProps>;
  private clippedActive = false;
  private curvatureActive = false;

  private startRadius: Option<number>;
  private currentRadius: Option<number>;

  private startSideCurvature: Option<number>;
  private currentSideCurvature: Option<number>;

  private startSize: Option<Size>;
  private currentSize: Option<Size>;
  private targetSize: Option<Size>;

  private isAnimating: boolean = false;
  private animationStart: Option<number>;
  private get noTransition(): boolean {
    return this.hasAttribute("no-transition");
  }

  private animationDurationMs: number = 150;

  private ro: ResizeObserver = new ResizeObserver(([entry]) => {
    if (this.isAnimating) {
      this.startSize = this.currentSize;
      this.targetSize = {
        height: entry.contentRect.height,
        width: entry.contentRect.width,
      };
      this.animationStart = null;
    } else {
      this.targetSize = {
        height: entry.contentRect.height,
        width: entry.contentRect.width,
      };
      $$.mutate(() => {
        this.onInvalidate();
      });
    }
  });

  static makeWith(props: Squircle.Props): Squircle {
    const $s = Squircle.make();
    $s.bind(props);
    return $s;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.hasClippedChildren()) this.ensureClipped();
    this.ro.observe(this);
  }

  disconnectedCallback(): void {
    this.ro.disconnect();
    super.disconnectedCallback();
  }

  onRecycle(): void {
    super.onRecycle();
    this.ro.disconnect();
    this.removeClipped();
    this.removeCurvatureGroups();
    this.props = null;
    this.startRadius = null;
    this.currentRadius = null;
    this.startSideCurvature = null;
    this.currentSideCurvature = null;
    this.startSize = null;
    this.currentSize = null;
    this.targetSize = null;
    this.isAnimating = false;
    this.animationStart = null;
    this.animationDurationMs = 150;
    this.style.removeProperty("opacity");
    this.$svg.style.width = "";
    this.$svg.style.height = "";
    this.$svg.setAttribute("viewBox", "-1 -1 2 2");
    this.$path.removeAttribute("d");
    this.$path.setAttribute("fill", "var(--blue)");
    this.$path.setAttribute("stroke", "none");
    this.$path.removeAttribute("stroke-width");
    this.$path.removeAttribute("vector-effect");
  }

  attributeChangedCallback(name: string): void {
    if (name === "no-transition" || name === "content-sized") {
      $$.mutate(() => this.onInvalidate());
    }
  }

  bind(props: Squircle.Props): this {
    const targetRadius = props.radius ?? 50;
    const targetSideCurvature = props.sideCurvature ??
      SquircleMath.DEFAULT_SIDE_CURVATURE;
    SquircleMath.circleParams(targetSideCurvature);

    const fill = props.fill ?? "var(--blue)";
    const stroke = props.stroke ?? null;
    const strokeWidth = props.strokeWidth ?? 1;
    this.props = {
      radius: targetRadius,
      sideCurvature: targetSideCurvature,
      fill,
      stroke,
      strokeWidth,
      showCurvature: props.showCurvature ?? false,
    };
    // Diff before writing: identical setAttribute calls still schedule style
    // invalidation on the SVG path, and recycled hosts rebind with unchanged
    // paint props far more often than they change.
    if (this.$path.getAttribute("fill") !== fill) {
      this.$path.setAttribute("fill", fill);
    }
    if (stroke != null) {
      // non-scaling-stroke keeps the width in literal screen px, independent
      // of the normalized viewBox scale.
      if (this.$path.getAttribute("stroke") !== stroke) {
        this.$path.setAttribute("stroke", stroke);
      }
      if (this.$path.getAttribute("stroke-width") !== `${strokeWidth}`) {
        this.$path.setAttribute("stroke-width", `${strokeWidth}`);
      }
      if (this.$path.getAttribute("vector-effect") !== "non-scaling-stroke") {
        this.$path.setAttribute("vector-effect", "non-scaling-stroke");
      }
    } else {
      if (this.$path.getAttribute("stroke") !== "none") {
        this.$path.setAttribute("stroke", "none");
      }
      this.$path.removeAttribute("stroke-width");
      this.$path.removeAttribute("vector-effect");
    }
    this.animationDurationMs = props.animationDurationMs ?? 150;

    $$.mutate(() => {
      this.onInvalidate();
    });
    return this;
  }

  private onInvalidate(): boolean {
    // Before any of the size gates below. Whether the clipped box EXISTS is a
    // structural question — did the caller slot anything into "clipped" — and
    // it has to be answered without a measurement, because for a content-sized
    // panel the measurement depends on the answer. The box is what the slot
    // lives in, so until it exists the content is not laid out, the host
    // measures zero high, and render() turns around at its own zero-size gate:
    // a panel that never draws, with the right width and the right text in it.
    // Sizing that box, and the clip path cut into it, still needs a size and
    // still happens in render().
    this.syncClipped();

    if (this.targetSize == null) {
      this.style.opacity = "0";
      return false;
    }

    if (this.props == null) {
      this.style.opacity = "0";
      return false;
    }

    const targetSize = this.targetSize;
    const props = this.props;

    this.style.removeProperty("opacity");
    if (this.currentSize == null) {
      const size = {
        width: targetSize.width,
        height: targetSize.height,
      };
      this.render(size, props.radius, props.sideCurvature);
      return true;
    }

    if (
      this.currentSize.width === targetSize.width &&
      this.currentSize.height === targetSize.height &&
      this.currentSideCurvature === props.sideCurvature &&
      this.currentRadius === props.radius &&
      this.clippedActive === this.hasClippedChildren() &&
      this.curvatureActive === props.showCurvature
    ) {
      return false;
    }

    // If no-transition is set, render immediately without animation
    if (this.noTransition) {
      this.isAnimating = false;
      this.animationStart = null;
      this.render(targetSize, props.radius, props.sideCurvature);
      return true;
    }

    this.startSize = this.currentSize;
    this.startRadius = this.currentRadius;
    this.startSideCurvature = this.currentSideCurvature;

    if (this.isAnimating) {
      this.animationStart = null;
      return false;
    }

    const animationDurationMs = this.animationDurationMs;

    this.isAnimating = true;
    const animate = (timestamp: number) => {
      if (!this.isAnimating) return;

      const startSize = this.startSize;
      const activeTargetSize = this.targetSize;
      const startRadius = this.startRadius;
      const startSideCurvature = this.startSideCurvature;
      const activeProps = this.props;
      if (
        startSize == null ||
        activeTargetSize == null ||
        startRadius == null ||
        startSideCurvature == null ||
        activeProps == null
      ) {
        this.isAnimating = false;
        this.animationStart = null;
        return;
      }

      this.animationStart = this.animationStart ?? timestamp;

      const elapsed = timestamp - this.animationStart;
      const progress = MathUtils.clampInc(elapsed / animationDurationMs, 0, 1);
      const interSize = {
        width: startSize.width +
          (activeTargetSize.width - startSize.width) * progress,
        height: startSize.height +
          (activeTargetSize.height - startSize.height) * progress,
      };
      const radius = startRadius +
        (activeProps.radius - startRadius) * progress;
      const sideCurvature = startSideCurvature +
        (activeProps.sideCurvature - startSideCurvature) * progress;

      this.render(interSize, radius, sideCurvature);

      if (progress >= 1) {
        this.isAnimating = false;
        this.animationStart = null;
        return;
      }
      requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);
    return false;
  }

  private render(size: Size, radius: number, sideCurvature: number): boolean {
    if (size.height == null) return false;
    if (size.height <= 0 || size.width <= 0) return false;
    const hasClippedChildren = this.hasClippedChildren();
    const showCurvature = this.props?.showCurvature === true;
    const currentSize = this.currentSize;
    if (
      currentSize != null &&
      size.height === currentSize.height &&
      size.width === currentSize.width &&
      sideCurvature === this.currentSideCurvature &&
      radius === this.currentRadius &&
      this.clippedActive === hasClippedChildren &&
      this.curvatureActive === showCurvature
    ) {
      return false;
    }

    this.currentSize = size;
    this.currentRadius = radius;
    this.currentSideCurvature = sideCurvature;

    this.$svg.style.width = size.width + "px";
    this.$svg.style.height = size.height + "px";

    const { viewBox, pathData, corners } = SquircleMath.genSvg(
      size,
      radius,
      sideCurvature,
    );

    this.$svg.setAttribute("viewBox", viewBox);
    this.$path.setAttribute("d", pathData);

    if (hasClippedChildren) {
      const $clipped = this.ensureClipped();
      if (this.hasAttribute("content-sized")) {
        // The box IS the content; pinning it to the measured size would freeze
        // the first measurement and stop it ever growing again.
        $clipped.style.width = "";
        $clipped.style.height = "";
      } else {
        $clipped.style.width = size.width + "px";
        $clipped.style.height = size.height + "px";
      }
      const pixelPathData = SquircleMath.genPixelPath(
        size,
        radius,
        sideCurvature,
      );
      $clipped.style.clipPath = `path('${pixelPathData}')`;
    } else {
      this.removeClipped();
    }
    this.clippedActive = hasClippedChildren;

    if (showCurvature) {
      this.clearCurvature();
      if (radius > 0) this.renderCurvature(corners);
    } else {
      this.removeCurvatureGroups();
    }
    this.curvatureActive = showCurvature;
    return true;
  }

  private hasClippedChildren(): boolean {
    return this.querySelector('[slot="clipped"]') != null;
  }

  /** The clipped box's existence, kept in step with the caller's children and
   *  nothing else. Idempotent, and cheap enough to run on every invalidation. */
  private syncClipped(): void {
    if (this.hasClippedChildren()) this.ensureClipped();
    else this.removeClipped();
  }

  private ensureClipped(): HTMLElement {
    if (this.$clipped != null) return this.$clipped;

    const $clipped = document.createElement("div");
    $clipped.id = "clipped";

    const $slot = document.createElement("slot");
    $slot.name = "clipped";
    $clipped.appendChild($slot);
    this.shadowRoot?.appendChild($clipped);
    this.$clipped = $clipped;
    return $clipped;
  }

  private removeClipped(): void {
    this.$clipped?.remove();
    this.$clipped = null;
    this.clippedActive = false;
  }

  private ensureCurvatureGroups(): Squircle.CurvatureGroups {
    if (this.$comb != null && this.$points != null) {
      return { $comb: this.$comb, $points: this.$points };
    }

    const namespace = "http://www.w3.org/2000/svg";
    const $comb = document.createElementNS(namespace, "g");
    $comb.id = "comb";
    const $points = document.createElementNS(namespace, "g");
    $points.id = "points";
    this.$svg.append($comb, $points);
    this.$comb = $comb;
    this.$points = $points;
    return { $comb, $points };
  }

  private removeCurvatureGroups(): void {
    this.$comb?.remove();
    this.$points?.remove();
    this.$comb = null;
    this.$points = null;
    this.curvatureActive = false;
  }

  private clearCurvature(): void {
    this.$points?.replaceChildren();
    this.$comb?.replaceChildren();
  }

  private renderCurvature(
    corners: SquircleMath.Point[][][],
  ): void {
    if (!this.props?.showCurvature) return;

    const { $comb, $points } = this.ensureCurvatureGroups();

    for (const [cornerIdx, corner] of corners.entries()) {
      const allPoints = corner.flat();
      let rgb = "0,0,255";
      switch (cornerIdx) {
        case 0:
          // TOP_LEFT
          break;
        case 1:
          // TOP_RIGHT
          rgb = "0,255,0";
          break;
        case 2:
          // BOTTOM_RIGHT
          rgb = "255,0,0";
          break;
        case 3:
          // BOTTOM_LEFT
          rgb = "128,128,0";
          break;
      }

      for (const [idx, point] of allPoints.entries()) {
        const pointEl = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        const opacity = `${MathUtils.lerp(0.2, 1, idx / allPoints.length)}`;

        pointEl.setAttribute("fill", `rgb(${rgb},${opacity})`);
        pointEl.setAttribute("cx", point[0].toString());
        pointEl.setAttribute("cy", point[1].toString());
        pointEl.setAttribute("r", "0.02");

        $points.appendChild(pointEl);
      }
    }

    for (const corner of corners) {
      const curves = corner.slice(1).map((arc, i) => [
        i === 0 ? corner[0][0] : corner[i][2],
        ...arc,
      ]);
      for (const curve of curves) {
        for (let t = 0; t <= 1; t += 0.01) {
          const [_, n] = SquircleMath.bezierCurve(t, ...curve);
          const p = SquircleMath.bezierPos(t, ...curve);

          const whisker = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "line",
          );
          whisker.setAttribute("stroke", "rgb(255,0,0)");
          whisker.setAttribute("stroke-width", "0.003");
          whisker.setAttribute("x1", p[0].toString());
          whisker.setAttribute("y1", p[1].toString());
          whisker.setAttribute("x2", (p[0] + n[0]).toString());
          whisker.setAttribute("y2", (p[1] + n[1]).toString());
          $comb.appendChild(whisker);
        }
      }
    }
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        position: relative;
        display: block;
        width: 200px;
        height: 200px;
      }

      svg {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        overflow: visible;
        display: block;
      }

      #clipped {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }

      /* Opt-in: the clipped content DRIVES the size instead of being fitted to
        it. The default above is the right one for a squircle whose box is
        known — a search palette, a drawer — where absolutely positioning the
        content is what lets the SVG and the content share one box without
        either measuring the other. It cannot serve a panel whose height comes
        from its own text, because the content is out of flow and the host
        falls back to the 200x200 default: an error block with two lines in it
        would render 200px tall.

        In flow, the host's box is the content's box, and the ResizeObserver
        that already watches the host feeds the SVG. Nothing else changes. */
      :host([content-sized]) {
        width: auto;
        height: auto;
      }

      :host([content-sized]) #clipped {
        position: relative;
        top: auto;
        left: auto;
        transform: none;
        width: 100%;
        /* The clipped box is the caller's layout context now, so it carries the
          caller's flex. These properties are NOT inherited by default, hence
          the explicit inherit keyword — each one reads the value off this
          element's
          host, which is the panel the caller configured. */
        display: flex;
        flex-direction: inherit;
        align-items: inherit;
        justify-content: inherit;
        gap: inherit;
        /* Resolves BOTH ways, which is the point: against a host with a
          definite height (a panel the caller sized) it fills; against an auto
          host it computes to auto and the content drives it. Without it, a
          panel whose children are all position:absolute has nothing in flow,
          collapses to zero, and the squircle skips rendering entirely. */
        height: 100%;
      }

      :host([transform-top-left]) svg,
      :host([transform-top-left]) #clipped {
        top: 0px;
        left: 0px;
        transform: translate(0px, 0px);
      }
    `,
  ];

  static $html = html`
    <svg id="svg" viewBox="-1 -1 2 2">
      <path id="path" fill="var(--blue)" stroke="none" />
    </svg>
  `;
}

export namespace Squircle {
  export type ResolvedProps = {
    radius: number;
    sideCurvature: number;
    fill: string;
    stroke: Option<string>;
    strokeWidth: number;
    showCurvature: boolean;
  };

  export type CurvatureGroups = {
    $comb: SVGGElement;
    $points: SVGGElement;
  };

  export type Props = Optional<{
    radius: number;
    sideCurvature: number;
    fill: string;
    // Stroke on the squircle path itself (pass fill: "none" for a pure
    // outline). strokeWidth is in CSS px (vector-effect: non-scaling-stroke).
    stroke: string;
    strokeWidth: number;
    showCurvature: boolean;
    animate: boolean;
    animationDurationMs: number;
  }>;
}
