import { Storybook } from "../../ui/storybook";
import { Kbd } from "./kbd";

export class KbdStoryBook extends Storybook.Default {
  title(): string {
    return "Kbd";
  }

  tags(): string[] {
    return ["std-kbd"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Single key", render: () => Kbd.makeWith({ keys: ["s"], platform: null }) },
      { title: "Combination, mac", render: () => Kbd.makeWith({ keys: ["cmd", "shift", "p"], platform: "mac" }) },
      { title: "Combination, windows", render: () => Kbd.makeWith({ keys: ["cmd", "shift", "p"], platform: "win" }) },
      { title: "Named keys", render: () => Kbd.makeWith({ keys: ["esc"], platform: "mac" }) },
      { title: "Arrows", render: () => Kbd.makeWith({ keys: ["alt", "up"], platform: "mac" }) },
    ];
  }
}
