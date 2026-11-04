import { Storybook } from "../ui/storybook";
import { Button } from "./button/button";
import { Prompt } from "./prompt";
import { Toast } from "./toast/toast";

export class PromptStoryBook extends Storybook.Default {
  title(): string {
    return "Prompt";
  }

  tags(): string[] {
    return ["std-prompt", "std-prompt-layout"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Prompt",
        render: () => {
          return Prompt.make().bind({
            title: "Try for free!",
            description: "Sign up now and enjoy 30 days for unlimited access",
            onSubmit: () => {
              Toast.info("Started free trial");
            },
          });
        },
      },
    ];
  }
}

export class PromptAlertStoryBook extends Storybook.Default {
  title(): string {
    return "Alert Prompt";
  }

  tags(): string[] {
    return ["std-prompt-alert"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Alert Prompt",
        render: () => {
          return Prompt.Alert.make().bind({
            ...Prompt.Props.makeDelete("Are you sure you want to delete me?"),
            onSubmit: () => Toast.info("Deleted!"),
            onCancel: () => Toast.info("Canceled"),
          });
        },
      },
      {
        title: "Show Alert",
        render: () => {
          return Button.makeWithLight("Show alert", {
            type: "primary",
            onClick: async () => {
              const result = await Prompt.Alert.show(
                Prompt.Props.makeDelete("Are you sure you want to delete me?"),
              );
              Toast.info("Alert Dismissed", {
                description: `Completed: ${result.didComplete()}`,
              });
            },
          });
        },
      },
    ];
  }
}
