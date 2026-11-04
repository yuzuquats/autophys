import { Column, Row } from "../../component-builtin";
import { Storybook } from "../../ui/storybook";
import { Typography } from "../../ui/typography";
import { Button } from "../button/button";
import { NumberInput } from "./number-input";

export class CoreNumberInputStoryBook extends Storybook.Default {
  title(): string {
    return "Number Input";
  }

  tags(): string[] {
    return ["std-number-input"];
  }

  examples(): Storybook.Example[] {
    return [
      {
        title: "Currency — type 1500, Enter or click away to commit",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Committed 1250");

          const $input = CoreNumberInputStoryBook.$field("120px");
          $input.bind(1250, { format: "currency", placeholder: "$0.00" });
          $input.enableEditing();
          // onChange parses every keystroke; onEditingFinished fires on Enter
          // or blur, after the text has been reformatted as currency.
          $input.setCallbacks({
            onChange: (n) => $status.bindText(`Typing ${n ?? "empty"}`),
            onEditingFinished: (n) =>
              $status.bindText(`Committed ${n ?? "empty"}`),
          });
          return {
            $content: CoreNumberInputStoryBook.$row("Monthly budget", $input),
            $status,
          };
        },
      },
      {
        title: "Plain number — shows two decimals, commits the full value",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Try 3.14159 or 12,000");

          const $input = CoreNumberInputStoryBook.$field("120px");
          $input.bind(12.5, { format: "number", placeholder: "0" });
          $input.enableEditing();
          // Separators, units and stray letters are stripped before parsing,
          // so "12,000 kg" commits as 12000. The display rounds to two
          // decimals; the committed number keeps everything that was typed.
          $input.setCallbacks({
            onEditingFinished: (n) =>
              $status.bindText(`Committed ${n ?? "empty"}`),
          });
          return {
            $content: CoreNumberInputStoryBook.$row("Weight (kg)", $input),
            $status,
          };
        },
      },
      {
        title: "Empty is not zero — placeholder until a value is entered",
        render: () => {
          const $status = Storybook.Card.StatusLine.make();
          $status.bindText("Limit: none (null)");

          const $input = CoreNumberInputStoryBook.$field("120px");
          $input.bind(null, { placeholder: "No limit" });
          $input.enableEditing();
          // Clearing the text commits null, which a caller can tell apart
          // from an explicit 0.
          $input.setCallbacks({
            onEditingFinished: (n) =>
              $status.bindText(
                n == null ? "Limit: none (null)" : `Limit: ${n} attendees`,
              ),
          });
          return {
            $content: CoreNumberInputStoryBook.$row("Max attendees", $input),
            $status,
          };
        },
      },
      {
        title: "Inline count, centered — as in “Repeat every 2 weeks”",
        render: () => {
          const $input = CoreNumberInputStoryBook.$field("48px");
          $input.bind(2, { placeholder: "1" });
          $input.enableEditing();
          $input.style.setProperty("--text-align", "center");

          const $sentence = Row.make();
          $sentence.assignStyles({ gap: "8px", alignItems: "center" });
          $sentence.append(
            Typography.p("Repeat every"),
            $input,
            Typography.p("weeks"),
          );
          return $sentence;
        },
      },
      {
        title: "Read-only — formatted, not editable",
        render: () => {
          const $rows = Column.make();
          $rows.assignStyles({ width: "min(320px, 100%)", gap: "8px" });

          const $rate = CoreNumberInputStoryBook.$field("120px");
          $rate.bind(0.423, { format: "percentage" });
          $rate.toggleEditable(false);

          const $total = CoreNumberInputStoryBook.$field("120px");
          $total.bind(18240.5, { format: "currency" });
          $total.toggleEditable(false);

          $rows.append(
            CoreNumberInputStoryBook.$row("Conversion rate", $rate),
            CoreNumberInputStoryBook.$row("Revenue this month", $total),
          );
          return $rows;
        },
      },
      {
        title: "Loading — shimmer until the value arrives",
        render: () => {
          const $input = CoreNumberInputStoryBook.$field("120px");
          $input.bind(null, { loading: true });

          // A loading bind returns before touching the text or callbacks, so
          // the value has to be bound again once it is known.
          const $controls = Storybook.Card.Controls.make();
          $controls.append(
            Button.makeWith("Finish loading", {
              type: "flat",
              onClick: () => {
                $input.bind(342, { format: "number" });
                $input.enableEditing();
              },
            }),
            Button.makeWith("Reload", {
              type: "flat",
              onClick: () => $input.bind(null, { loading: true }),
            }),
          );
          return {
            $content: CoreNumberInputStoryBook.$row("Open tickets", $input),
            $controls,
          };
        },
      },
    ];
  }

  /** The filled field look (`opaque`) that forms use, at a fixed width.
   * Without the attribute the input is borderless text for table cells. */
  private static $field(width: string): NumberInput {
    const $input = NumberInput.make();
    $input.toggleAttribute("opaque", true);
    $input.assignStyles({ width, paddingInline: "10px" });
    return $input;
  }

  /** Label on the left, number on the right — a settings row. */
  private static $row(label: string, $input: NumberInput): HTMLElement {
    const $row = Row.make();
    $row.assignStyles({
      width: "min(320px, 100%)",
      gap: "12px",
      alignItems: "center",
      justifyContent: "space-between",
    });
    const $label = Typography.p(label);
    $label.style.color = "var(--text-sec)";
    $row.append($label, $input);
    return $row;
  }
}
