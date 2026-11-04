import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Table } from "./table";

// A column heading can carry a second line (`Column.Spec.sublabel`), and the
// header band is MEASURED from the tallest heading rather than declared. The
// two cards differ only in whether any column has a sublabel: without one the
// band resolves to the 36px floor every table already drew; with one it grows
// to fit, and the chip behind the header grows with it.

interface Build extends Identifiable<string> {
  id: string;
  spec: string;
  dev: string;
  rc: string;
  prod: string;
}

const ROWS: Build[] = [
  { id: "1", spec: "calendar-event-create", dev: "pass", rc: "pass", prod: "—" },
  { id: "2", spec: "checkout-declined-card", dev: "pass", rc: "fail", prod: "—" },
  { id: "3", spec: "settings-avatar-upload", dev: "blocked", rc: "—", prod: "—" },
];

type Env = "dev" | "rc" | "prod";

/** What each environment is serving: the caption and the full sentence. */
const HEADS: Record<Env, { sublabel: string; tooltip: string }> = {
  dev: {
    sublabel: "unreachable",
    tooltip: "dev — https://dev.example.com\nno answer: connection refused",
  },
  rc: {
    sublabel: "1.0.86 · Sep 14 19:57",
    tooltip: "rc — https://rc.example.com\nserver 1.0.86\nfrontend 1.0.53, built Sep 14 19:57",
  },
  prod: {
    sublabel: "1.0.84 · Sep 7 19:26",
    tooltip: "prod — https://example.com\nserver 1.0.84\nfrontend 1.0.51, built Sep 7 19:26",
  },
};

function $text(): HTMLElement {
  return Typography.p("");
}

function spec(withHeads: boolean): Table.Spec<Build> {
  const env = (id: Env): Table.Column.Spec<Build> => ({
    id,
    label: id,
    width: 150,
    sublabel: withHeads ? HEADS[id].sublabel : null,
    tooltip: withHeads ? HEADS[id].tooltip : null,
    make: $text,
    bind: ($t: HTMLElement, row: Build) => {
      $t.textContent = row[id];
    },
  });
  return {
    columns: [
      {
        id: "spec",
        label: "Spec",
        primary: true,
        make: $text,
        bind: ($t: HTMLElement, row: Build) => {
          $t.textContent = row.spec;
        },
      },
      env("dev"),
      env("rc"),
      env("prod"),
    ],
  };
}

function $table(withHeads: boolean): HTMLElement {
  return Table.makeTyped<Build>()
    .bind(Table.ViewModel.makeDefault(spec(withHeads)))
    .bindItems([...ROWS])
    .assignStyles({ width: "100%", maxWidth: "680px" });
}

export class TableHeaderStoryBook extends Storybook.Default {
  title(): string {
    return "Table headings (std-table-header)";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "One line: the band stays at the 36px floor",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "No column has a sublabel, so the tallest heading is one line and the " +
        // "measured band resolves to the floor. This is the header every table " +
        // "drew before headings could have a second line.",
        render: () => $table(false),
      },
      {
        title: "Two lines: the band grows to fit",
        // `description` was removed from Storybook.Example by ruling;
        // the copy is kept here for whoever restores a rendered field.
        // description:
        // "Each environment column names the build it is serving on a second " +
        // "line; hover a heading for the whole sentence. Nobody declares a " +
        // "height: the header reads the tallest heading's content plus its " +
        // "block padding, and the chip behind the header follows.",
        render: () => $table(true),
      },
    ];
  }
}
