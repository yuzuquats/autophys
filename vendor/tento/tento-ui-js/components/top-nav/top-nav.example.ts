import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { TopNav } from "./top-nav";

function $brand(): HTMLElement {
  const $b = Typography.p("Lona");
  $b.style.fontWeight = "600";
  return $b;
}

function $nav(): TopNav {
  let active: Option<string> = "sheets";
  const $n = TopNav.make();
  const items = (): TopNav.Item[] => ["Sheets", "Calendar", "Tasks"].map((label) => ({ id: label.toLowerCase(), label, onSelect: () => { active = label.toLowerCase(); rebind(); } }));
  const rebind = () => $n.bind({ $brand, items: items(), activeId: active, label: "Primary" });
  rebind();
  const $cta = Button.makeWith("Share", { type: "primary", onClick: () => {} });
  $cta.slot = "trailing";
  $n.appendChild($cta);
  return $n;
}

export class TopNavStoryBook extends Storybook.Default {
  title(): string {
    return "Top Nav";
  }

  tags(): string[] {
    return ["std-top-nav"];
  }

  examples(): Storybook.Example[] {
    return [{ title: "Brand, three items, a trailing action", render: () => $nav() }];
  }
}
