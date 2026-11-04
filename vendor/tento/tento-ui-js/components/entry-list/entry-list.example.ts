import { Storybook } from "@tento-ui/ui/storybook";
import { Toast } from "../toast/toast";
import { EntryList } from "./entry-list";
import { EntryDisplay, ListItem } from "./list-item";
import { DateTime, TimezoneRegion } from "@tento-chrono";

const exampleTime = DateTime.utc.now();
const timezone = TimezoneRegion.UTC;

const EXAMPLE_ITEMS: ListItem[] = [
  { title: "Morning Standup", accentColor: "var(--teal)", at: exampleTime, timezone },
  { title: "1:1 with Manager", accentColor: "var(--blue)", at: exampleTime, timezone },
  { title: "Lunch Break", accentColor: "var(--gray)", at: exampleTime, timezone },
  { title: "Design Review", accentColor: "var(--purple)", at: exampleTime, timezone },
  {
    title: "Engineering Sprint Planning",
    accentColor: "var(--green)",
    at: exampleTime,
    timezone,
  },
  { title: "Office Hours", accentColor: "var(--orange)", at: exampleTime, timezone },
];

export class EntryListStoryBook extends Storybook.Default {
  title(): string {
    return "Entry List";
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Entry List (Card)",
        render: () => {
          const $list = EntryList.makeWith({
            items: EXAMPLE_ITEMS,
            display: EntryDisplay.DEFAULT,
          }).assignStyles({
            maxWidth: "400px",
            width: "100%",
            "--entry-row-hover-color": "var(--bg-hover)",
          });
          $list.setAttribute("type", "card");
          return $list;
        },
      },
      {
        title: "Entry List",
        render: () => {
          return EntryList.makeWith({
            items: EXAMPLE_ITEMS,
            display: EntryDisplay.DEFAULT,
          }).assignStyles({
            width: "100%",
            padding: "8px",
            maxWidth: "400px",
            "--entry-row-hover-color": "var(--bg-hover)",
          });
        },
      },
      {
        title: "Empty List - No events",
        render: () => {
          return EntryList.makeWith({
            items: [],
            display: EntryDisplay.DEFAULT,
          }).assignStyles({
            maxWidth: "400px",
            width: "100%",
            padding: "8px",
          });
        },
      },
      {
        title: "Single Event",
        render: () => {
          return EntryList.makeWith({
            items: [
              {
                title: "Team Standup",
                accentColor: "var(--blue)",
                at: exampleTime,
                timezone,
              },
            ],
            display: { ...EntryDisplay.DEFAULT, timeScale: "week" },
          }).assignStyles({
            maxWidth: "400px",
            width: "100%",
            padding: "8px",
          });
        },
      },
      {
        title: "Pointer Callbacks Demo",
        render: () => {
          const items: ListItem[] = [
            {
              title: "Editable Event",
              isEditable: true,
              accentColor: "var(--green)",
              at: exampleTime,
              timezone,
            },
            {
              title: "Non-editable Event",
              isEditable: false,
              accentColor: "var(--red)",
              at: exampleTime,
              timezone,
            },
            {
              title: "Default (editable)",
              accentColor: "var(--blue)",
              at: exampleTime,
              timezone,
            },
          ];

          const $list = EntryList.make();
          $list.bind({ items, display: EntryDisplay.DEFAULT });
          $list.bindCallbacks({
            onPointerDown: (rowIndex) => {
              Toast.info(`Pointer down: ${items[rowIndex].title}`);
            },
            onPointerUp: (rowIndex) => {
              Toast.info(`Clicked: ${items[rowIndex].title}`);
            },
            onPointerMove: () => {},
            onContextMenu: (rowIndex) => {
              Toast.info(`Context menu: ${items[rowIndex].title}`);
            },
          });

          return $list.assignStyles({
            maxWidth: "400px",
            width: "100%",
            padding: "8px",
            "--entry-row-hover-color": "var(--bg-hover)",
          });
        },
      },
    ];
  }
}
