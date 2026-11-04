import { Column } from "../../component-builtin";
import {
  GearIcon,
  GridIcon,
  LonaIcons,
  MoonIcon,
  PlusIcon,
} from "../../ui/icons";
import { SpotlightIcons } from "../../ui/spotlight-icons";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Spotlight } from "./spotlight";
import { SpotlightRow } from "./spotlight-row";

// A row is one result in the command palette. Inside std-spotlight-layout the
// layout owns selection: it sets aria-selected on hover and arrow keys, slides
// a highlight behind the selected row, and runs the row's command on click or
// Enter. These examples stand rows up bare, so they do the same small amount
// of wiring themselves; the row itself paints only its "Enter ↵" hint.

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paletteRows(onRun: (name: string) => void): Spotlight.Row[] {
  // Commands are async; the palette awaits one before it dismisses.
  const run = (name: string) => async () => {
    await delay(400);
    onRun(name);
  };
  return [
    {
      priority: 1,
      name: "Dark Mode",
      icon: () => LonaIcons.make(MoonIcon, { sizePx: 20 }),
      searchTerms: ["dark", "theme"],
      command: run("Dark Mode"),
    },
    {
      priority: 1,
      name: "Settings",
      icon: () => LonaIcons.make(GearIcon, { sizePx: 20 }),
      subtitle: SpotlightRow.$subtitle("Account, calendars and integrations"),
      searchTerms: ["settings", "account"],
      command: run("Settings"),
    },
    {
      priority: 1,
      name: "Q4 roadmap",
      icon: () => LonaIcons.make(GridIcon, { sizePx: 20 }),
      subtitle: SpotlightRow.$subtitle("Your sheets"),
      searchTerms: ["sheet", "roadmap"],
      command: run("Q4 roadmap"),
    },
    {
      priority: 2,
      name: "Version Info",
      icon: () => SpotlightIcons.text("V"),
      searchTerms: ["version", "about"],
      command: run("Version Info"),
    },
  ];
}

// The surface std-spotlight-layout draws its results on.
function $palette(): HTMLElement {
  return Column.make().assignStyles({
    width: "100%",
    maxWidth: "420px",
    padding: "6px",
    gap: "2px",
    boxSizing: "border-box",
    background: "var(--bg)",
    border: "1px solid var(--divider)",
    borderRadius: "16px",
  });
}

function select($rows: SpotlightRow[], $selected: SpotlightRow): void {
  for (const $row of $rows) {
    const selected = $row === $selected;
    $row.ariaSelected = String(selected);
    // Stands in for the layout's sliding highlight.
    $row.style.background = selected ? "var(--bg-hover)" : "";
  }
}

function $statusLine(text: string): Storybook.Card.StatusLine {
  const $status = Storybook.Card.StatusLine.make();
  $status.style.minHeight = "unset";
  $status.bindText(text);
  return $status;
}

export class CoreSpotlightRowStoryBook extends Storybook.Default {
  title(): string {
    return "Spotlight Row";
  }

  tags(): string[] {
    return ["std-spotlight-row"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Palette results — hover to select, click to run",
        render: () => {
          const $status = $statusLine("Nothing run yet");
          const $content = $palette();
          const $rows = paletteRows((name) => {
            $status.bindText(`Ran “${name}”`);
          }).map((row) => SpotlightRow.makeWith(row));
          for (const $row of $rows) {
            $row.addEventListener("pointerenter", () => select($rows, $row));
            $row.addEventListener("click", async () => {
              $status.bindText("Running…");
              await $row.performCommand();
            });
          }
          $content.append(...$rows);
          select($rows, $rows[0]!);
          return { $content, $status };
        },
      },
      {
        title: "Selected and unselected — only selection shows the Enter hint",
        render: () => {
          const $content = $palette();
          const $rows = [true, false].map((selected) => {
            const $row = SpotlightRow.makeWith({
              priority: 1,
              name: "Create an event",
              icon: () => LonaIcons.make(PlusIcon, { sizePx: 20 }),
              searchTerms: ["create", "event"],
              command: async () => {},
            });
            $row.ariaSelected = String(selected);
            return $row;
          });
          $content.append(...$rows);
          return $content;
        },
      },
      {
        // The icon box is a fixed 20px column, filled or not, so titles in a
        // mixed list line up regardless of which rows carry an icon.
        title: "Rows without an icon keep the title column aligned",
        render: () => {
          const $content = $palette();
          const noop = async () => {};
          $content.append(
            SpotlightRow.make().bind(
              SpotlightRow.$title("Settings"),
              LonaIcons.make(GearIcon, { sizePx: 20 }),
              null,
              noop,
            ),
            SpotlightRow.make().bind(
              SpotlightRow.$title("Weekly review"),
              null,
              SpotlightRow.$subtitle("Your sheets"),
              noop,
            ),
            SpotlightRow.make().bind(
              SpotlightRow.$title("Inbox"),
              null,
              null,
              noop,
            ),
          );
          return $content;
        },
      },
      {
        // `subtitle` takes any element. The quick-add row uses it for a
        // live preview of the event the query will create.
        title: "A rich subtitle — the quick-add event preview",
        render: () => {
          const $preview = Column.make().assignStyles({
            marginTop: "8px",
            padding: "8px 12px",
            gap: "2px",
            background: "var(--bg-hover)",
            borderRadius: "8px",
          });
          const $name = Typography.p("Design sync");
          $name.style.color = "var(--text-pri)";
          const $when = Typography.small("Tomorrow, 8 – 9 am · work");
          $when.style.color = "var(--text-ter)";
          $preview.append($name, $when);

          const $row = SpotlightRow.make().bind(
            SpotlightRow.$title("Quick add: Create an Event"),
            LonaIcons.make(PlusIcon, { sizePx: 20 }),
            $preview,
            async () => {},
          );
          $row.ariaSelected = "true";
          const $content = $palette();
          $content.append($row);
          return $content;
        },
      },
      {
        title: "Long titles wrap beside the Enter hint",
        render: () => {
          const $row = SpotlightRow.makeWith({
            priority: 1,
            name: "[Debug] Open Ephemeral Journal (Read-Only) for the current sheet",
            icon: () => SpotlightIcons.text("G"),
            subtitle: SpotlightRow.$subtitle("Open read-only ephemeral sheet"),
            searchTerms: ["debug", "journal"],
            command: async () => {},
          });
          $row.ariaSelected = "true";
          const $content = $palette();
          $content.style.maxWidth = "300px";
          $content.append($row);
          return $content;
        },
      },
    ];
  }
}
