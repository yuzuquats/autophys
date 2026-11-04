import "./app-bar";
import "../breadcrumb/breadcrumb";

import { Storybook } from "../../ui/storybook";
import { Breadcrumb } from "../breadcrumb/breadcrumb";
import { AppBar } from "./app-bar";

function $makeBar(title: string, meta: Option<string>, width: number): AppBar {
  const $bar = AppBar.makeWith({ title, meta });
  $bar.style.width = `${width}px`;
  $bar.style.maxWidth = "100%";
  return $bar;
}

function $control(label: string): HTMLButtonElement {
  const $button = document.createElement("button");
  $button.type = "button";
  $button.textContent = label;
  return $button;
}

export class AppBarStoryBook extends Storybook.Default {
  title(): string {
    return "App Bar";
  }

  tags(): string[] {
    return ["std-app-bar"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Plain title and status", render: () => $makeBar("Library", "3 items", 640) },
      {
        title: "Slotted title replaces the fallback label",
        render: () => {
          const $barElement = $makeBar("Fallback title", null, 640);
          const $title = document.createElement("span");
          $title.slot = "title";
          $title.textContent = "Selected item";
          $barElement.append($title);
          return $barElement;
        },
      },
      {
        title: "Breadcrumb title",
        render: () => {
          const $barElement = $makeBar("", null, 640);
          const $breadcrumb = Breadcrumb.makeWith("small");
          $breadcrumb.slot = "title";
          $breadcrumb.append(Breadcrumb.Item("Library"), Breadcrumb.Item("Selected item"));
          $barElement.append($breadcrumb);
          return $barElement;
        },
      },
      {
        title: "Leading and trailing controls",
        render: () => {
          const $barElement = $makeBar("Library", "3 items", 640);
          const $start = $control("Menu");
          $start.slot = "start";
          $barElement.append($start, $control("Filter"), $control("Add"));
          return $barElement;
        },
      },
      {
        title: "Narrow bar with a long title and status",
        render: () => {
          const $barElement = $makeBar("A long collection title", "All changes saved", 280);
          $barElement.append($control("Add"));
          return $barElement;
        },
      },
    ];
  }
}
