import { CheckmarkIcon, SearchIcon } from "../../icon-exports";
import { Storybook } from "../../ui/storybook";
import { SideNav } from "./side-nav";

function $nav(collapsed: boolean): SideNav {
  let active: Option<string> = "inbox";
  const $n = SideNav.make();
  const groups = (): SideNav.Group[] => [
    { label: null, items: [
      { id: "inbox", label: "Inbox", icon: SearchIcon, badge: "12", onSelect: () => { active = "inbox"; rebind(); } },
      { id: "done", label: "Done", icon: CheckmarkIcon, badge: null, onSelect: () => { active = "done"; rebind(); } },
    ] },
    { label: "Projects", items: [
      { id: "core", label: "Core library", icon: null, badge: null, onSelect: () => { active = "core"; rebind(); } },
      { id: "cal", label: "Calendar provider generalization", icon: null, badge: "3", onSelect: () => { active = "cal"; rebind(); } },
    ] },
  ];
  const rebind = () => $n.bind({ groups: groups(), activeId: active, collapsed, label: "Main" });
  rebind();
  return $n;
}

export class SideNavStoryBook extends Storybook.Default {
  title(): string {
    return "Side Nav";
  }

  tags(): string[] {
    return ["std-side-nav"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Two groups, badges, one current", render: () => $nav(false) },
      { title: "Collapsed — glyphs with tooltips", render: () => $nav(true) },
    ];
  }
}
