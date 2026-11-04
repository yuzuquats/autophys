import { Storybook } from "@tento-ui/ui/storybook";
import { FractionLabel } from "./fraction-label";
import { Column } from "@tento-ui/component-builtin";

function $container(
  width: number,
  height: number,
  n: string,
  d: string,
): HTMLElement {
  const $c = Column.make();
  $c.style.width = width + "px";
  $c.style.height = height + "px";
  $c.style.background = "var(--bg-surface-light)";
  $c.style.borderRadius = "8px";
  $c.appendChild(FractionLabel.makeWith(n, d));
  return $c;
}

export class FractionLabelStoryBook extends Storybook.Default {
  title(): string {
    return "Fraction Label";
  }

  tags(): string[] {
    return ["std-fraction-label"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "32x32 (11/13)", render: () => $container(32, 32, "11", "13") },
      { title: "32x32 (1/3)", render: () => $container(32, 32, "1", "3") },
      { title: "32x32 (1/25)", render: () => $container(32, 32, "1", "25") },
      { title: "48x48 (12/31)", render: () => $container(48, 48, "12", "31") },
      { title: "24x24 (7/4)", render: () => $container(24, 24, "7", "4") },
      { title: "40x30 (10/28)", render: () => $container(40, 30, "10", "28") },
      { title: "32x80 (5/17)", render: () => $container(32, 80, "5", "17") },
      { title: "32x80 (17/5)", render: () => $container(32, 80, "17", "5") },
    ];
  }
}
