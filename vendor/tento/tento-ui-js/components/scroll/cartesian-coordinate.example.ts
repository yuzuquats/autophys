import { Storybook } from "../../ui/storybook";
import { CartesianCoordinate } from "./cartesian-coordinate";

export class CartesianCoordinateStoryBook extends Storybook.Default {
  title(): string {
    return "Cartesian Coordinate";
  }

  tags(): string[] {
    return ["std-cc", "std-cc-axis", "std-cc-line", "std-cc-point", "std-cc-segment"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Cartesian Coordinate",
        render: () => {
          return CartesianCoordinate.make()
            .bind({
              showAxes: true,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });
        },
      },
      {
        title: "y = x line",
        render: () => {
          const $cc = CartesianCoordinate.make()
            .bind({
              showAxes: true,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });

          const $line = CartesianCoordinate.Line.make();
          $line.bind({ m: 1, b: 0 });
          $cc.appendChild($line);

          return $cc;
        },
      },
      {
        title: "Multiple lines",
        render: () => {
          const $cc = CartesianCoordinate.make()
            .bind({
              showAxes: true,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });

          const lines = [
            { m: 1, b: 0, color: "var(--blue)" },
            { m: -1, b: 0, color: "var(--red)" },
            { m: 0.5, b: 50, color: "var(--green)" },
            { m: -2, b: -100, color: "var(--orange)" },
          ];

          for (const { m, b, color } of lines) {
            const $line = CartesianCoordinate.Line.make();
            $line.bind({ m, b });
            $line.assignStyles({ "--line-color": color });
            $cc.appendChild($line);
          }

          return $cc;
        },
      },
      {
        title: "Line segments",
        render: () => {
          const $cc = CartesianCoordinate.make()
            .bind({
              showAxes: true,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });

          const segments = [
            { start: { x: -100, y: 0 }, end: { x: 100, y: 0 }, color: "var(--blue)" },
            { start: { x: 0, y: -100 }, end: { x: 0, y: 100 }, color: "var(--red)" },
            { start: { x: -150, y: -150 }, end: { x: 150, y: 150 }, color: "var(--green)" },
            { start: { x: -200, y: 100 }, end: { x: 200, y: -100 }, color: "var(--orange)" },
          ];

          for (const { start, end, color } of segments) {
            const $segment = CartesianCoordinate.Segment.make();
            $segment.bind({ start, end });
            $segment.assignStyles({ "--line-color": color });
            $cc.appendChild($segment);
          }

          return $cc;
        },
      },
      {
        title: "Triangle (vectors)",
        render: () => {
          const $cc = CartesianCoordinate.make()
            .bind({
              showAxes: true,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });

          const a = { x: 0, y: 150 };
          const b = { x: -130, y: -75 };
          const c = { x: 130, y: -75 };

          const vectors: [{ x: number; y: number }, [number, number], string][] = [
            [a, [b.x - a.x, b.y - a.y], "var(--blue)"],
            [b, [c.x - b.x, c.y - b.y], "var(--red)"],
            [c, [a.x - c.x, a.y - c.y], "var(--green)"],
          ];

          for (const [point, vec, color] of vectors) {
            const length = Math.round(Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1]));
            const $segment = CartesianCoordinate.Segment.make();
            $segment.bind({
              ...CartesianCoordinate.Segment.Props.fromPV(point, vec),
              options: { endArrow: true, label: `${length}px` },
            });
            $segment.assignStyles({ "--line-color": color });
            $cc.appendChild($segment);
          }

          return $cc;
        },
      },
      {
        title: "Points",
        render: () => {
          const $cc = CartesianCoordinate.make()
            .bind({
              showAxes: true,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });

          const points = [
            { point: { x: 0, y: 0 }, color: "var(--blue)", label: "origin" },
            { point: { x: 100, y: 100 }, color: "var(--green)", label: "(100, 100)" },
            { point: { x: -100, y: 50 }, color: "var(--red)", label: "(-100, 50)" },
            { point: { x: 50, y: -75 }, color: "var(--orange)", label: "(50, -75)" },
          ];

          for (const { point, color, label } of points) {
            const $point = CartesianCoordinate.CCPoint.make();
            $point.bind({ point, label });
            $point.assignStyles({ "--point-color": color });
            $cc.appendChild($point);
          }

          return $cc;
        },
      },
      {
        title: "Points without labels",
        render: () => {
          const $cc = CartesianCoordinate.make()
            .bind({
              showAxes: true,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });

          for (let i = 0; i < 20; i++) {
            const angle = (i / 20) * Math.PI * 2;
            const radius = 100;
            const $point = CartesianCoordinate.CCPoint.make();
            $point.bind({
              point: {
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius,
              },
            });
            $point.assignStyles({
              "--point-color": `hsl(${(i / 20) * 360}, 70%, 50%)`,
            });
            $cc.appendChild($point);
          }

          return $cc;
        },
      },
      {
        title: "Vectors with points",
        render: () => {
          const $cc = CartesianCoordinate.make()
            .bind({
              showAxes: true,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });

          const vectors = [
            { start: { x: 0, y: 0 }, end: { x: 100, y: 80 }, color: "var(--blue)" },
            { start: { x: 0, y: 0 }, end: { x: -80, y: 60 }, color: "var(--red)" },
            { start: { x: 0, y: 0 }, end: { x: 50, y: -100 }, color: "var(--green)" },
          ];

          for (const { start, end, color } of vectors) {
            const $segment = CartesianCoordinate.Segment.make();
            $segment.bind({
              start,
              end,
              options: { endArrow: true },
            });
            $segment.assignStyles({ "--line-color": color });
            $cc.appendChild($segment);

            const $endPoint = CartesianCoordinate.CCPoint.make();
            $endPoint.bind({
              point: end,
              label: `(${end.x}, ${end.y})`,
            });
            $endPoint.assignStyles({ "--point-color": color });
            $cc.appendChild($endPoint);
          }

          const $origin = CartesianCoordinate.CCPoint.make();
          $origin.bind({
            point: { x: 0, y: 0 },
            label: "origin",
          });
          $origin.assignStyles({ "--point-color": "var(--text-pri)" });
          $cc.appendChild($origin);

          return $cc;
        },
      },
      {
        title: "Custom line width and point radius",
        render: () => {
          const $cc = CartesianCoordinate.make()
            .bind({
              showAxes: true,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
              "--cc-line-width": "3px",
              "--cc-point-radius": "8px",
            });

          const $segment = CartesianCoordinate.Segment.make();
          $segment.bind({
            start: { x: -100, y: -50 },
            end: { x: 100, y: 50 },
          });
          $segment.assignStyles({ "--line-color": "var(--blue)" });
          $cc.appendChild($segment);

          const $point1 = CartesianCoordinate.CCPoint.make();
          $point1.bind({ point: { x: -100, y: -50 }, label: "start" });
          $point1.assignStyles({ "--point-color": "var(--green)" });
          $cc.appendChild($point1);

          const $point2 = CartesianCoordinate.CCPoint.make();
          $point2.bind({ point: { x: 100, y: 50 }, label: "end" });
          $point2.assignStyles({ "--point-color": "var(--red)" });
          $cc.appendChild($point2);

          return $cc;
        },
      },
      {
        title: "Custom grid interval",
        render: () => {
          return CartesianCoordinate.make()
            .bind({
              showAxes: true,
              gridInterval: 100,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });
        },
      },
      {
        title: "No gridlines",
        render: () => {
          return CartesianCoordinate.make()
            .bind({
              showAxes: true,
              gridInterval: 0,
            })
            .assignStyles({
              width: "100%",
              maxHeight: "400px",
              maxWidth: "400px",
              aspectRatio: "1 / 1",
            });
        },
      },
    ];
  }
}
