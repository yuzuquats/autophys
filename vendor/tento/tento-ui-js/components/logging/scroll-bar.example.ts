import { Storybook } from "@tento-ui/ui/storybook";
import { ScrollBar } from "./scroll-bar";

export class ScrollBarStoryBook extends Storybook.Default {
  title(): string {
    return "ScrollBar (Logging)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Empty",
        render: () => {
          const $bar = ScrollBar.make();
          $bar.style.height = "300px";
          $bar.style.width = "40px";
          $bar.bind([]);
          return $bar;
        },
      },
      {
        title: "Few Spans (< 1 hour)",
        render: () => {
          const $bar = ScrollBar.make();
          $bar.style.height = "300px";
          $bar.style.width = "40px";

          const now = Date.now();
          $bar.bind([
            { timestamp: new Date(now - 30 * 60 * 1000).toISOString() },
            { timestamp: new Date(now - 20 * 60 * 1000).toISOString() },
            { timestamp: new Date(now - 10 * 60 * 1000).toISOString() },
            { timestamp: new Date(now).toISOString() },
          ]);

          return $bar;
        },
      },
      {
        title: "Multi-hour Range",
        render: () => {
          const $bar = ScrollBar.make();
          $bar.style.height = "400px";
          $bar.style.width = "40px";

          const now = Date.now();
          const spans: { timestamp: string }[] = [];

          // Generate spans over 6 hours
          for (let i = 0; i < 50; i++) {
            const offset = Math.random() * 6 * 60 * 60 * 1000;
            spans.push({
              timestamp: new Date(now - offset).toISOString(),
            });
          }

          // Sort by timestamp
          spans.sort(
            (a, b) =>
              new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );

          $bar.bind(spans);

          // Set cursor to middle
          if (spans.length > 0) {
            $bar.setCursorOffset(spans[Math.floor(spans.length / 2)]);
          }

          return $bar;
        },
      },
      {
        title: "With Click Handler",
        render: () => {
          const $bar = ScrollBar.make();
          $bar.style.height = "350px";
          $bar.style.width = "40px";

          const now = Date.now();
          const spans: { timestamp: string }[] = [];

          // Generate spans over 4 hours
          for (let i = 0; i < 30; i++) {
            const offset = (i / 30) * 4 * 60 * 60 * 1000;
            spans.push({
              timestamp: new Date(now - 4 * 60 * 60 * 1000 + offset).toISOString(),
            });
          }

          $bar.bind(spans);

          $bar.onScrollToSpan = (span) => {
            console.log("Scroll to span:", span.timestamp);
          };

          return $bar;
        },
      },
      {
        title: "24-hour Range",
        render: () => {
          const $bar = ScrollBar.make();
          $bar.style.height = "500px";
          $bar.style.width = "40px";

          const now = Date.now();
          const spans: { timestamp: string }[] = [];

          // Generate spans over 24 hours
          for (let i = 0; i < 100; i++) {
            const offset = (i / 100) * 24 * 60 * 60 * 1000;
            spans.push({
              timestamp: new Date(now - 24 * 60 * 60 * 1000 + offset).toISOString(),
            });
          }

          $bar.bind(spans);

          return $bar;
        },
      },
    ];
  }
}
