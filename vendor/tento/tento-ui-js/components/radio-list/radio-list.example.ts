import { Storybook } from "../../ui/storybook";
import { RadioList } from "./radio-list";

const ITEMS: RadioList.Item[] = [
  { id: "this", title: "This event", subtitle: null, disabled: false },
  { id: "following", title: "This and following events", subtitle: "Changes every later occurrence", disabled: false },
  { id: "all", title: "All events", subtitle: null, disabled: false },
  { id: "locked", title: "Locked series", subtitle: "Managed by the organiser", disabled: true },
];

function $list(): RadioList {
  let value: Option<string> = "this";
  const $l = RadioList.make();
  const rebind = () => $l.bind({ items: ITEMS, value, onChange: (id) => { value = id; rebind(); }, label: "Edit scope" });
  rebind();
  return Storybook.fill($l, "320px");
}

export class RadioListStoryBook extends Storybook.Default {
  title(): string {
    return "Radio List";
  }

  tags(): string[] {
    return ["std-radio-list"];
  }

  examples(): Storybook.Example[] {
    return [{ title: "Four items, one disabled (arrows move the selection)", render: () => $list() }];
  }
}
