import { Column, Div } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Switch } from "../controls/switch";
import { EditableText } from "../editable-text";
import { ListCellLayout } from "./list-cell-layout";

// A list cell is three slots — icon, content, accessory — plus padding by
// size and a handful of attribute-driven states. It paints no surface of its
// own outside hover and selection, so each example sets it on a plain panel.

function $panel(maxWidth = "360px"): HTMLElement {
  return Column.make().assignStyles({
    width: "100%",
    maxWidth,
    padding: "6px",
    gap: "1px",
    boxSizing: "border-box",
    background: "var(--bg)",
    border: "1px solid var(--divider)",
    borderRadius: "14px",
  });
}

function $dot(color: string): HTMLElement {
  return Div.make().assignStyles({
    width: "10px",
    height: "10px",
    flexShrink: "0",
    alignSelf: "center",
    borderRadius: "50%",
    background: color,
  });
}

function $count(n: number): HTMLElement {
  const $n = Typography.small(String(n));
  $n.style.color = "var(--text-ter)";
  $n.style.alignSelf = "center";
  return $n;
}

function $statusLine(text: string): Storybook.Card.StatusLine {
  const $status = Storybook.Card.StatusLine.make();
  $status.style.minHeight = "unset";
  $status.bindText(text);
  return $status;
}

export class CoreListCellLayoutStoryBook extends Storybook.Default {
  title(): string {
    return "List Cell Layout";
  }

  tags(): string[] {
    return ["std-list-cell-layout"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Calendar list — colour, name and account, visibility switch",
        render: () => {
          const calendars = [
            { name: "Work", account: "team@acme.com", color: "var(--blue)" },
            {
              name: "Personal",
              account: "me@example.com",
              color: "var(--green)",
            },
            {
              name: "Gym",
              account: "Shared by Priya",
              color: "var(--orange)",
            },
            {
              name: "US Holidays",
              account: "Subscribed",
              color: "var(--purple)",
            },
          ];
          const $status = $statusLine("Work selected");
          const $content = $panel();
          const $cells = calendars.map(({ name, account, color }) => {
            const $cell = ListCellLayout.makeText(name, {
              caption: account,
              $icon: $dot(color),
              $accessory: Switch.makeWith({
                checked: name !== "Gym",
                onChange: (on) => {
                  $status.bindText(`${name} ${on ? "shown" : "hidden"}`);
                },
              }).assignStyles({ alignSelf: "center" }),
            });
            $cell.addEventListener("click", (e) => {
              // The switch sits inside the cell; let it toggle on its own.
              if (e.target instanceof Switch) return;
              for (const $other of $cells) {
                $other.toggleAttribute("selected", $other === $cell);
              }
              $status.bindText(`${name} selected`);
            });
            return $cell;
          });
          $cells[0]!.toggleAttribute("selected", true);
          $content.append(...$cells);
          return { $content, $status };
        },
      },
      {
        // Size only changes padding and corner radius; the selected fill
        // makes the box visible.
        title: "Sizes — small, default, wide and large",
        render: () => {
          const sizes: [ListCellLayout.Size, string][] = [
            ["small", "4px 6px"],
            ["default", "6px 8px"],
            ["wide", "8px 8px"],
            ["large", "10px 20px"],
          ];
          const $content = $panel();
          $content.style.gap = "8px";
          for (const [size, padding] of sizes) {
            const $cell = ListCellLayout.makeText(size, {
              caption: `padding ${padding}`,
              size,
              $accessory: $count(3),
            });
            $cell.toggleAttribute("selected", true);
            $content.append($cell);
          }
          return $content;
        },
      },
      {
        // `context-menu-open` shares the selected fill so the row a menu
        // belongs to stays marked while the pointer is on the menu.
        // `ListCellLayout.toggleEditable` makes an EditableText content slot
        // typeable and sets `editing`, whose blue ring is drawn on the same
        // ::before as the row divider and so only shows where
        // --cell-border-top-display is not `none`.
        title: "States — resting, selected, context menu open, editing",
        render: () => {
          const $content = $panel();
          const $resting = ListCellLayout.makeText("Resting — hover me");
          const $selected = ListCellLayout.makeText("Selected");
          $selected.toggleAttribute("selected", true);
          const $menu = ListCellLayout.makeText("Context menu open");
          $menu.toggleAttribute("context-menu-open", true);
          const $editing = ListCellLayout.makeWith({
            $content: EditableText.makeWith("Editing — type here", () => {}),
          });
          ListCellLayout.toggleEditable($editing, true);
          $content.append($resting, $selected, $menu, $editing);
          return $content;
        },
      },
      {
        // What the reorder manager sets while a row is dragged: the dragged
        // row keeps a hover fill, and the row under the pointer draws a blue
        // drop line on the edge the row will land on.
        title: "Reorder feedback — dragged row and drop lines",
        render: () => {
          const $content = $panel();
          const titles = ["Plan the week", "Inbox zero", "Gym", "Read"];
          const $cells = titles.map((title) => {
            return ListCellLayout.makeText(title, {
              $accessory: $count(title.length),
            });
          });
          $cells[0]!.toggleAttribute("is-being-dragged", true);
          $cells[2]!.setAttribute("is-being-dragged-over", "bottom");
          $content.append(...$cells);
          return $content;
        },
      },
      {
        // makeText wraps anywhere by default, so a URL or long name never
        // pushes the accessory out; `titleStyle: "1-line"` ellipsizes instead.
        title: "Long titles — wrapping by default, or clamped to one line",
        render: () => {
          const title = "Quarterly planning notes — engineering and design";
          const $content = $panel("260px");
          $content.append(
            ListCellLayout.makeText(title, {
              caption: "Wraps",
              $accessory: $count(12),
            }),
            ListCellLayout.makeText(title, {
              caption: "titleStyle: 1-line",
              titleStyle: "1-line",
              $accessory: $count(12),
            }),
          );
          return $content;
        },
      },
      {
        // The cell reads its padding, fills and divider from inherited
        // custom properties, so a host restyles a whole list from one element.
        // (`small` ignores --list-cell-padding; its padding is fixed.)
        title: "Theming — row dividers and custom padding from CSS tokens",
        render: () => {
          const $content = $panel();
          $content.assignStyles({
            gap: "0px",
            "--list-cell-padding": "10px 12px",
          });
          const titles = ["Morning pages", "Standup", "Deep work"];
          for (const [index, title] of titles.entries()) {
            const $cell = ListCellLayout.makeText(title, {
              caption: ["7:00 am", "9:30 am", "10:00 am"][index],
            });
            // The divider sits on each cell's top edge; skip the first row.
            if (index > 0) {
              $cell.style.setProperty("--cell-border-top-display", "block");
            }
            $content.append($cell);
          }
          return $content;
        },
      },
    ];
  }
}
