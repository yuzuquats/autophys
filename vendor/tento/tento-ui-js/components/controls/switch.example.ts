import { Storybook } from "../../ui/storybook";
import { Switch } from "./switch";

export class SwitchStoryBook extends Storybook.Default {
  title(): string {
    return "Switch";
  }

  tags(): string[] {
    return ["std-switch"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Switch",
        render: () => {
          const $c = Switch.make();
          $c.bind({
            checked: false,
            onChange: (checked) => {
              console.log("Switch toggled:", checked);
            },
          });
          return $c;
        },
      },
    ];
  }
}
