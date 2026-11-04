import { Storybook } from "../../ui/storybook";
import { Spinner } from "./spinner";

export class SpinnerStoryBook extends Storybook.Default {
  title(): string {
    return "Spinner";
  }

  tags(): string[] {
    return ["std-spinner"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Medium, announced", render: () => Spinner.makeWith({ size: "md", label: "Loading results" }) },
      { title: "Small, decorative", render: () => Spinner.makeWith({ size: "sm", label: null }) },
      { title: "Large", render: () => Spinner.makeWith({ size: "lg", label: "Loading" }) },
    ];
  }
}
