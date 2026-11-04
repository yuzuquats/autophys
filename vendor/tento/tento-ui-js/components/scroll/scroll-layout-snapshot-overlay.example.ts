import { Storybook } from "../../ui/storybook";
import { ScrollLayoutSnapshotOverlay } from "./scroll-layout-snapshot-overlay";

export class ScrollLayoutSnapshotOverlayStoryBook extends Storybook.Default {
  title(): string {
    return "Scroll Layout Snapshot Overlay";
  }

  tags(): string[] {
    return ["std-scroll-layout-snapshot-overlay"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Single point",
        render: () => {
          return ScrollLayoutSnapshotOverlay.make()
            .bind({
              viewportInfo: {
                x: 0,
                y: 0,
                width: 400,
                height: 400,
                visibleHeight: 400,
                scrollHeight: 400,
                scrollTop: 0,
                padding: 0,
              },
              point: {
                x: 200,
                y: 150,
                spaceRemaining: {
                  top: 150,
                  right: 200,
                  bottom: 250,
                  left: 200,
                },
              },
            })
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              height: "400px",
            });
        },
      },
      {
        title: "Multiple points",
        render: () => {
          return ScrollLayoutSnapshotOverlay.make()
            .bind({
              viewportInfo: {
                x: 0,
                y: 0,
                width: 400,
                height: 400,
                visibleHeight: 400,
                scrollHeight: 800,
                scrollTop: 0,
                padding: 0,
              },
              point: {
                x: 300,
                y: 300,
                spaceRemaining: {
                  top: 300,
                  right: 100,
                  bottom: 100,
                  left: 300,
                },
              },
            })
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              height: "400px",
            });
        },
      },
      {
        title: "Constrained space (color coding)",
        render: () => {
          return ScrollLayoutSnapshotOverlay.make()
            .bind({
              viewportInfo: {
                x: 0,
                y: 0,
                width: 400,
                height: 300,
                visibleHeight: 300,
                scrollHeight: 300,
                scrollTop: 0,
                padding: 0,
              },
              point: {
                x: 50,
                y: 150,
                spaceRemaining: {
                  top: 150,
                  right: 350,
                  bottom: 150,
                  left: 50, // orange: > 50
                },
              },
            })
            .assignStyles({
              width: "100%",
              maxWidth: "400px",
              height: "300px",
            });
        },
      },
    ];
  }
}
