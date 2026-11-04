import { Storybook } from "../../ui/storybook";
import { ProgressBar } from "./progress-bar";

export class ProgressBarStoryBook extends Storybook.Default {
  title(): string {
    return "Progress Bar";
  }

  tags(): string[] {
    return ["std-progress-bar"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Determinate, 40%", render: () => Storybook.fill(ProgressBar.makeWith({ value: 40, max: 100, label: "Uploading", showValue: true, tone: "default" }), "320px") },
      { title: "Indeterminate", render: () => Storybook.fill(ProgressBar.makeWith({ value: null, max: 100, label: "Syncing", showValue: false, tone: "default" }), "320px") },
      { title: "Success, complete", render: () => Storybook.fill(ProgressBar.makeWith({ value: 100, max: 100, label: "Done", showValue: true, tone: "success" }), "320px") },
      { title: "Danger, no label", render: () => Storybook.fill(ProgressBar.makeWith({ value: 9, max: 10, label: null, showValue: false, tone: "danger" }), "320px") },
    ];
  }
}
