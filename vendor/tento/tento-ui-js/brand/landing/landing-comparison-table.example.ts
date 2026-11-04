import { Storybook } from "../../ui/storybook";
import { LandingComparisonTable } from "./landing-comparison-table";

const rows: LandingComparisonTable.Row[] = [
  {
    feature: "Time as the core axis",
    description: "Every row shares the same day, week, month, or year columns.",
    ours: {
      tone: "positive",
      label: "Rows align to the same time axis",
    },
    theirs: {
      tone: "negative",
      label: "Time appears differently in each tool",
    },
  },
  {
    feature: "Timezone handling",
    description: "Events keep the timezone they were created in.",
    ours: {
      tone: "positive",
      label: "Timezone-stable events",
    },
    theirs: {
      tone: "partial",
      label: "Device timezone often wins",
    },
  },
  {
    feature: "Formula rows",
    description: "Computed rows can reference any other row by name.",
    ours: {
      tone: "positive",
      label: "Formulas run across time columns",
    },
    theirs: {
      tone: "partial",
      label: "Formulas live outside calendar context",
    },
  },
];

export class LandingComparisonTableStoryBook extends Storybook.Default {
  title(): string {
    return "Landing Comparison Table";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "SVG marks",
        render: () =>
          LandingComparisonTable.makeWith({
            headings: ["Capability", "Lona", "Other tools"],
            rows,
            markStyle: "svg",
          }),
      },
      {
        title: "Unicode marks",
        render: () =>
          LandingComparisonTable.makeWith({
            headings: ["Capability", "Lona", "Other tools"],
            rows,
            markStyle: "unicode",
          }),
      },
    ];
  }
}
