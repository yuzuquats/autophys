import { Storybook } from "../../ui/storybook";
import { Timestamp } from "./timestamp";

export class TimestampStoryBook extends Storybook.Default {
  title(): string {
    return "Timestamp";
  }

  tags(): string[] {
    return ["std-timestamp"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Relative, 5 minutes ago", render: () => Timestamp.makeWith({ epochMs: Date.now() - 5 * 60_000, mode: "relative", tickMs: null, format: null }) },
      { title: "Absolute", render: () => Timestamp.makeWith({ epochMs: Date.now() - 3 * 86_400_000, mode: "absolute", tickMs: null, format: null }) },
      { title: "Both", render: () => Timestamp.makeWith({ epochMs: Date.now() - 2 * 3_600_000, mode: "both", tickMs: null, format: null }) },
      { title: "Just now, ticking every second", render: () => Timestamp.makeWith({ epochMs: Date.now(), mode: "relative", tickMs: 1000, format: null }) },
    ];
  }
}
