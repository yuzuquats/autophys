import { Storybook } from "../../ui/storybook";
import { CheckboxList } from "./checkbox-list";

const ITEMS: CheckboxList.Item[] = [
  { id: "email", title: "Email", subtitle: "Daily digest", disabled: false },
  { id: "push", title: "Push", subtitle: null, disabled: false },
  { id: "sms", title: "SMS", subtitle: "Carrier rates apply", disabled: false },
  { id: "fax", title: "Fax", subtitle: "Not available on this plan", disabled: true },
];

function $list(selectAll: Option<string>): CheckboxList {
  let values = ["email"];
  const $l = CheckboxList.make();
  const rebind = () => $l.bind({ items: ITEMS, values, onChange: (v) => { values = v; rebind(); }, selectAll, label: "Notifications" });
  rebind();
  return Storybook.fill($l, "280px");
}

export class CheckboxListStoryBook extends Storybook.Default {
  title(): string {
    return "Checkbox List";
  }

  tags(): string[] {
    return ["std-checkbox-list"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "With a select-all header (mixed state)", render: () => $list("All channels") },
      { title: "Plain", render: () => $list(null) },
    ];
  }
}
