import { Storybook } from "@tento-ui/ui/storybook";
import { AllCompleteState } from "./all-complete-state";

export class AllCompleteStateStoryBook extends Storybook.Default {
  title(): string {
    return "All Complete State";
  }

  examples(): Storybook.Example[] {
    return [
      {
        render: () => {
          return AllCompleteState.make();
        },
      },
    ];
  }
}
