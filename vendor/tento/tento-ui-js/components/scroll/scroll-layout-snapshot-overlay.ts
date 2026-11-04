import { html, LonaWebComponent } from "../../component";
import { component } from "../../component-decorators";
import { css, Style } from "../../component-styles";
import { DomUtils } from "../../dom";
import { CartesianCoordinate } from "./cartesian-coordinate";
import { PopoverInfo } from "./popover-info";
import { ScrollLayoutSnapshot } from "./scroll-layout-snapshot";

function getSpaceColor(space: number): string {
  if (space > 100) return "var(--green)";
  if (space > 50) return "var(--orange)";
  return "var(--red)";
}

@component({
  name: "std-scroll-layout-snapshot-overlay",
})
export class ScrollLayoutSnapshotOverlay extends LonaWebComponent {
  private $cc: CartesianCoordinate = this.hydrate("cc");

  onSizeChange: Option<(s: Size) => void> = (s) => {
    this.$cc.onSizeChange?.(s);
  };

  bind(props: ScrollLayoutSnapshotOverlay.Props): this {
    const { viewportInfo, point } = props;

    DomUtils.clearChildren(this.$cc);
    this.$cc.bind({ showAxes: false });
    this.$("viewport-label").textContent =
      `Viewport: ${Math.round(viewportInfo.width)}×${Math.round(viewportInfo.height)}`;
    this.renderPoint(viewportInfo, point);

    return this;
  }

  renderPoint(
    viewportInfo: ScrollLayoutSnapshot.ViewportInfo,
    point: PopoverInfo.SpaceRemaining,
  ) {
    const halfW = viewportInfo.width / 2;
    const halfH = viewportInfo.height / 2;

    // Convert screen coordinates to cartesian coordinates
    // Screen: origin top-left, Y down
    // Cartesian: origin center, Y up
    const cartX = point.x - viewportInfo.x - halfW;
    const cartY = halfH - (point.y - viewportInfo.y);

    const { spaceRemaining } = point;

    // Create 4 segments for each direction
    const directions = [
      {
        vec: [0, spaceRemaining.top] as [number, number],
        space: spaceRemaining.top,
      },
      {
        vec: [spaceRemaining.right, 0] as [number, number],
        space: spaceRemaining.right,
      },
      {
        vec: [0, -spaceRemaining.bottom] as [number, number],
        space: spaceRemaining.bottom,
      },
      {
        vec: [-spaceRemaining.left, 0] as [number, number],
        space: spaceRemaining.left,
      },
    ];

    for (const { vec, space } of directions) {
      if (space <= 0) continue;

      const $segment = CartesianCoordinate.Segment.make();
      $segment.bind({
        ...CartesianCoordinate.Segment.Props.fromPV(
          { x: cartX, y: cartY },
          vec,
        ),
        options: {
          endArrow: true,
          label: `${Math.round(space)}px`,
          showTooltip: false,
        },
      });
      $segment.assignStyles({ "--line-color": getSpaceColor(space) });
      this.$cc.appendChild($segment);
    }

    // Add point marker
    const $point = CartesianCoordinate.CCPoint.make();
    $point.bind({
      point: { x: cartX, y: cartY },
      label: "popover",
    });
    $point.assignStyles({
      zIndex: "4",
      "--point-color": "#2196F3",
    });
    this.$cc.appendChild($point);
  }

  static $styles: Style.Compat[] = [
    css`
      :host {
        display: block;
        position: relative;
      }

      :host::before {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background: var(--overlay-bg);
        opacity: var(--overlay-bg-opacity);
      }

      #cc {
        width: 100%;
        height: 100%;
        border-radius: var(--border-radius);
        --cc-line-width: 2px;
      }

      #viewport-label {
        position: absolute;
        top: 8px;
        left: 8px;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
        z-index: 100;
        pointer-events: none;
      }
    `,
  ];

  static $html: Option<HTMLTemplateElement> = html`
    <std-cc id="cc"></std-cc>
    <div id="viewport-label"></div>
  `;
}

export namespace ScrollLayoutSnapshotOverlay {
  export interface Props {
    viewportInfo: ScrollLayoutSnapshot.ViewportInfo;
    point: PopoverInfo.SpaceRemaining;
  }
}
