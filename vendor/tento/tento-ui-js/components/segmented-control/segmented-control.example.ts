import { Storybook } from "../../ui/storybook";
import { SegmentedControl } from "./segmented-control";

const OPTIONS = [
  { id: "day", label: "Day", icon: null },
  { id: "week", label: "Week", icon: null },
  { id: "month", label: "Month", icon: null },
];

// The story owns the state and rebinds on change — which is how every caller
// drives this control: `value` is a prop, never internal state.
function $control(initial: string): SegmentedControl {
  let value = initial;
  const $c = SegmentedControl.make();
  const rebind = () => $c.bind({ options: OPTIONS, value, onChange: (id) => { value = id; rebind(); }, label: "Time scale" });
  rebind();
  return $c;
}

export class SegmentedControlStoryBook extends Storybook.Default {
  title(): string {
    return "Segmented Control";
  }

  tags(): string[] {
    return ["std-segmented-control"];
  }

  examples(): Storybook.Example[] {
    return [
      { title: "Three options (arrows move the selection)", render: () => $control("week") },
    ];
  }
}
